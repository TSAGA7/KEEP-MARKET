// Выпуск и проверка JWT для Supabase (HS256, секрет проекта). Подпись — только на сервере.
// sub = profiles.id, role = authenticated → PostgREST/RLS видит пользователя через auth.uid().
import { SignJWT, jwtVerify } from 'jose';

const enc = new TextEncoder();

export interface SessionClaims {
  sub: string;
  role: 'authenticated';
  aud: 'authenticated';
  tg: number;
  /** Роли — только для интерфейса. Права всегда проверяет база по таблице user_roles. */
  app_roles: string[];
}

export async function issueSessionJwt(p: { userId: string; telegramId: number; roles: string[]; secret: string; ttlSeconds: number; issuer: string }) {
  if (!p.secret || p.secret.length < 32) throw new Error('JWT secret is too short');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + p.ttlSeconds;
  const token = await new SignJWT({ role: 'authenticated', tg: p.telegramId, app_roles: p.roles })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(p.userId)
    .setAudience('authenticated')
    .setIssuer(p.issuer)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(enc.encode(p.secret));
  return { token, expiresAt: exp };
}

export async function verifySessionJwt(token: string, secret: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, enc.encode(secret), { algorithms: ['HS256'], audience: 'authenticated' });
  if (typeof payload.sub !== 'string' || payload.role !== 'authenticated') throw new Error('INVALID_TOKEN');
  if (!/^[0-9a-f-]{36}$/.test(payload.sub)) throw new Error('INVALID_TOKEN');
  return payload as unknown as SessionClaims;
}
