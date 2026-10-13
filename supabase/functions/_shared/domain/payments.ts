// Абстракция платёжного провайдера. Корзина и заказы не зависят от конкретного провайдера.
// Правила: платёж создаётся только для подтверждённого заказа; «оплачено» — только по проверенному
// уведомлению; возврат пользователя со страницы оплаты НЕ является доказательством оплаты;
// данные банковских карт не проходят через наш сервер и не хранятся.
import { timingSafeEqual } from './telegram.ts';

export type ProviderPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

export interface ReceiptItem {
  description: string;
  quantity: number;
  amountKopecks: number; // цена за единицу
}

export interface CreatePaymentParams {
  paymentId: string;
  idempotencyKey: string;
  amountKopecks: number;
  orderNumber: string;
  description: string;
  returnUrl: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  receiptItems?: ReceiptItem[];
  deliveryKopecks?: number | null;
}

export interface CreatePaymentResult {
  providerPaymentId: string;
  confirmationUrl: string;
  status: ProviderPaymentStatus;
}

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: string;
  remoteIp?: string | null;
}

export interface VerifiedPaymentEvent {
  kind: 'payment';
  eventKey: string;
  providerPaymentId: string;
  eventType: string;
  status: ProviderPaymentStatus;
  amountKopecks: number;
  /** Безопасная для журнала выжимка (без персональных и карточных данных) */
  summary: Record<string, unknown>;
}

export interface VerifiedRefundEvent {
  kind: 'refund';
  eventKey: string;
  providerRefundId: string;
  providerPaymentId: string;
  status: 'succeeded' | 'failed' | 'pending';
}

