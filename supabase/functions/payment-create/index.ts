// POST /payment-create { order_id } — онлайн-оплата ПОДТВЕРЖДЁННОГО заказа покупателя.
// Сумма берётся из БД; клиент сумму не передаёт. Переход на страницу оплаты ≠ оплата.
import { z } from 'zod';
import { serve, json, readJson, HttpError, fromDbError } from '../_shared/http.ts';
import { requireUser, rateLimit, adminClient } from '../_shared/supabase.ts';
import { getProvider } from '../_shared/payments.ts';
import { appUrl } from '../_shared/telegram.ts';

const bodySchema = z.object({ order_id: z.string().uuid() });

serve('payment-create', async (req) => {
  const auth = await requireUser(req);
  await rateLimit(`pay:user:${auth.userId}`, 10, 60);
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(422, 'VALIDATION');

  const provider = getProvider();
  const db = adminClient();
  const { data: prep, error } = await db.rpc('customer_payment_prepare', {
    p_customer_id: auth.userId, p_order_id: parsed.data.order_id, p_provider: provider.id, p_allow_test: provider.isTest,
  });
  if (error) throw fromDbError(error);
  const p = prep as { payment_id: string; idempotency_key: string; amount_kopecks: number; confirmation_url: string | null;
    order_number: string; reused: boolean };

  if (p.reused && p.confirmation_url) {
    return json(req, { payment_id: p.payment_id, confirmation_url: p.confirmation_url, amount_kopecks: p.amount_kopecks, test: provider.isTest });
  }

  // Данные для чека (54-ФЗ), если включена отправка чеков через провайдера
  const [{ data: items }, { data: contact }, { data: order }] = await Promise.all([
    db.from('order_items').select('title_snapshot, quantity, unit_price_kopecks, availability').eq('order_id', parsed.data.order_id),
    db.from('order_contacts').select('email, phone').eq('order_id', parsed.data.order_id).maybeSingle(),
    db.from('orders').select('delivery_kopecks, discount_kopecks').eq('id', parsed.data.order_id).maybeSingle(),
  ]);
  const receiptItems = (items ?? [])
    .filter((i: { availability: string }) => i.availability !== 'unavailable')
    .map((i: { title_snapshot: string; quantity: number; unit_price_kopecks: number }) => ({
      description: i.title_snapshot, quantity: i.quantity, amountKopecks: Number(i.unit_price_kopecks),
    }));

  try {
    const res = await provider.createPayment({
      paymentId: p.payment_id,
      idempotencyKey: p.idempotency_key,
      amountKopecks: p.amount_kopecks,
      orderNumber: p.order_number,
      description: `Заказ ${p.order_number} в KEEP MARKET`,
      returnUrl: appUrl(`orders/${parsed.data.order_id}?payment=return`) ?? 'https://t.me',
      customerEmail: contact?.email ?? null,
      customerPhone: contact?.phone ?? null,
      // Чек со скидкой формирует провайдер только при отсутствии скидки; иначе — настраивается отдельно (см. docs/payments.md)
      receiptItems: Number(order?.discount_kopecks ?? 0) === 0 ? receiptItems : undefined,
      deliveryKopecks: order?.delivery_kopecks ?? null,
    });
    await db.rpc('payment_attach_provider', {
      p_payment_id: p.payment_id, p_provider_payment_id: res.providerPaymentId, p_confirmation_url: res.confirmationUrl,
    });
    return json(req, { payment_id: p.payment_id, confirmation_url: res.confirmationUrl, amount_kopecks: p.amount_kopecks, test: provider.isTest });
  } catch (e) {
    await db.rpc('payment_mark_failed_to_create', { p_payment_id: p.payment_id, p_reason: (e as Error).message?.slice(0, 100) ?? 'error' });
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'PAYMENT_PROVIDER_ERROR');
  }
});
