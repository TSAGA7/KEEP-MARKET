// Webhook Telegram-бота KEEP MARKET.
// Проверка: заголовок X-Telegram-Bot-Api-Secret-Token должен совпасть с TELEGRAM_WEBHOOK_SECRET.
// Возможности: /start (в т.ч. deep link по заявке), /shop, /orders, /help; диалог покупатель ↔ менеджеры
// через закрытый чат менеджеров (reply на пересланное сообщение уходит покупателю).
import { serve, json, HttpError } from '../_shared/http.ts';
import { adminClient, getSetting } from '../_shared/supabase.ts';
import { sendMessage, tgCall, appUrl, miniAppLink, notifyManagers, statusLabel } from '../_shared/telegram.ts';
import { escapeTelegramHtml as esc, timingSafeEqual } from '../_shared/domain/telegram.ts';
import { requireEnv } from '../_shared/env.ts';

type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string; language_code?: string };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  text?: string;
  caption?: string;
  photo?: unknown[];
  reply_to_message?: { message_id: number };
};
type Update = { update_id: number; message?: TgMessage };

function shopButton(path = '') {
  const url = appUrl(path);
  return url ? [[{ text: 'Открыть магазин', web_app: { url } }]] : undefined;
}

async function supportText(): Promise<string> {
  const hours = (await getSetting<string>('support_hours')) ?? '';
  return `Напишите сюда ваш вопрос по заказу или возврату — сообщение получит менеджер KEEP MARKET.${hours ? `\nЧасы работы: ${esc(hours)}` : ''}`;
}

async function upsertProfileFromBot(u: TgUser) {
  // Данные пришли от Telegram (webhook проверен секретом) — им можно доверять
  await adminClient().from('profiles').upsert({
    telegram_id: u.id,
    username: u.username?.slice(0, 64) ?? null,
    first_name: u.first_name?.slice(0, 128) ?? null,
    last_name: u.last_name?.slice(0, 128) ?? null,
    language_code: u.language_code?.slice(0, 8) ?? null,
  }, { onConflict: 'telegram_id' });
}

