// Webhook Telegram-бота KEEP MARKET.
// Проверка: заголовок X-Telegram-Bot-Api-Secret-Token должен совпасть с TELEGRAM_WEBHOOK_SECRET.
// Возможности: /start (в т.ч. deep link по заявке), /shop, /orders, /help; диалог покупатель ↔ менеджеры
// через закрытый чат менеджеров (reply на пересланное сообщение уходит покупателю).
import { serve, json, HttpError } from '../_shared/http.ts';
import { adminClient, getSetting } from '../_shared/supabase.ts';
import { sendMessage, tgCall, appUrl, miniAppLink, notifyManagers, managerTargets, statusLabel } from '../_shared/telegram.ts';
import { escapeTelegramHtml as esc, timingSafeEqual } from '../_shared/domain/telegram.ts';
import { requireEnv } from '../_shared/env.ts';
import { hasImportableImage, importFromMessage, importTextFromMessage, isCatalogEditor, type ImportMessage } from '../_shared/import.ts';

type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string; language_code?: string };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  text?: string;
  caption?: string;
  photo?: unknown[];
  reply_to_message?: { message_id: number };
  media_group_id?: string;
  forward_origin?: unknown;
  forward_from_chat?: unknown;
};

function messageKind(m: TgMessage): string {
  const keys = ['text', 'photo', 'video', 'document', 'animation', 'sticker', 'voice', 'audio', 'video_note', 'poll', 'contact', 'location'];
  return keys.find((k) => (m as unknown as Record<string, unknown>)[k] !== undefined) ?? 'other';
}
type Update = { update_id: number; message?: TgMessage };

const DEFAULT_MANAGER_URL = 'https://t.me/keep_admin';

async function managerUrl(): Promise<string> {
  const v = await getSetting<string>('manager_contact_url');
  return v && /^https:\/\/t\.me\/[A-Za-z0-9_]{4,64}$/.test(v) ? v : DEFAULT_MANAGER_URL;
}

type Btn = { text: string; url?: string; web_app?: { url: string } };

function shopButton(path = ''): Btn[][] | undefined {
  const url = appUrl(path);
  return url ? [[{ text: 'Открыть магазин', web_app: { url } }]] : undefined;
}

/** Кнопки «Открыть магазин» + «Написать менеджеру» */
async function shopAndManager(path = ''): Promise<Btn[][]> {
  return [...(shopButton(path) ?? []), [{ text: 'Написать менеджеру', url: await managerUrl() }]];
}

