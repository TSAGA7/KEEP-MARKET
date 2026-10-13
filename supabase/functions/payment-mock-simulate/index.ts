// POST /payment-mock-simulate { provider_payment_id, outcome } — ТОЛЬКО development.
// Эмулирует страницу оплаты: формирует подписанное уведомление mock-провайдера и прогоняет его
// через ту же проверку и обработку, что и настоящий webhook. В production функция отключена.
import { z } from 'zod';
import { serve, json, readJson, HttpError } from '../_shared/http.ts';
import { MockPaymentProvider } from '../_shared/domain/payments.ts';
import { requireUser, adminClient } from '../_shared/supabase.ts';
import { getProvider, processVerifiedEvent } from '../_shared/payments.ts';
import { IS_PRODUCTION } from '../_shared/env.ts';

const bodySchema = z.object({
  provider_payment_id: z.string().regex(/^mock_[0-9a-f-]{36}$/),
  outcome: z.enum(['succeeded', 'failed', 'cancelled']),
});

serve('payment-mock-simulate', async (req) => {
  if (IS_PRODUCTION) throw new HttpError(404, 'NOT_FOUND');
  const provider = getProvider();
  if (!(provider instanceof MockPaymentProvider)) throw new HttpError(404, 'NOT_FOUND');
  const auth = await requireUser(req);
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(422, 'VALIDATION');

  // Платёж должен принадлежать текущему покупателю
  const { data: pay } = await adminClient().from('payments')
    .select('id, amount_kopecks, orders!inner(customer_id)')
    .eq('provider', 'mock').eq('provider_payment_id', parsed.data.provider_payment_id).maybeSingle();
  const owner = (pay as unknown as { orders?: { customer_id: string } } | null)?.orders?.customer_id;
  if (!pay || owner !== auth.userId) throw new HttpError(404, 'PAYMENT_NOT_FOUND');

  const body = JSON.stringify({
    event_id: `sim_${crypto.randomUUID()}`,
    type: `payment.${parsed.data.outcome}`,
    payment_id: parsed.data.provider_payment_id,
    amount_kopecks: Number(pay.amount_kopecks),
  });
  const signature = await provider.sign(body);
  const ev = await provider.verifyWebhook({ headers: { 'x-mock-signature': signature }, rawBody: body });
  if (!ev) throw new HttpError(500, 'INTERNAL_ERROR');
  const r = await processVerifiedEvent(provider, ev);
  return json(req, { ok: true, result: r.result, test: true });
});
