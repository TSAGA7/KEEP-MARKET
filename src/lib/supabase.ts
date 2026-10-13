// Клиенты Supabase: анонимный (витрина) и от имени пользователя (JWT, выпущенный auth-telegram).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config, functionsUrl } from './config';

const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

let anon: SupabaseClient | null = null;
let authed: { token: string; client: SupabaseClient } | null = null;
let currentToken: string | null = null;

export function setAccessToken(token: string | null) {
  currentToken = token;
  if (!token) authed = null;
}

export function getAccessToken(): string | null {
  return currentToken;
}

/** Клиент для запросов: с токеном пользователя, если он вошёл, иначе анонимный */
export function db(): SupabaseClient {
  if (currentToken) {
    if (!authed || authed.token !== currentToken) {
      authed = {
        token: currentToken,
        client: createClient(config.supabaseUrl, config.supabaseAnonKey, {
          ...opts,
          global: { headers: { Authorization: `Bearer ${currentToken}` } },
        }),
      };
    }
    return authed.client;
  }
  if (!anon) anon = createClient(config.supabaseUrl || 'http://localhost:54321', config.supabaseAnonKey || 'public-anon-key', opts);
  return anon;
}

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body?: unknown) {
    super(code);
  }
}

/** Вызов Edge Function. Возвращает тело; для 409 с полем ok=false — тоже тело (обрабатывает вызывающий). */
export async function callFunction<T>(name: string, body: unknown, opts2: { allowConflict?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey };
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  let res: Response;
  try {
    res = await fetch(functionsUrl(name), { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('NETWORK_ERROR', 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* пустой ответ */
  }
  if (res.ok || (opts2.allowConflict && res.status === 409 && (data as { ok?: boolean })?.ok === false)) return data as T;
  const code = (data as { error?: string } | null)?.error ?? `HTTP_${res.status}`;
  throw new ApiError(code, res.status, data);
}

export function imageUrl(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith('demo:')) return `${config.baseUrl}demo/${ref.slice(5)}`;
  if (ref.startsWith('storage:')) return `${config.supabaseUrl}/storage/v1/object/public/product-images/${ref.slice(8).split('/').map(encodeURIComponent).join('/')}`;
  if (ref.startsWith('https://')) return ref;
  return null;
}
