// Telegram Bot API и уведомления. Токен бота — только в секретах Edge Functions.
// В групповых уведомлениях менеджерам НЕТ персональных данных: номер заявки, количество, ссылка на защищённую карточку.
import { escapeTelegramHtml as esc } from './domain/telegram.ts';
import { formatRub } from './domain/money.ts';
import { ORDER_STATUS_LABEL, type OrderStatus } from './domain/orders.ts';
import { adminClient, getSetting } from './supabase.ts';
import { env, requireEnv } from './env.ts';

type InlineButton = { text: string; url?: string; web_app?: { url: string }; callback_data?: string };

export async function tgCall<T = unknown>(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: T; description?: string }> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) console.error(`[telegram] ${method} failed: ${data.description?.slice(0, 120)}`);
    return data;
  } catch {
    console.error(`[telegram] ${method} network error`);
    return { ok: false };
  }
}

export function sendMessage(chatId: number | string, html: string, buttons?: InlineButton[][]) {
  return tgCall('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

export function appUrl(path = ''): string | null {
  const base = env('APP_PUBLIC_URL');
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

/** Прямая ссылка на Mini App внутри Telegram (t.me/<bot>/<app>?startapp=...) — авторизация через initData сохраняется.
 *  Без TELEGRAM_APP_SHORT_NAME — обычная ссылка на сайт (откроется в браузере, админке потребуется Telegram). */
export function miniAppLink(startParam: string, fallbackPath: string): string | null {
  const bot = env('TELEGRAM_BOT_USERNAME');
  const app = env('TELEGRAM_APP_SHORT_NAME');
  if (bot && app) return `https://t.me/${bot}/${app}?startapp=${encodeURIComponent(startParam)}`;
  return appUrl(fallbackPath);
}

/** Уведомление менеджерам о новой заявке — без ФИО, телефона и адреса */
export async function notifyManagersNewOrder(o: { orderId: string; number: string; itemsCount: number; totalKopecks: number }) {
  const chatId = await getSetting<number | string>('manager_chat_id');
  if (!chatId) {
    console.warn('[notify] manager_chat_id не настроен — уведомление не отправлено');
    return false;
  }
  const url = miniAppLink(`a_${o.orderId}`, `admin/orders/${o.orderId}`);
  const text = `<b>Новая заявка ${esc(o.number)}</b>\nТоваров: ${o.itemsCount}\nСумма по ценам заявки: ${esc(formatRub(o.totalKopecks))}\nОплата не производилась — нужна проверка наличия.`;
  const res = await sendMessage(chatId, text, url ? [[{ text: 'Открыть заявку', url }]] : undefined);
  return res.ok;
}

export async function notifyManagers(text: string, orderId?: string) {
  const chatId = await getSetting<number | string>('manager_chat_id');
  if (!chatId) return false;
  const url = orderId ? miniAppLink(`a_${orderId}`, `admin/orders/${orderId}`) : null;
  const res = await sendMessage(chatId, text, url ? [[{ text: 'Открыть заявку', url }]] : undefined);
  return res.ok;
}

const CUSTOMER_TEXT: Record<string, (n: string, extra: Record<string, string>) => string> = {
  checking: (n) => `Заявка <b>${n}</b>: менеджер проверяет наличие у поставщика.`,
  needs_confirmation: (n) => `Заявка <b>${n}</b>: условия обновлены (наличие, цена или доставка). Пожалуйста, проверьте и подтвердите заказ.`,
  confirmed: (n) => `Заказ <b>${n}</b> подтверждён. Менеджер согласует способ оплаты и сроки.`,
  payment_available: (n) => `Для заказа <b>${n}</b> доступна онлайн-оплата.`,
  supplier_processing: (n) => `Заказ <b>${n}</b> передан поставщику.`,
  shipped: (n, x) => `Заказ <b>${n}</b> отправлен.${x.tracking ? ` Трек-номер: <code>${x.tracking}</code>` : ''}`,
  tracking: (n, x) => `Трек-номер заказа <b>${n}</b>: <code>${x.tracking ?? ''}</code>`,
  delivered: (n) => `Заказ <b>${n}</b> доставлен. Спасибо, что выбрали KEEP MARKET!`,
  cancelled: (n, x) => `Заказ <b>${n}</b> отменён.${x.reason ? ` Причина: ${x.reason}` : ''} Деньги не списывались.`,
  paid: (n) => `Оплата заказа <b>${n}</b> получена.`,
};

/** Личное сообщение покупателю — только если он сам открыл бота (bot_chat_id заполнен) */
export async function notifyCustomer(orderId: string, kind: string): Promise<boolean> {
  const tmpl = CUSTOMER_TEXT[kind];
  if (!tmpl) return false;
  const db = adminClient();
  const { data: o } = await db.from('orders').select('id, number, status, customer_id, cancel_reason').eq('id', orderId).maybeSingle();
  if (!o) return false;
  const { data: p } = await db.from('profiles').select('bot_chat_id').eq('id', o.customer_id).maybeSingle();
  if (!p?.bot_chat_id) return false;
  const extra: Record<string, string> = {};
  if (kind === 'shipped' || kind === 'tracking') {
    const { data: s } = await db.from('shipments').select('tracking_number').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (s?.tracking_number) extra.tracking = esc(s.tracking_number);
  }
  if (kind === 'cancelled' && o.cancel_reason) extra.reason = esc(String(o.cancel_reason).slice(0, 200));
  const url = appUrl(`orders/${o.id}`);
  const res = await sendMessage(p.bot_chat_id, tmpl(esc(o.number), extra),
    url ? [[{ text: 'Открыть заказ', web_app: { url } }]] : undefined);
  return res.ok;
}

export function statusLabel(s: string): string {
  return ORDER_STATUS_LABEL[s as OrderStatus] ?? s;
}
