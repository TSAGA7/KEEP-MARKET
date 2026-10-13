// POST /auth-telegram { initData } → { access_token, expires_at, profile, roles, start_param }
// 1) Проверяет подпись initData токеном бота (на сервере) и свежесть auth_date.
// 2) Создаёт/обновляет профиль по проверенному Telegram ID.
// 3) Выпускает короткоживущий JWT для Supabase (RLS видит пользователя через auth.uid()).
import { z } from 'zod';
import { serve, json, readJson, HttpError } from '../_shared/http.ts';
import { verifyInitData } from '../_shared/domain/telegram.ts';
import { issueSessionJwt } from '../_shared/domain/jwt.ts';
import { adminClient, rateLimit } from '../_shared/supabase.ts';
import { env, requireEnv } from '../_shared/env.ts';

const bodySchema = z.object({ initData: z.string().min(10).max(8192) });

serve('auth-telegram', async (req) => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  await rateLimit(`auth:ip:${ip}`, 30, 60);

  const parsed = bodySchema.safeParse(await readJson(req, 16 * 1024));
  if (!parsed.success) throw new HttpError(422, 'INIT_DATA_MISSING');

  const result = await verifyInitData(parsed.data.initData, requireEnv('TELEGRAM_BOT_TOKEN'), {
    maxAgeSeconds: Number(env('INIT_DATA_MAX_AGE_SECONDS') ?? 86400),
  });
  if (!result.ok) throw new HttpError(401, result.error);

  const u = result.user;
  const db = adminClient();
  const { data: profile, error } = await db
    .from('profiles')
    .upsert({
      telegram_id: u.id,
      username: u.username?.slice(0, 64) ?? null,
      first_name: u.first_name?.slice(0, 128) ?? null,
      last_name: u.last_name?.slice(0, 128) ?? null,
      language_code: u.language_code?.slice(0, 8) ?? null,
      photo_url: u.photo_url && u.photo_url.startsWith('https://') ? u.photo_url.slice(0, 512) : null,
      last_login_at: new Date().toISOString(),
    }, { onConflict: 'telegram_id' })
    .select('id, telegram_id, username, first_name, last_name, photo_url, is_blocked, bot_chat_id, consent_pd_version')
    .single();
  if (error || !profile) throw new HttpError(500, 'PROFILE_UPSERT_FAILED');
  if (profile.is_blocked) throw new HttpError(403, 'USER_BLOCKED');

  const { data: roleRows } = await db.from('user_roles').select('role').eq('user_id', profile.id);
  const roles = (roleRows ?? []).map((r: { role: string }) => r.role);

  const ttl = Number(env('SESSION_TTL_SECONDS') ?? 12 * 3600);
  const { token, expiresAt } = await issueSessionJwt({
    userId: profile.id, telegramId: u.id, roles, secret: requireEnv('APP_JWT_SECRET'), ttlSeconds: ttl,
    issuer: 'keep-market',
  });

  return json(req, {
    access_token: token,
    expires_at: expiresAt,
    start_param: result.startParam,
    roles,
    profile: {
      id: profile.id,
      telegram_id: profile.telegram_id,
      username: profile.username,
      first_name: profile.first_name,
      last_name: profile.last_name,
      photo_url: profile.photo_url,
      bot_connected: !!profile.bot_chat_id,
      consent_pd_version: profile.consent_pd_version,
    },
  });
});