async function handlePrivate(m: TgMessage) {
  const u = m.from as TgUser;
  const db = adminClient();
  const text = (m.text ?? '').trim();

  if (text.startsWith('/start')) {
    await upsertProfileFromBot(u);
    const payload = text.split(/\s+/)[1] ?? '';
    const token = payload.startsWith('order_') ? payload.slice(6) : null;
    const { data } = await db.rpc('bot_link_order', { p_telegram_id: u.id, p_chat_id: m.chat.id, p_token: token });
    const r = data as { result: string; order_id?: string; number?: string; status?: string };
    if (r?.result === 'order_linked' && r.order_id) {
      await sendMessage(m.chat.id,
        `Заявка <b>${esc(r.number ?? '')}</b> получена.\nСтатус: ${esc(statusLabel(r.status ?? 'new'))}.\n\nМенеджер проверит наличие у поставщика и свяжется с вами здесь, чтобы согласовать доставку и оплату. Оплата на этом этапе не производится.\n\nМожете написать вопрос прямо в этот чат.`,
        appUrl(`orders/${r.order_id}`) ? [[{ text: 'Открыть заявку', web_app: { url: appUrl(`orders/${r.order_id}`) as string } }]] : undefined);
      await notifyManagers(`Покупатель открыл диалог в боте по заявке <b>${esc(r.number ?? '')}</b>. Ответьте на его сообщения reply-ответом в этом чате.`, r.order_id);
      return;
    }
    await sendMessage(m.chat.id, 'Добро пожаловать в KEEP MARKET — одежда, обувь, сумки и аксессуары независимых брендов.\n\nОткройте магазин кнопкой ниже. Здесь же будут приходить уведомления о ваших заказах.', shopButton());
    return;
  }

  if (text === '/shop') {
    await sendMessage(m.chat.id, 'Каталог KEEP MARKET:', shopButton());
    return;
  }

  if (text === '/help' || text === '/support') {
    const manager = await getSetting<string>('manager_contact_url');
    await sendMessage(m.chat.id, await supportText(), manager && /^https:\/\/t\.me\//.test(manager) ? [[{ text: 'Написать менеджеру', url: manager }]] : undefined);
    return;
  }

  const { data: profile } = await db.from('profiles').select('id').eq('telegram_id', u.id).maybeSingle();

  if (text === '/orders') {
    if (!profile) { await sendMessage(m.chat.id, 'У вас пока нет заказов.', shopButton()); return; }
    const { data: orders } = await db.from('orders').select('id, number, status').eq('customer_id', profile.id)
      .order('created_at', { ascending: false }).limit(5);
    if (!orders?.length) { await sendMessage(m.chat.id, 'У вас пока нет заказов.', shopButton()); return; }
    const lines = orders.map((o: { number: string; status: string }) => `• <b>${esc(o.number)}</b> — ${esc(statusLabel(o.status))}`);
    await sendMessage(m.chat.id, `Ваши последние заказы:\n${lines.join('\n')}`, shopButton('orders'));
    return;
  }

  if (text.startsWith('/')) {
    await sendMessage(m.chat.id, 'Команды: /shop — магазин, /orders — мои заказы, /help — поддержка.');
    return;
  }

  // Сообщение покупателя → чат менеджеров (копия + привязка для ответа)
  const managerChat = await getSetting<number | string>('manager_chat_id');
  if (!managerChat) {
    await sendMessage(m.chat.id, 'Сейчас мы не можем принять сообщение. Попробуйте позже.');
    return;
  }
  await db.from('profiles').update({ bot_chat_id: m.chat.id }).eq('telegram_id', u.id);
  let orderRef = '';
  let orderId: string | null = null;
  if (profile) {
    const { data: last } = await db.from('orders').select('id, number').eq('customer_id', profile.id)
      .not('status', 'in', '(delivered,cancelled)').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (last) { orderRef = ` по заявке <b>${esc(last.number)}</b>`; orderId = last.id; }
  }
  const header = await sendMessage(managerChat, `Сообщение покупателя${orderRef}. Ответьте reply на копию ниже.`,
    orderId && miniAppLink(`a_${orderId}`, `admin/orders/${orderId}`) ? [[{ text: 'Открыть заявку', url: miniAppLink(`a_${orderId}`, `admin/orders/${orderId}`) as string }]] : undefined);
  const copy = await tgCall<{ message_id: number }>('copyMessage', { chat_id: managerChat, from_chat_id: m.chat.id, message_id: m.message_id });
  if (copy.ok && copy.result) {
    await db.from('bot_relay_messages').insert({
      manager_chat_id: Number(managerChat), manager_message_id: copy.result.message_id, customer_chat_id: m.chat.id,
      customer_id: profile?.id ?? null, order_id: orderId,
    });
    await sendMessage(m.chat.id, 'Сообщение передано менеджеру. Ответ придёт в этот чат.');
  } else if (!header.ok) {
    await sendMessage(m.chat.id, 'Не удалось передать сообщение. Попробуйте позже.');
  }
}

async function handleManagerChat(m: TgMessage) {
  const managerChat = await getSetting<number | string>('manager_chat_id');
  if (!managerChat || String(m.chat.id) !== String(managerChat)) return; // бот игнорирует чужие группы
  if (!m.reply_to_message || !m.from || m.from.is_bot) return;
  // Отвечать покупателям могут только сотрудники магазина
  const db = adminClient();
  const { data: staffProfile } = await db.from('profiles').select('id, is_blocked').eq('telegram_id', m.from.id).maybeSingle();
  const { data: staffRoles } = staffProfile
    ? await db.from('user_roles').select('role').eq('user_id', staffProfile.id)
    : { data: [] as { role: string }[] };
  const staff = staffProfile && !staffProfile.is_blocked && (staffRoles ?? []).length > 0 ? staffProfile : null;
  if (!staff) {
    await sendMessage(m.chat.id, 'Ответ не отправлен: ваш Telegram-аккаунт не назначен сотрудником в админ-панели.');
    return;
  }
  const { data: link } = await db.from('bot_relay_messages').select('customer_chat_id, order_id')
    .eq('manager_chat_id', m.chat.id).eq('manager_message_id', m.reply_to_message.message_id).maybeSingle();
  if (!link) return;
  const res = await tgCall('copyMessage', { chat_id: link.customer_chat_id, from_chat_id: m.chat.id, message_id: m.message_id });
  await sendMessage(m.chat.id, res.ok ? 'Ответ отправлен покупателю.' : 'Не удалось отправить ответ (покупатель мог остановить бота).');
  if (res.ok && link.order_id) {
    await db.from('audit_logs').insert({ actor_id: staff.id, action: 'bot_reply_sent', entity: 'orders', entity_id: link.order_id, details: {} });
  }
}

serve('telegram-bot', async (req) => {
  const secret = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeEqual(secret, requireEnv('TELEGRAM_WEBHOOK_SECRET'))) throw new HttpError(401, 'UNAUTHORIZED');
  const update = (await req.json().catch(() => null)) as Update | null;
  const m = update?.message;
  if (!m?.from || m.from.is_bot) return json(req, { ok: true });
  try {
    if (m.chat.type === 'private') await handlePrivate(m);
    else if (m.chat.type === 'group' || m.chat.type === 'supergroup') await handleManagerChat(m);
  } catch (e) {
    console.error('[telegram-bot] handler error', (e as Error).message?.slice(0, 120));
  }
  // Telegram повторяет доставку при не-2xx — отвечаем 200, ошибки логируем
  return json(req, { ok: true });
});
