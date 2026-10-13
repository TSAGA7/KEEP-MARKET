// Проверка Telegram WebApp initData по официальной документации:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
//   hash       = hex(HMAC_SHA256(key=secret_key, message=data_check_string))
// data_check_string — все поля, кроме hash, отсортированные по ключу, в формате key=value через \n.
// Работает в Deno (Edge Functions) и Node 20+ (тесты) через WebCrypto. initDataUnsafe на клиенте НЕ используется.

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
  is_bot?: boolean;
}

export type InitDataResult =
  | { ok: true; user: TelegramUser; authDate: number; startParam: string | null; queryId: string | null }
  | { ok: false; error: 'INIT_DATA_MISSING' | 'INIT_DATA_INVALID' | 'INIT_DATA_EXPIRED' | 'INIT_DATA_NO_USER' };

const enc = new TextEncoder();

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Сравнение без утечки по времени */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function buildDataCheckString(params: URLSearchParams): string {
  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  });
  return pairs.sort().join('\n');
}

export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const params = new URLSearchParams(fields);
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const hash = toHex(await hmac(secret, buildDataCheckString(params)));
  params.set('hash', hash);
  return params.toString();
}

export async function verifyInitData(
  initData: string | null | undefined,
  botToken: string,
  opts: { maxAgeSeconds: number; nowSeconds?: number },
): Promise<InitDataResult> {
  if (!initData || typeof initData !== 'string' || initData.length > 8192) return { ok: false, error: 'INIT_DATA_MISSING' };
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, error: 'INIT_DATA_INVALID' };
  }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'INIT_DATA_INVALID' };

  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const expected = toHex(await hmac(secret, buildDataCheckString(params)));
  if (!timingSafeEqual(expected, hash)) return { ok: false, error: 'INIT_DATA_INVALID' };

  const authDate = Number(params.get('auth_date'));
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, error: 'INIT_DATA_INVALID' };
  if (authDate > now + 60) return { ok: false, error: 'INIT_DATA_INVALID' };
  if (now - authDate > opts.maxAgeSeconds) return { ok: false, error: 'INIT_DATA_EXPIRED' };

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, error: 'INIT_DATA_NO_USER' };
  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw) as TelegramUser;
  } catch {
    return { ok: false, error: 'INIT_DATA_INVALID' };
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot) return { ok: false, error: 'INIT_DATA_NO_USER' };

  return { ok: true, user, authDate, startParam: params.get('start_param'), queryId: params.get('query_id') };
}

export type StartTarget =
  | { type: 'product'; slug: string }
  | { type: 'order'; id: string }
  | { type: 'admin_order'; id: string }
  | { type: 'admin_product'; id: string }
  | { type: 'catalog'; category: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** start_param для deep link (≤64 символов [A-Za-z0-9_-]):
 *  p_<slug> — товар, o_<uuid> — заказ покупателя, a_<uuid> — карточка заявки в админке, c_<category> — категория. */
export function parseStartParam(sp: string | null | undefined): StartTarget | null {
  if (!sp || sp.length > 64 || !/^[A-Za-z0-9_-]+$/.test(sp)) return null;
  const body = sp.slice(2);
  if (sp.startsWith('p_') && body) return { type: 'product', slug: body.replace(/_/g, '-').toLowerCase() };
  if (sp.startsWith('o_') && UUID_RE.test(body)) return { type: 'order', id: body };
  if (sp.startsWith('a_') && UUID_RE.test(body)) return { type: 'admin_order', id: body };
  if (sp.startsWith('e_') && UUID_RE.test(body)) return { type: 'admin_product', id: body };
  if (sp.startsWith('c_') && /^[a-z0-9-]+$/.test(body)) return { type: 'catalog', category: body };
  return null;
}

/** Путь внутри приложения для start_param */
export function startTargetPath(t: StartTarget | null): string | null {
  if (!t) return null;
  switch (t.type) {
    case 'product': return `/product/${t.slug}`;
    case 'order': return `/orders/${t.id}`;
    case 'admin_order': return `/admin/orders/${t.id}`;
    case 'admin_product': return `/admin/products/${t.id}`;
    case 'catalog': return `/catalog?category=${t.category}`;
  }
}

export function productStartParam(slug: string): string {
  return `p_${slug.replace(/-/g, '_')}`.slice(0, 64);
}

/** Экранирование для parse_mode=HTML в Bot API */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
