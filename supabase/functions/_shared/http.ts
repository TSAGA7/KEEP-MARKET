// HTTP-утилиты: CORS по белому списку, JSON-ответы, безопасная обработка ошибок.
import { maskSensitive, publicErrorCode } from './domain/log.ts';
import { env } from './env.ts';

const ALLOWED_ORIGINS = (env('APP_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = ALLOWED_ORIGINS.length === 0 ? '' : ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] as string);
  return {
    ...(allow ? { 'Access-Control-Allow-Origin': allow } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: unknown) {
    super(code);
  }
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' },
  });
}

export async function readJson<T = unknown>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }
}

/** Ошибки Postgres → HTTP-код и безопасный код ошибки для клиента */
export function fromDbError(err: { message?: string; code?: string } | null | undefined): HttpError {
  const msg = err?.message ?? '';
  const code = publicErrorCode(msg);
  if (err?.code === '28000' || code === 'AUTH_REQUIRED') return new HttpError(401, 'AUTH_REQUIRED');
  if (err?.code === '42501' || code === 'FORBIDDEN') return new HttpError(403, code === 'INTERNAL_ERROR' ? 'FORBIDDEN' : code);
  if (err?.code === 'P0002') return new HttpError(404, code);
  if (err?.code === '22023' || msg.startsWith('VALIDATION')) return new HttpError(422, msg.startsWith('VALIDATION') ? msg.slice(0, 80) : code);
  if (err?.code === 'P0001') return new HttpError(409, code);
  return new HttpError(500, 'INTERNAL_ERROR');
}

type Handler = (req: Request) => Promise<Response>;

/** Обёртка: OPTIONS, только POST, перехват ошибок без утечки деталей. */
export function serve(name: string, handler: Handler, opts: { methods?: string[] } = {}) {
  const methods = opts.methods ?? ['POST'];
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (!methods.includes(req.method)) return json(req, { error: 'METHOD_NOT_ALLOWED' }, 405);
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status >= 500) console.error(`[${name}]`, e.code);
        return json(req, { error: e.code, ...(e.details ? { details: e.details } : {}) }, e.status);
      }
      console.error(`[${name}] unhandled`, maskSensitive({ message: (e as Error)?.message }));
      return json(req, { error: 'INTERNAL_ERROR' }, 500);
    }
  });
}
