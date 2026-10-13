// POST /create-order — оформление заявки БЕЗ оплаты.
// Zod-валидация → ограничение частоты → SQL create_order_request (пересчёт цен и наличия от имени пользователя)
// → уведомление менеджеров (без ПДн) → ссылка на диалог в боте с непрозрачным токеном.
import { serve, json, readJson, HttpError, fromDbError } from '../_shared/http.ts';
import { createOrderSchema, type CreateOrderResponse } from '../_shared/domain/checkout.ts';
import { requireUser, rateLimit, getSetting } from '../_shared/supabase.ts';
import { notifyManagersNewOrder } from '../_shared/telegram.ts';
import { env } from '../_shared/env.ts';

serve('create-order', async (req) => {
  const auth = await requireUser(req);
  await rateLimit(`order:user:${auth.userId}`, 10, 60);

  const parsed = createOrderSchema.safeParse(await readJson(req, 32 * 1024));
  if (!parsed.success) {
    throw new HttpError(422, 'VALIDATION', parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })));
  }

  const { data, error } = await auth.db.rpc('create_order_request', { p: parsed.data });
  if (error) throw fromDbError(error);
  const result = data as CreateOrderResponse;

  if (result.ok && !result.duplicate && result.order_id && result.number) {
    // Заявка уже сохранена — сбой уведомления не должен ломать оформление
    await notifyManagersNewOrder({
      orderId: result.order_id, number: result.number,
      itemsCount: result.items_count ?? 0, totalKopecks: result.total_kopecks ?? 0,
    }).catch(() => false);
  }

  if (result.ok && result.telegram_token) {
    const bot = env('TELEGRAM_BOT_USERNAME') ?? (await getSetting<string>('telegram_bot_username'));
    result.bot_link = bot ? `https://t.me/${bot}?start=order_${result.telegram_token}` : null;
    result.manager_link = (await getSetting<string>('manager_contact_url')) ?? null;
    delete result.telegram_token; // токен нужен только в ссылке
  }
  return json(req, result, result.ok ? 200 : 409);
});
