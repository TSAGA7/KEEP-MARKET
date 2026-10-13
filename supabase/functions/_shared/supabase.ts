// Клиенты Supabase для Edge Functions.
// adminClient — service role (обходит RLS): только для служебных операций (профили, платежи, уведомления).
// userClient — от имени пользователя: RLS и проверки ролей в SQL действуют как для клиента.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifySessionJwt, type SessionClaims } from './domain/jwt.ts';
import { HttpError } from './http.ts';
import { requireEnv } from './env.ts';

let _admin: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

export function userClient(token: string): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export interface AuthedRequest {
  token: string;
  claims: SessionClaims;
  userId: string;
  db: SupabaseClient;
}

/** Проверяет JWT, выпущенный auth-telegram. Доверяем только подписи, не данным клиента. */
export async function requireUser(req: Request): Promise<AuthedRequest> {
  const h = req.headers.get('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'AUTH_REQUIRED');
  let claims: SessionClaims;
  try {
    claims = await verifySessionJwt(token, requireEnv('APP_JWT_SECRET'));
  } catch {
    throw new HttpError(401, 'AUTH_REQUIRED');
  }
  return { token, claims, userId: claims.sub, db: userClient(token) };
}

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const { data, error } = await adminClient().rpc('check_rate_limit', { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) {
    console.error('rate limit check failed');
    return; // не блокируем работу магазина из-за сбоя счётчика
  }
  if (data === false) throw new HttpError(429, 'RATE_LIMITED');
}

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const { data } = await adminClient().from('store_settings').select('value').eq('key', key).maybeSingle();
  return (data?.value ?? null) as T | null;
}