export interface RefundParams {
  refundId: string;
  idempotencyKey: string;
  providerPaymentId: string;
  amountKopecks: number;
  reason: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'succeeded' | 'pending' | 'failed';
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export interface PaymentProvider {
  readonly id: string;
  /** true — тестовый провайдер (только development) */
  readonly isTest: boolean;
  createPayment(p: CreatePaymentParams): Promise<CreatePaymentResult>;
  /** Проверяет подлинность уведомления и возвращает подтверждённое событие. Бросает WebhookVerificationError. */
  verifyWebhook(req: WebhookRequest): Promise<VerifiedPaymentEvent | VerifiedRefundEvent | null>;
  createRefund(p: RefundParams): Promise<RefundResult>;
}

export function kopecksToDecimalString(k: number): string {
  if (!Number.isSafeInteger(k) || k < 0) throw new Error('Invalid amount');
  return `${Math.floor(k / 100)}.${String(k % 100).padStart(2, '0')}`;
}

export function decimalStringToKopecks(s: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Invalid amount string');
  const [r, k = ''] = s.split('.');
  return Number(r) * 100 + Number(k.padEnd(2, '0'));
}

// ---------------------------------------------------------------------------
// Mock-провайдер — ТОЛЬКО для разработки. Подпись уведомлений: HMAC-SHA256(secret, body) в hex.
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MockWebhookBody {
  event_id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'payment.cancelled' | 'payment.pending' | 'refund.succeeded';
  payment_id: string; // provider payment id
  refund_id?: string;
  amount_kopecks: number;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly id = 'mock';
  readonly isTest = true;
  constructor(private readonly secret: string, private readonly checkoutBaseUrl: string) {
    if (!secret || secret.length < 16) throw new Error('MOCK_PAYMENT_SECRET must be at least 16 chars');
  }

  async createPayment(p: CreatePaymentParams): Promise<CreatePaymentResult> {
    const providerPaymentId = `mock_${p.paymentId}`;
    const url = new URL(this.checkoutBaseUrl);
    url.searchParams.set('payment', providerPaymentId);
    url.searchParams.set('amount', String(p.amountKopecks));
    url.searchParams.set('order', p.orderNumber);
    return { providerPaymentId, confirmationUrl: url.toString(), status: 'pending' };
  }

  async sign(body: string): Promise<string> {
    return hmacHex(this.secret, body);
  }

  async verifyWebhook(req: WebhookRequest): Promise<VerifiedPaymentEvent | VerifiedRefundEvent | null> {
    const sig = req.headers['x-mock-signature'] ?? '';
    const expected = await hmacHex(this.secret, req.rawBody);
    if (!timingSafeEqual(sig, expected)) throw new WebhookVerificationError('bad signature');
    let b: MockWebhookBody;
    try {
      b = JSON.parse(req.rawBody) as MockWebhookBody;
    } catch {
      throw new WebhookVerificationError('bad json');
    }
    if (!b.event_id || !b.payment_id || !Number.isSafeInteger(b.amount_kopecks)) throw new WebhookVerificationError('bad payload');
    if (b.type === 'refund.succeeded') {
      return { kind: 'refund', eventKey: b.event_id, providerRefundId: b.refund_id ?? '', providerPaymentId: b.payment_id, status: 'succeeded' };
    }
    const status = b.type.split('.')[1] as ProviderPaymentStatus;
    if (!['pending', 'succeeded', 'failed', 'cancelled'].includes(status)) throw new WebhookVerificationError('bad type');
    return {
      kind: 'payment', eventKey: b.event_id, providerPaymentId: b.payment_id, eventType: b.type, status,
      amountKopecks: b.amount_kopecks, summary: { type: b.type, amount_kopecks: b.amount_kopecks },
    };
  }

  async createRefund(p: RefundParams): Promise<RefundResult> {
    return { providerRefundId: `mock_refund_${p.refundId}`, status: 'succeeded' };
  }
}

// ---------------------------------------------------------------------------
// ЮKassa (адаптер готов к подключению; проверить на тестовом магазине ЮKassa перед запуском).
// Подлинность уведомления подтверждается повторным запросом статуса платежа в API ЮKassa
// (тело уведомления не считается доверенным) и, опционально, проверкой IP-адреса отправителя.
// ---------------------------------------------------------------------------
export interface YooKassaConfig {
  shopId: string;
  secretKey: string;
  apiBase?: string;
  sendReceipt?: boolean;
  /** Код ставки НДС для чека (1 — без НДС). Уточнить у бухгалтера. */
  vatCode?: number;
  /** Разрешённые IP/подсети отправителей уведомлений. Пусто — проверка IP отключена. */
  allowedIps?: string[];
  fetchImpl?: typeof fetch;
}

type YkPayment = {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  amount: { value: string; currency: string };
  paid: boolean;
  confirmation?: { confirmation_url?: string };
  metadata?: Record<string, string>;
};

export function ipInAllowList(ip: string | null | undefined, list: string[]): boolean {
  if (!list.length) return true;
  if (!ip) return false;
  const v4 = (s: string) => s.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  for (const entry of list) {
    if (entry.includes(':') || ip.includes(':')) {
      // IPv6: сравнение по префиксу из записи (упрощённо: только /32 и точные адреса)
      const [net, bits] = entry.split('/');
      if (!bits && ip === net) return true;
      if (bits === '32' && net && ip.toLowerCase().startsWith(net.toLowerCase().replace(/::$/, ':'))) return true;
      continue;
    }
    const [net, bitsRaw] = entry.split('/');
    const bits = bitsRaw ? Number(bitsRaw) : 32;
    if (!net || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((v4(ip) & mask) === (v4(net) & mask)) return true;
  }
  return false;
}

export class YooKassaProvider implements PaymentProvider {
  readonly id = 'yookassa';
  readonly isTest = false;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: YooKassaConfig) {
    if (!cfg.shopId || !cfg.secretKey) throw new Error('YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY are required');
    this.base = cfg.apiBase ?? 'https://api.yookassa.ru/v3';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Basic ${btoa(`${this.cfg.shopId}:${this.cfg.secretKey}`)}`,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) h['Idempotence-Key'] = idempotencyKey;
    return h;
  }

  private mapStatus(s: YkPayment['status']): ProviderPaymentStatus {
    if (s === 'succeeded') return 'succeeded';
    if (s === 'canceled') return 'cancelled';
    return 'pending';
  }

  async createPayment(p: CreatePaymentParams): Promise<CreatePaymentResult> {
    const body: Record<string, unknown> = {
      amount: { value: kopecksToDecimalString(p.amountKopecks), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: p.returnUrl },
      description: p.description.slice(0, 128),
      metadata: { payment_id: p.paymentId, order_number: p.orderNumber },
    };
    if (this.cfg.sendReceipt) {
      if (!p.customerEmail && !p.customerPhone) throw new Error('RECEIPT_CONTACT_REQUIRED');
      const items = (p.receiptItems ?? []).map((i) => ({
        description: i.description.slice(0, 128),
        quantity: String(i.quantity),
        amount: { value: kopecksToDecimalString(i.amountKopecks), currency: 'RUB' },
        vat_code: this.cfg.vatCode ?? 1,
        payment_mode: 'full_payment',
        payment_subject: 'commodity',
      }));
      if (p.deliveryKopecks && p.deliveryKopecks > 0) {
        items.push({ description: 'Доставка', quantity: '1', amount: { value: kopecksToDecimalString(p.deliveryKopecks), currency: 'RUB' },
          vat_code: this.cfg.vatCode ?? 1, payment_mode: 'full_payment', payment_subject: 'service' });
      }
      body.receipt = { customer: p.customerEmail ? { email: p.customerEmail } : { phone: (p.customerPhone ?? '').replace(/\D/g, '') }, items };
    }
    const res = await this.fetchImpl(`${this.base}/payments`, { method: 'POST', headers: this.headers(p.idempotencyKey), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`YOOKASSA_CREATE_FAILED_${res.status}`);
    const data = (await res.json()) as YkPayment;
    if (!data.confirmation?.confirmation_url) throw new Error('YOOKASSA_NO_CONFIRMATION_URL');
    return { providerPaymentId: data.id, confirmationUrl: data.confirmation.confirmation_url, status: this.mapStatus(data.status) };
  }

  async getPayment(id: string): Promise<YkPayment> {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new WebhookVerificationError('bad payment id');
    const res = await this.fetchImpl(`${this.base}/payments/${id}`, { headers: this.headers() });
    if (!res.ok) throw new WebhookVerificationError(`payment lookup failed ${res.status}`);
    return (await res.json()) as YkPayment;
  }

  async verifyWebhook(req: WebhookRequest): Promise<VerifiedPaymentEvent | VerifiedRefundEvent | null> {
    if (!ipInAllowList(req.remoteIp ?? null, this.cfg.allowedIps ?? [])) throw new WebhookVerificationError('ip not allowed');
    let n: { type?: string; event?: string; object?: { id?: string; payment_id?: string; status?: string } };
    try {
      n = JSON.parse(req.rawBody);
    } catch {
      throw new WebhookVerificationError('bad json');
    }
    if (n.type !== 'notification' || !n.event || !n.object?.id) throw new WebhookVerificationError('bad notification');
    if (n.event.startsWith('refund.')) {
      // Статус возврата также перепроверяется через API
      const res = await this.fetchImpl(`${this.base}/refunds/${n.object.id}`, { headers: this.headers() });
      if (!res.ok) throw new WebhookVerificationError('refund lookup failed');
      const r = (await res.json()) as { id: string; payment_id: string; status: 'pending' | 'succeeded' | 'canceled' };
      return { kind: 'refund', eventKey: `${n.event}:${r.id}:${r.status}`, providerRefundId: r.id, providerPaymentId: r.payment_id,
        status: r.status === 'canceled' ? 'failed' : r.status };
    }
    if (!n.event.startsWith('payment.')) return null;
    // Доверяем только ответу API, а не телу уведомления
    const pay = await this.getPayment(n.object.id);
    if (pay.amount.currency !== 'RUB') throw new WebhookVerificationError('currency');
    const status = this.mapStatus(pay.status);
    return {
      kind: 'payment', eventKey: `${n.event}:${pay.id}:${pay.status}`, providerPaymentId: pay.id, eventType: n.event, status,
      amountKopecks: decimalStringToKopecks(pay.amount.value), summary: { event: n.event, status: pay.status, paid: pay.paid },
    };
  }

  async createRefund(p: RefundParams): Promise<RefundResult> {
    const res = await this.fetchImpl(`${this.base}/refunds`, {
      method: 'POST', headers: this.headers(p.idempotencyKey),
      body: JSON.stringify({ payment_id: p.providerPaymentId, amount: { value: kopecksToDecimalString(p.amountKopecks), currency: 'RUB' },
        description: p.reason.slice(0, 250) }),
    });
    if (!res.ok) throw new Error(`YOOKASSA_REFUND_FAILED_${res.status}`);
    const r = (await res.json()) as { id: string; status: 'pending' | 'succeeded' | 'canceled' };
    return { providerRefundId: r.id, status: r.status === 'canceled' ? 'failed' : r.status };
  }
}

export interface PaymentEnv {
  APP_ENV?: string;
  PAYMENT_PROVIDER?: string;
  MOCK_PAYMENT_SECRET?: string;
  MOCK_CHECKOUT_URL?: string;
  YOOKASSA_SHOP_ID?: string;
  YOOKASSA_SECRET_KEY?: string;
  YOOKASSA_SEND_RECEIPT?: string;
  YOOKASSA_VAT_CODE?: string;
  YOOKASSA_ALLOWED_IPS?: string;
}

/** Фабрика провайдера. Mock в production запрещён. Возвращает null, если оплата не настроена. */
export function createPaymentProvider(env: PaymentEnv): PaymentProvider | null {
  const name = (env.PAYMENT_PROVIDER ?? '').trim();
  if (!name || name === 'none') return null;
  if (name === 'mock') {
    if ((env.APP_ENV ?? 'production') === 'production') throw new Error('MOCK_PROVIDER_FORBIDDEN_IN_PRODUCTION');
    return new MockPaymentProvider(env.MOCK_PAYMENT_SECRET ?? '', env.MOCK_CHECKOUT_URL ?? 'http://localhost:5173/dev/mock-payment');
  }
  if (name === 'yookassa') {
    return new YooKassaProvider({
      shopId: env.YOOKASSA_SHOP_ID ?? '', secretKey: env.YOOKASSA_SECRET_KEY ?? '',
      sendReceipt: env.YOOKASSA_SEND_RECEIPT === 'true',
      vatCode: env.YOOKASSA_VAT_CODE ? Number(env.YOOKASSA_VAT_CODE) : undefined,
      allowedIps: (env.YOOKASSA_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  throw new Error(`Unknown PAYMENT_PROVIDER: ${name}`);
}
