// Корзина и заявка: схемы валидации (общие для клиента и сервера) и расчёт сумм.
import { z } from 'zod';
import { DELIVERY_METHODS, addressSchemaFor, type DeliveryMethod } from './delivery.ts';

export interface CartLine {
  variantId: string;
  productId: string;
  slug: string;
  title: string;
  size: string | null;
  color: string | null;
  imageRef: string | null;
  unitPriceKopecks: number;
  quantity: number;
  minQty: number;
  maxQty: number;
  stockQty: number;
  stockState: 'in_stock' | 'needs_confirmation' | 'out_of_stock';
}

export interface CartTotals {
  itemsCount: number;
  itemsTotalKopecks: number;
  /** null — стоимость доставки ещё неизвестна (согласует менеджер) */
  deliveryKopecks: number | null;
  totalKopecks: number;
  hasUnavailable: boolean;
}

export function cartTotals(lines: CartLine[], deliveryKopecks: number | null = null): CartTotals {
  let itemsCount = 0;
  let items = 0;
  let hasUnavailable = false;
  for (const l of lines) {
    if (l.stockState === 'out_of_stock') { hasUnavailable = true; continue; }
    if (!Number.isSafeInteger(l.unitPriceKopecks) || l.unitPriceKopecks < 0) throw new Error('Invalid price');
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) throw new Error('Invalid quantity');
    itemsCount += l.quantity;
    items += l.unitPriceKopecks * l.quantity;
  }
  return { itemsCount, itemsTotalKopecks: items, deliveryKopecks, totalKopecks: items + (deliveryKopecks ?? 0), hasUnavailable };
}

export function clampQty(qty: number, line: Pick<CartLine, 'minQty' | 'maxQty' | 'stockQty'>): number {
  const max = Math.max(line.minQty, Math.min(line.maxQty, line.stockQty > 0 ? line.stockQty : line.maxQty));
  if (!Number.isFinite(qty)) return line.minQty;
  return Math.min(Math.max(Math.round(qty), line.minQty), max);
}

const uuid = z.string().uuid();

export const contactSchema = z.object({
  recipient_name: z.string().trim().min(2, 'Укажите ФИО получателя').max(160),
  phone: z.string().trim().refine((v) => {
    const d = v.replace(/\D/g, '');
    return d.length >= 10 && d.length <= 15;
  }, 'Укажите телефон, например +7 900 000-00-00'),
  email: z.string().trim().email('Некорректный e-mail').max(160).optional().or(z.literal('')),
});

export const orderItemInputSchema = z.object({
  variant_id: uuid,
  quantity: z.number().int().min(1).max(100),
  expected_unit_price_kopecks: z.number().int().min(0).max(1_000_000_000),
});

export const createOrderSchema = z.object({
  idempotency_key: z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/),
  items: z.array(orderItemInputSchema).min(1, 'Корзина пуста').max(30),
  delivery_method: z.enum(DELIVERY_METHODS),
  contact: contactSchema,
  address: z.record(z.unknown()),
  comment: z.string().trim().max(1000).optional().or(z.literal('')),
  promo_code: z.string().trim().max(32).optional().or(z.literal('')),
  consent_pd: z.literal(true, { errorMap: () => ({ message: 'Необходимо согласие на обработку персональных данных' }) }),
}).superRefine((v, ctx) => {
  const r = addressSchemaFor(v.delivery_method as DeliveryMethod).safeParse(v.address);
  if (!r.success) {
    for (const issue of r.error.issues) ctx.addIssue({ ...issue, path: ['address', ...issue.path] });
  }
  if ('passport' in v.address || 'passport_number' in v.address) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: 'Паспортные данные не требуются' });
  }
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export type OrderProblemCode = 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'QTY_INVALID' | 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED' | 'PROMO_INVALID';
export interface OrderProblem {
  code: OrderProblemCode;
  variant_id?: string;
  expected?: number;
  actual?: number;
  available?: number;
  min_qty?: number;
  max_qty?: number;
}

export interface CreateOrderResponse {
  ok: boolean;
  duplicate?: boolean;
  order_id?: string;
  number?: string;
  telegram_token?: string;
  total_kopecks?: number;
  items_count?: number;
  problems?: OrderProblem[];
  lines?: Array<{ variant_id: string; unit_price_kopecks: number; quantity: number; stock_state: CartLine['stockState']; stock_qty: number }>;
  bot_link?: string | null;
  manager_link?: string | null;
}

export const PROBLEM_TEXT: Record<OrderProblemCode, string> = {
  UNAVAILABLE: 'Товар больше недоступен',
  OUT_OF_STOCK: 'Нет в наличии',
  QTY_INVALID: 'Недопустимое количество',
  INSUFFICIENT_STOCK: 'Доступно меньше, чем в корзине',
  PRICE_CHANGED: 'Цена изменилась',
  PROMO_INVALID: 'Промокод недействителен или не подходит к заказу',
};

/** Применяет пересчитанные сервером данные к корзине, чтобы покупатель подтвердил изменения. */
export function applyServerProblems(lines: CartLine[], resp: CreateOrderResponse): { lines: CartLine[]; changes: string[] } {
  const changes: string[] = [];
  const problems = resp.problems ?? [];
  const next: CartLine[] = [];
  for (const line of lines) {
    const ps = problems.filter((p) => p.variant_id === line.variantId);
    let l = { ...line };
    let drop = false;
    for (const p of ps) {
      switch (p.code) {
        case 'UNAVAILABLE':
          drop = true;
          changes.push(`«${line.title}» больше недоступен и удалён из корзины`);
          break;
        case 'OUT_OF_STOCK':
          l = { ...l, stockState: 'out_of_stock', stockQty: 0 };
          changes.push(`«${line.title}» закончился`);
          break;
        case 'INSUFFICIENT_STOCK':
          l = { ...l, quantity: Math.max(1, p.available ?? 1), stockQty: p.available ?? 0 };
          changes.push(`«${line.title}»: доступно только ${p.available} шт.`);
          break;
        case 'PRICE_CHANGED':
          if (typeof p.actual === 'number') {
            l = { ...l, unitPriceKopecks: p.actual };
            changes.push(`«${line.title}»: цена изменилась`);
          }
          break;
        case 'QTY_INVALID':
          l = { ...l, quantity: Math.min(Math.max(l.quantity, p.min_qty ?? 1), p.max_qty ?? l.maxQty), minQty: p.min_qty ?? l.minQty, maxQty: p.max_qty ?? l.maxQty };
          changes.push(`«${line.title}»: количество скорректировано`);
          break;
        default:
          break;
      }
    }
    if (!drop) next.push(l);
  }
  if (problems.some((p) => p.code === 'PROMO_INVALID')) changes.push(PROBLEM_TEXT.PROMO_INVALID);
  return { lines: next, changes };
}
