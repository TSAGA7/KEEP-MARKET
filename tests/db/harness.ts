// Тестовый стенд БД: настоящий Postgres 16 (PGlite, WASM) + окружение, повторяющее Supabase
// (роли anon/authenticated/service_role, auth.uid() из JWT-claims). Применяются реальные миграции.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');

const SUPABASE_BOOTSTRAP = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create schema auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                           (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

export type Db = PGlite;

export async function createDb(opts: { seed?: boolean } = {}): Promise<Db> {
  const db = new PGlite();
  await db.exec(SUPABASE_BOOTSTRAP);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    } catch (e) {
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  if (opts.seed) await db.exec(readFileSync(join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  return db;
}

type Role = 'anon' | 'authenticated' | 'service_role' | 'postgres';

/** Выполнить fn от имени роли (и пользователя — для authenticated). Всегда возвращает роль обратно. */
export async function as<T>(db: Db, role: Role, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec('reset role');
  const claims = userId ? JSON.stringify({ sub: userId, role }) : '';
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

export async function q<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query<T>(sql, params);
  return r.rows;
}

export async function one<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await q<T>(db, sql, params);
  if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}: ${sql}`);
  return rows[0] as T;
}

export async function createProfile(db: Db, telegramId: number, username = `user${telegramId}`): Promise<string> {
  const r = await one<{ id: string }>(db,
    `insert into public.profiles (telegram_id, username, first_name) values ($1, $2, 'Test') returning id`,
    [telegramId, username]);
  return r.id;
}

export async function grantRole(db: Db, userId: string, role: 'owner' | 'admin' | 'manager') {
  await db.query(`insert into public.user_roles (user_id, role) values ($1, $2)`, [userId, role]);
}

/** Создаёт опубликованный, проверенный товар с одним вариантом. Возвращает id товара и варианта. */
export async function createSellableProduct(db: Db, o: {
  slug: string; price?: number; stock?: number; confirmedHoursAgo?: number; size?: string;
}): Promise<{ productId: string; variantId: string }> {
  const price = o.price ?? 100000;
  await db.exec(`select set_config('app.review_ctx', 'on', false)`);
  const cat = await one<{ id: string }>(db, `select id from public.categories where slug = 'clothing'`);
  const p = await one<{ id: string }>(db, `
    insert into public.products (slug, title, description, category_id, sku, price_kopecks, compliance_status, trademark_review_status)
    values ($1, $2, 'Описание тестового товара', $3, $4, $5, 'approved', 'approved') returning id`,
    [o.slug, `Товар ${o.slug}`, cat.id, `SKU-${o.slug}`.toUpperCase(), price]);
  await db.exec(`select set_config('app.review_ctx', 'off', false)`);
  await db.query(`insert into public.product_images (product_id, url, sort_order) values ($1, 'demo:tee-1.svg', 0)`, [p.id]);
  const v = await one<{ id: string }>(db, `
    insert into public.product_variants (product_id, sku, size, color, stock_qty, stock_confirmed_at)
    values ($1, $2, $3, 'Чёрный', $4, now() - make_interval(hours => $5)) returning id`,
    [p.id, `V-${o.slug}`.toUpperCase(), o.size ?? 'M', o.stock ?? 5, o.confirmedHoursAgo ?? 1]);
  await db.query(`update public.products set status = 'published' where id = $1`, [p.id]);
  return { productId: p.id, variantId: v.id };
}

export function orderPayload(items: Array<{ variant_id: string; quantity: number; expected_unit_price_kopecks: number }>, extra: Record<string, unknown> = {}) {
  return {
    idempotency_key: `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    items,
    delivery_method: 'cdek_pickup',
    contact: { recipient_name: 'Иван Тестов', phone: '+7 900 000-00-00', email: 'test@example.com' },
    address: { pickup_mode: 'manual', city: 'Москва', pickup_point_address: 'ул. Тестовая, 1' },
    consent_pd: true,
    ...extra,
  };
}

export async function expectDbError(p: Promise<unknown>, match: RegExp | string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    const ok = typeof match === 'string' ? msg.includes(match) : match.test(msg);
    if (!ok) throw new Error(`Expected error matching ${match}, got: ${msg}`);
    return;
  }
  throw new Error(`Expected error matching ${match}, but call succeeded`);
}
