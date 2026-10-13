// POST /payment-refund { payment_id, amount_kopecks, reason } — возврат (только owner/admin; проверка в БД).
// manual (офлайн-оплата): сотрудник подтверждает, что деньги возвращены вне системы — фиксируется в журнале.
import { z } from 'zod';
import { serve, json, readJson, HttpError, fromDbError } from '../_shared/http.ts';
import { requireUser, rateLimit, adminClient } from '../_shared/supabase.ts';
import { getProvider } from '../_shared/payments.ts';

const bodySchema = z.object({
  payment_id: z.string().uuid(),
  amount_kopecks: z.number().int().positive().max(1_000_000_000),
  reason: z.string().trim().min(3).max(500),
  manual_confirmed: z.boolean().optional(),
});

serve('payment-refund', async (req) => {
  const auth = await requireUser(req);
  await rateLimit(`refund:user:${auth.userId}`, 10, 60);
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(422, 'VALIDATION');
  const b = parsed.data;

  // Права и сумма проверяются в БД от имени сотрудника
  const { data, error } = await auth.db.rpc('staff_refund_prepare', { p_payment_id: b.payment_id, p_amount_kopecks: b.amount_kopecks, p_reason: b.reason });
  if (error) throw fromDbError(error);
  const rf = data as { refund_id: string; idempotency_key: string; provider: string; provider_payment_id: string; amount_kopecks: number };
  const db = adminClient();

  if (rf.provider === 'manual') {
    if (!b.manual_confirmed) {
      await db.rpc('refund_apply_result', { p_refund_id: rf.refund_id, p_status: 'failed', p_provider_refund_id: null });
      throw new HttpError(422, 'MANUAL_REFUND_CONFIRMATION_REQUIRED');
    }
    const { data: r } = await db.rpc('refund_apply_result', { p_refund_id: rf.refund_id, p_status: 'succeeded', p_provider_refund_id: `manual_${rf.refund_id}` });
    return json(req, { refund_id: rf.refund_id, status: 'succeeded', result: r });
  }

  const provider = getProvider();
  if (provider.id !== rf.provider) throw new HttpError(409, 'PROVIDER_MISMATCH');
  try {
    const res = await provider.createRefund({ refundId: rf.refund_id, idempotencyKey: rf.idempotency_key,
      providerPaymentId: rf.provider_payment_id, amountKopecks: rf.amount_kopecks, reason: b.reason });
    if (res.status === 'pending') {
      await db.from('refunds').update({ provider_refund_id: res.providerRefundId }).eq('id', rf.refund_id);
      return json(req, { refund_id: rf.refund_id, status: 'pending' });
    }
    await db.rpc('refund_apply_result', { p_refund_id: rf.refund_id, p_status: res.status, p_provider_refund_id: res.providerRefundId });
    return json(req, { refund_id: rf.refund_id, status: res.status });
  } catch {
    await db.rpc('refund_apply_result', { p_refund_id: rf.refund_id, p_status: 'failed', p_provider_refund_id: null });
    throw new HttpError(502, 'REFUND_PROVIDER_ERROR');
  }
});
