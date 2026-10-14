// POST /order-action — действия с заявкой.
//  Сотрудник: { order_id, action: <StaffAction>, payload }  → staff_order_action (роль проверяется в БД)
//  Покупатель: { order_id, action: 'customer_confirm' | 'customer_cancel', payload: { reason? } }
// После успешного действия — уведомление покупателю в бот (если он подключил бота) и менеджерам.
import { z } from 'zod';
import { serve, json, readJson, HttpError, fromDbError } from '../_shared/http.ts';
import { STAFF_ACTIONS } from '../_shared/domain/orders.ts';
import { requireUser, rateLimit } from '../_shared/supabase.ts';
import { notifyCustomer, notifyManagers } from '../_shared/telegram.ts';
import { escapeTelegramHtml as esc } from '../_shared/domain/telegram.ts';

const itemSchema = z.object({
  item_id: z.string().uuid(),
  availability: z.enum(['confirmed', 'unavailable', 'replacement_offered', 'waiting']),
  note: z.string().max(500).optional(),
  new_unit_price_kopecks: z.number().int().min(0).max(1_000_000_000).optional(),
  price_change_reason: z.string().max(500).optional(),
});

const payloadSchema = z.object({
  reason: z.string().max(1000).optional(),
  items: z.array(itemSchema).max(50).optional(),
  delivery_kopecks: z.number().int().min(0).max(100_000_000).nullable().optional(),
  eta_text: z.string().max(300).optional(),
  delivery_note: z.string().max(500).optional(),
  manager_notes: z.string().max(2000).optional(),
  customer_agreed_in_chat: z.boolean().optional(),
  payment_method: z.enum(['online', 'manual_transfer', 'cash_on_delivery', 'other']).optional(),
  carrier: z.enum(['cdek', 'ozon', 'russian_post', 'yandex', 'keep_courier', 'other']).optional(),
  tracking_number: z.string().trim().max(60).optional(),
  cost_kopecks: z.number().int().min(0).max(100_000_000).nullable().optional(),
  notes: z.string().max(500).optional(),
  shipment_id: z.string().uuid().optional(),
  target_status: z.enum(['checking_availability', 'awaiting_payment', 'awaiting_shipment', 'shipped', 'delivered']).optional(),
}).strict();

const bodySchema = z.object({
  order_id: z.string().uuid(),
  action: z.enum([...(STAFF_ACTIONS as [string, ...string[]]), 'customer_confirm', 'customer_cancel']),
  payload: payloadSchema.default({}),
});

serve('order-action', async (req) => {
  const auth = await requireUser(req);
  await rateLimit(`order-action:user:${auth.userId}`, 60, 60);
  const parsed = bodySchema.safeParse(await readJson(req, 32 * 1024));
  if (!parsed.success) {
    // Понятная ошибка: какое поле заполнено неверно
    const field = String(parsed.error.issues[0]?.path.at(-1) ?? '');
    throw new HttpError(422, `VALIDATION: ${field}`.slice(0, 80));
  }
  const { order_id, action, payload } = parsed.data;

  if (action === 'customer_confirm' || action === 'customer_cancel') {
    const rpc = action === 'customer_confirm'
      ? auth.db.rpc('customer_confirm_order', { p_order_id: order_id })
      : auth.db.rpc('customer_cancel_order', { p_order_id: order_id, p_reason: payload.reason ?? '' });
    const { data, error } = await rpc;
    if (error) throw fromDbError(error);
    const { data: o } = await auth.db.from('orders').select('number').eq('id', order_id).maybeSingle();
    const num = o?.number ? esc(o.number) : '';
    await notifyManagers(action === 'customer_confirm'
      ? `Покупатель подтвердил условия по заявке <b>${num}</b>.`
      : `Покупатель отменил заявку <b>${num}</b>.`, order_id).catch(() => false);
    return json(req, data);
  }

  const { data, error } = await auth.db.rpc('staff_order_action', { p_order_id: order_id, p_action: action, p_payload: payload });
  if (error) throw fromDbError(error);
  const result = data as { notify: string | null };
  let notified = false;
  if (result.notify) notified = await notifyCustomer(order_id, result.notify).catch(() => false);
  return json(req, { ...result, customer_notified: notified });
});
