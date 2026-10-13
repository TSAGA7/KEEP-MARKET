// POST /payment-webhook — уведомления платёжного провайдера.
// Подлинность проверяется адаптером (подпись / повторный запрос к API провайдера / IP).
// Повторные уведомления безопасны: UNIQUE(provider, event_key) в payment_events.
import { serve, json, HttpError } from '../_shared/http.ts';
import { WebhookVerificationError } from '../_shared/domain/payments.ts';
import { getProvider, processVerifiedEvent } from '../_shared/payments.ts';
import { rateLimit } from '../_shared/supabase.ts';

serve('payment-webhook', async (req) => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  await rateLimit(`webhook:ip:${ip ?? 'unknown'}`, 300, 60);
  const rawBody = await req.text();
  if (rawBody.length > 64 * 1024) throw new HttpError(413, 'PAYLOAD_TOO_LARGE');

  const provider = getProvider();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  let ev;
  try {
    ev = await provider.verifyWebhook({ headers, rawBody, remoteIp: ip });
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      console.warn('[payment-webhook] rejected:', e.message);
      throw new HttpError(401, 'WEBHOOK_REJECTED');
    }
    throw e;
  }
  if (!ev) return json(req, { ok: true, ignored: true });
  const r = await processVerifiedEvent(provider, ev);
  return json(req, { ok: true, result: r.result });
});