async function supportText(): Promise<string> {
  const hours = (await getSetting<string>('support_hours')) ?? '';
  return `Напишите менеджеру KEEP MARKET напрямую — @keep_admin, или отправьте вопрос сюда, в этот чат.${hours ? `\nЧасы работы: ${esc(hours)}` : ''}`;
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

  // Чат с ботом нужен для уведомлений (в т.ч. сотрудникам, если чат менеджеров не настроен)
  await db.from('profiles').update({ bot_chat_id: m.chat.id }).eq('telegram_id', u.id).is('bot_chat_id', null);

  // Сотрудник отвечает покупателю reply-ответом в личном чате с ботом
  if (m.reply_to_message && await relayStaffReply(m)) return;

  if (text.startsWith('/start')) {
    await upsertProfileFromBot(u);
    const payload = text.split(/\s+/)[1] ?? '';
    const token = payload.startsWith('order_') ? payload.slice(6) : null;
    const { data } = await db.rpc('bot_link_order', { p_telegram_id: u.id, p_chat_id: m.chat.id, p_token: token });
    const r = data as { result: string; order_id?: string; number?: string; status?: string };
    if (r?.result === 'order_linked' && r.order_id) {
      await sendMessage(m.chat.id,
        `Заявка <b>${esc(r.number ?? '')}</b> получена.\nСтатус: ${esc(statusLabel(r.status ?? 'new'))}.\n\nМенеджер подтвердит заказ и свяжется с вами здесь, чтобы согласовать доставку и оплату. Оплата на этом этапе не производится.\n\nМожете написать вопрос прямо в этот чат.`,
        appUrl(`orders/${r.order_id}`) ? [[{ text: 'Открыть заявку', web_app: { url: appUrl(`orders/${r.order_id}`) as string } }]] : undefined);
      await notifyManagers(`Покупатель открыл диалог в боте по заявке <b>${esc(r.number ?? '')}</b>. Ответьте на его сообщения reply-ответом в этом чате.`, r.order_id);
      return;
    }
    await sendMessage(m.chat.id, 'Добро пожаловать в KEEP MARKET — одежда, обувь, сумки и аксессуары.\n\nОткройте магазин кнопкой ниже. Здесь же будут приходить уведомления о ваших заказах. Вопросы — менеджеру @keep_admin.', await shopAndManager());
    return;
  }

  // Пост поставщика с фото, пересланный владельцем/администратором → черновик товара
  if (hasImportableImage(m as unknown as ImportMessage) && (await isCatalogEditor(u.id))) {
    await importFromMessage(m as unknown as ImportMessage);
    return;
  }

  if (text === '/import' || text === '/help_import') {
    if (await isCatalogEditor(u.id)) {
      await sendMessage(m.chat.id, 'Импорт товаров: перешлите сюда пост поставщика с фото (альбомом). Бот создаст черновик: название и описание из текста поста (без контактов поставщика), цену, размеры и фото. Фон на фото удаляется автоматически. Затем проверьте карточку и опубликуйте.');
      return;
    }
  }

  if (text === '/shop') {
    await sendMessage(m.chat.id, 'Каталог KEEP MARKET:', shopButton());
    return;
  }

  if (text === '/help' || text === '/support' || text === '/manager') {
    await sendMessage(m.chat.id, await supportText(), [[{ text: 'Написать менеджеру', url: await managerUrl() }]]);
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
    await sendMessage(m.chat.id, 'Команды: /shop — магазин, /orders — мои заказы, /manager — написать менеджеру.', await shopAndManager());
    return;
  }

  // Владелец/админ: пересланный текст поста или прочее — это работа с каталогом, а не вопрос покупателя
  if (await isCatalogEditor(u.id)) {
    await handleEditorMessage(m);
    return;
  }

  // Сообщение покупателя → менеджерам (копия + привязка для ответа)
  const targets = await managerTargets();
  if (!targets.length) {
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
  const buttons = orderId && miniAppLink(`a_${orderId}`, `admin/orders/${orderId}`)
    ? [[{ text: 'Открыть заявку', url: miniAppLink(`a_${orderId}`, `admin/orders/${orderId}`) as string }]] : undefined;
  let delivered = false;
  for (const target of targets) {
    await sendMessage(target, `Сообщение покупателя${orderRef}. Ответьте reply на копию ниже.`, buttons);
    const copy = await tgCall<{ message_id: number }>('copyMessage', { chat_id: target, from_chat_id: m.chat.id, message_id: m.message_id });
    if (copy.ok && copy.result) {
      delivered = true;
      await db.from('bot_relay_messages').insert({
        manager_chat_id: Number(target), manager_message_id: copy.result.message_id, customer_chat_id: m.chat.id,
        customer_id: profile?.id ?? null, order_id: orderId,
      });
    }
  }
  await sendMessage(m.chat.id, delivered ? 'Сообщение передано менеджеру. Ответ придёт в этот чат.' : 'Не удалось передать сообщение. Попробуйте позже.');
}

async function relayStaffReply(m: TgMessage): Promise<boolean> {
  if (!m.reply_to_message || !m.from || m.from.is_bot) return false;
  const db = adminClient();
  const { data: link } = await db.from('bot_relay_messages').select('customer_chat_id, order_id')
    .eq('manager_chat_id', m.chat.id).eq('manager_message_id', m.reply_to_message.message_id).maybeSingle();
  if (!link) return false;
  // Отвечать покупателям могут только сотрудники магазина
  const { data: staffProfile } = await db.from('profiles').select('id, is_blocked').eq('telegram_id', m.from.id).maybeSingle();
  const { data: staffRoles } = staffProfile
    ? await db.from('user_roles').select('role').eq('user_id', staffProfile.id)
    : { data: [] as { role: string }[] };
  const staff = staffProfile && !staffProfile.is_blocked && (staffRoles ?? []).length > 0 ? staffProfile : null;
  if (!staff) {
    await sendMessage(m.chat.id, 'Ответ не отправлен: ваш Telegram-аккаунт не назначен сотрудником в админ-панели.');
    return true;
  }
  const res = await tgCall('copyMessage', { chat_id: link.customer_chat_id, from_chat_id: m.chat.id, message_id: m.message_id });
  await sendMessage(m.chat.id, res.ok ? 'Ответ отправлен покупателю.' : 'Не удалось отправить ответ (покупатель мог остановить бота).');
  if (res.ok && link.order_id) {
    await db.from('audit_logs').insert({ actor_id: staff.id, action: 'bot_reply_sent', entity: 'orders', entity_id: link.order_id, details: {} });
  }
  return true;
}

async function handleManagerChat(m: TgMessage) {
  const managerChat = await getSetting<number | string>('manager_chat_id');
  if (!managerChat || String(m.chat.id) !== String(managerChat)) return; // бот игнорирует чужие группы
  await relayStaffReply(m);
}

/** Сообщение без фото от владельца/админа: текст поста → в последний черновик, иначе — подсказка вместо пересылки менеджерам. */
async function handleEditorMessage(m: TgMessage): Promise<void> {
  const forwarded = !!(m.forward_origin || m.forward_from_chat);
  const kind = messageKind(m);
  if ((kind === 'text' || m.caption) && await importTextFromMessage(m)) return;
  console.log(`[telegram-bot] editor message not imported: kind=${kind} forwarded=${forwarded} album=${!!m.media_group_id}`);
  if (m.media_group_id) return; // видео и прочее из альбома: фото уже импортируются, лишнее молча пропускаем
  if (forwarded) {
    await sendMessage(m.chat.id, kind === 'text'
      ? 'Текст без фото не к чему добавить: черновика за последние 5 минут нет. Перешлите пост с фото — бот создаст черновик, затем можно переслать текст.'
      : 'Этот тип сообщения не импортируется. Перешлите пост с фото (JPEG, PNG или WebP) — бот создаст черновик товара.');
    return;
  }
  await sendMessage(m.chat.id, 'Чтобы добавить товар, перешлите сюда пост поставщика с фото. Ответить покупателю — reply на его сообщение. Команды: /shop, /orders, /import.');
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
