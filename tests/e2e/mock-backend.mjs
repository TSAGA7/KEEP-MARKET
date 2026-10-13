// Мини-эмулятор Supabase для e2e-проверки интерфейса:
//  • REST (подмножество PostgREST) выполняется в PGlite с РЕАЛЬНЫМИ миграциями, ролями и RLS;
//  • Edge Functions auth-telegram / create-order / order-action повторяют серверную логику через те же SQL-функции.
// Не используется в production. Telegram-подпись initData здесь не проверяется (это покрыто unit-тестами).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function createBackend() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls;
    create schema auth;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(coalesce(current_setting('request.jwt.claim.sub', true), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;`);
  for (const f of readdirSync(join(ROOT, 'supabase/migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8'));
  }
  await db.exec(readFileSync(join(ROOT, 'supabase/seed.sql'), 'utf8'));
  await db.exec(`update public.store_settings set value = '"keep_market_test_bot"' where key = 'telegram_bot_username';
                 update public.store_settings set value = '"https://t.me/keep_market_channel"' where key = 'telegram_channel_url';`);

  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => undefined); return p; };

  async function as(userId, fn) {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [userId ? JSON.stringify({ sub: userId, role: 'authenticated' }) : '']);
    await db.exec(`set role ${userId ? 'authenticated' : 'anon'}`);
    try { return await fn(); } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); }
  }

  const fnMeta = new Map();
  async function isSetReturning(name) {
    if (!fnMeta.has(name)) {
      const r = await db.query(`select bool_or(proretset) s from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [name]);
      fnMeta.set(name, r.rows[0]?.s === true);
    }
    return fnMeta.get(name);
  }

  function parseFilters(params, values) {
    const where = [];
    const add = (col, opv) => {
      if (!IDENT.test(col)) throw new Error('bad column');
      const dot = opv.indexOf('.');
      let op = opv.slice(0, dot); let v = opv.slice(dot + 1);
      let neg = false;
      if (op === 'not') { neg = true; const d2 = v.indexOf('.'); op = v.slice(0, d2); v = v.slice(d2 + 1); }
      let clause;
      const p = () => { values.push(v); return `$${values.length}`; };
      switch (op) {
        case 'eq': clause = `${col} = ${p()}`; break;
        case 'neq': clause = `${col} <> ${p()}`; break;
        case 'gt': clause = `${col} > ${p()}`; break;
        case 'gte': clause = `${col} >= ${p()}`; break;
        case 'lt': clause = `${col} < ${p()}`; break;
        case 'lte': clause = `${col} <= ${p()}`; break;
        case 'ilike': v = v.replace(/\*/g, '%'); clause = `${col}::text ilike ${p()}`; break;
        case 'is': clause = `${col} is ${v === 'null' ? 'null' : v === 'true' ? 'true' : 'false'}`; break;
        case 'in': {
          const items = v.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
          values.push(items); clause = `${col}::text = any(${'$' + values.length}::text[])`; break;
        }
        default: throw new Error('unsupported op ' + op);
      }
      where.push(neg ? `not (${clause})` : clause);
    };
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
      if (k === 'or') {
        const inner = v.replace(/^\(|\)$/g, '').split(',').map((part) => {
          const [col, ...rest] = part.split('.');
          const sub = [];
          const tmp = [[col, rest.join('.')]];
          const before = where.length;
          for (const [c, o] of tmp) add(c, o);
          sub.push(...where.splice(before));
          return sub[0];
        });
        where.push(`(${inner.join(' or ')})`);
        continue;
      }
      if (k.includes('.')) continue; // фильтры по встроенным связям не поддерживаются
      add(k, v);
    }
    return where;
  }

  function selectCols(sel) {
    if (!sel || sel === '*') return '*';
    const cols = []; let depth = 0; let cur = '';
    for (const ch of sel) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { cols.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur) cols.push(cur);
    const plain = cols.map((c) => c.trim()).filter((c) => !c.includes('(') && IDENT.test(c));
    return plain.length ? plain.join(', ') : '*';
  }

  async function rest(method, path, search, body, userId, accept, prefer) {
    const params = [...new URLSearchParams(search).entries()];
    if (path.startsWith('rpc/')) {
      const name = path.slice(4);
      if (!IDENT.test(name)) throw new Error('bad fn');
      const args = body ? JSON.parse(body) : {};
      const values = []; const parts = [];
      for (const [k, v] of Object.entries(args)) {
        if (!IDENT.test(k)) throw new Error('bad arg');
        values.push(v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v);
        parts.push(`${k} => $${values.length}`);
      }
      const setof = await isSetReturning(name);
      const sql = setof ? `select * from public.${name}(${parts.join(', ')})` : `select public.${name}(${parts.join(', ')}) as r`;
      const r = await as(userId, () => db.query(sql, values));
      return setof ? r.rows : r.rows[0]?.r ?? null;
    }
    const table = path;
    if (!IDENT.test(table)) throw new Error('bad table');
    const values = [];
    const where = parseFilters(params, values);
    const w = where.length ? ` where ${where.join(' and ')}` : '';
    if (method === 'GET') {
      const sp = new URLSearchParams(search);
      const order = sp.getAll('order').flatMap((o) => o.split(',')).map((o) => {
        const [c, dir, nulls] = o.split('.');
        if (!IDENT.test(c)) throw new Error('bad order');
        return `${c} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullsfirst' ? ' nulls first' : nulls === 'nullslast' ? ' nulls last' : ''}`;
      });
      const sql = `select ${selectCols(sp.get('select'))} from public.${table}${w}${order.length ? ` order by ${order.join(', ')}` : ''}${sp.get('limit') ? ` limit ${Number(sp.get('limit'))}` : ''}${sp.get('offset') ? ` offset ${Number(sp.get('offset'))}` : ''}`;
      const r = await as(userId, () => db.query(sql, values));
      return accept?.includes('vnd.pgrst.object') ? r.rows[0] ?? null : r.rows;
    }
    if (method === 'POST') {
      const rows = [].concat(JSON.parse(body));
      const cols = Object.keys(rows[0]).filter((c) => IDENT.test(c));
      const vals = [];
      const tuples = rows.map((row) => `(${cols.map((c) => { vals.push(row[c] !== null && typeof row[c] === 'object' && !Array.isArray(row[c]) ? JSON.stringify(row[c]) : row[c]); return `$${vals.length}`; }).join(', ')})`);
      const onConflict = new URLSearchParams(search).get('on_conflict');
      let conflict = '';
      if (prefer?.includes('resolution=ignore-duplicates')) conflict = ` on conflict${onConflict ? ` (${onConflict})` : ''} do nothing`;
      else if (prefer?.includes('resolution=merge-duplicates')) conflict = ` on conflict (${onConflict ?? 'id'}) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`;
      const r = await as(userId, () => db.query(`insert into public.${table} (${cols.join(', ')}) values ${tuples.join(', ')}${conflict} returning *`, vals));
      return accept?.includes('vnd.pgrst.object') ? r.rows[0] : r.rows;
    }
    if (method === 'PATCH') {
      const row = JSON.parse(body);
      const sets = Object.entries(row).filter(([c]) => IDENT.test(c)).map(([c, v]) => { values.push(v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v); return `${c} = $${values.length}`; });
      const r = await as(userId, () => db.query(`update public.${table} set ${sets.join(', ')}${w} returning *`, values));
      return r.rows;
    }
    if (method === 'DELETE') {
      const r = await as(userId, () => db.query(`delete from public.${table}${w} returning *`, values));
      return r.rows;
    }
    throw new Error('method');
  }

  async function fn(name, body, userId) {
    const b = body ? JSON.parse(body) : {};
    if (name === 'auth-telegram') {
      const tgId = Number(String(b.initData).split(':')[1]);
      const r = await db.query(`insert into public.profiles (telegram_id, username, first_name) values ($1, $2, $3)
        on conflict (telegram_id) do update set last_login_at = now() returning id, telegram_id, username, first_name, last_name, photo_url, bot_chat_id`, [tgId, `user${tgId}`, tgId === 111 ? 'Владелец' : 'Анна']);
      const p = r.rows[0];
      const roles = (await db.query(`select role from public.user_roles where user_id = $1`, [p.id])).rows.map((x) => x.role);
      return [200, { access_token: `mock.${p.id}`, expires_at: Math.floor(Date.now() / 1000) + 3600, start_param: null, roles,
        profile: { ...p, bot_connected: !!p.bot_chat_id, consent_pd_version: null } }];
    }
    if (!userId) return [401, { error: 'AUTH_REQUIRED' }];
    try {
      if (name === 'create-order') {
        const r = await as(userId, () => db.query(`select public.create_order_request($1::jsonb) r`, [JSON.stringify(b)]));
        const res = r.rows[0].r;
        if (res.ok) { res.bot_link = `https://t.me/keep_market_test_bot?start=order_${res.telegram_token}`; delete res.telegram_token; }
        return [res.ok ? 200 : 409, res];
      }
      if (name === 'order-action') {
        if (b.action === 'customer_confirm') return [200, (await as(userId, () => db.query(`select public.customer_confirm_order($1) r`, [b.order_id]))).rows[0].r];
        if (b.action === 'customer_cancel') return [200, (await as(userId, () => db.query(`select public.customer_cancel_order($1, $2) r`, [b.order_id, b.payload?.reason ?? '']))).rows[0].r];
        const r = await as(userId, () => db.query(`select public.staff_order_action($1, $2, $3::jsonb) r`, [b.order_id, b.action, JSON.stringify(b.payload ?? {})]));
        return [200, { ...r.rows[0].r, customer_notified: false }];
      }
    } catch (e) {
      const m = String(e.message);
      const code = m.match(/\b([A-Z][A-Z0-9_]{3,60})\b/)?.[1] ?? 'INTERNAL_ERROR';
      return [code === 'FORBIDDEN' ? 403 : 409, { error: code }];
    }
    return [404, { error: 'NOT_FOUND' }];
  }

  /** Обработчик для page.route('http://mock.local/**') */
  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const auth = req.headers()['authorization'] ?? '';
    const userId = auth.startsWith('Bearer mock.') ? auth.slice(12) : null;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    try {
      if (url.pathname.startsWith('/functions/v1/')) {
        const [status, data] = await serial(() => fn(url.pathname.slice(14), req.postData(), userId));
        return route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(data) });
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const data = await serial(() => rest(req.method(), url.pathname.slice(9), url.search, req.postData(), userId, req.headers()['accept'], req.headers()['prefer']));
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(data ?? null) });
      }
      if (url.pathname.startsWith('/storage/')) return route.fulfill({ status: 404, headers: cors, body: '' });
    } catch (e) {
      return route.fulfill({ status: 400, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ message: String(e.message), code: 'P0001' }) });
    }
    return route.fulfill({ status: 404, headers: cors, body: '{}' });
  }

  return { db, handle };
}
