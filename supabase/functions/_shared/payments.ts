// Общая обработка проверенных платёжных событий (webhook и dev-симуляция используют одну логику).
import { createPaymentProvider, type PaymentProvider, type VerifiedPaymentEvent, type VerifiedRefundEvent } from './domain/payments.ts';
import { adminClient } from './supabase.ts';
import { allPaymentEnv } from './env.ts';
import { HttpError } from './http.ts';
import { notifyCustomer, notifyManagers } from './telegram.ts';
import { escapeTelegramHtml as esc } from './domain/telegram.ts';

export function getProvider(): PaymentProvider {
  let p: PaymentProvider | null;
  try {
    p = createPaymentProvider(allPaymentEnv());
  } catch (e) {
    console.error('[payments] provider config error:', (e as Error).message);
    throw new HttpError(503, 'PAYMENT_PROVIDER_MISCONFIGURED');
  }
  if (!p) throw new HttpError(503, 'ONLINE_PAYMENT_DISABLED');
  return p;
}

export async function processVerifiedEvent(provider: PaymentProvider, ev: VerifiedPaymentEvent | VerifiedRefundEvent) {
  const db = adminClient();
  if (ev.kind === 'refund') {
    const { data: rf } = await db.from('refunds').select('id').eq('provider_refund_id', ev.providerRefundId).maybeSingle();
    if (!rf || ev.status === 'pending') return { result: rf ? 'pending' : 'refund_not_found' };
    const { data, error } = await db.rpc('refund_apply_result', { p_refund_id: rf.id, p_status: ev.status, p_provider_refund_id: ev.providerRefundId });
    if (error) throw new HttpError(500, 'REFUND_APPLY_FAILED');
    return data as { result: string };
  }

  const { data, error } = await db.rpc('payment_apply_event', {
    p_provider: provider.id,
    p_event_key: ev.eventKey,
    p_provider_payment_id: ev.providerPaymentId,
    p_event_type: ev.eventType,
    p_status: ev.status,
    p_amount_kopecks: ev.amountKopecks,
    p_payload: ev.summary,
  });
  if (error) throw new HttpError(500, 'PAYMENT_APPLY_FAILED');
  const r = data as { result: string; order_id?: string };

  if (r.order_id && (r.result === 'succeeded' || r.result === 'late_success' || r.result === 'amount_mismatch')) {
    const { data: o } = await db.from('orders').select('number').eq('id', r.order_id).maybeSingle();
    const num = esc(o?.number ?? '');
    if (r.result === 'succeeded') {
      await notifyCustomer(r.order_id, 'paid').catch(() => false);
      await notifyManagers(`Получена оплата по заказу <b>${num}</b>.`, r.order_id).catch(() => false);
    } else {
      await notifyManagers(`Проблема с оплатой заказа <b>${num}</b> (${r.result}). Проверьте вручную.`, r.order_id).catch(() => false);
    }
  }
  return r;
}
