// Только для локальной разработки вне Telegram: формирует initData, подписанную ТЕСТОВЫМ ботом.
// Результат кладётся в .env.local как VITE_DEV_INIT_DATA. Значение работает, пока не истечёт
// INIT_DATA_MAX_AGE_SECONDS на сервере. Никогда не используйте токен production-бота.
//   TELEGRAM_BOT_TOKEN=<токен тестового бота> node scripts/dev-init-data.mjs 123456789 username
import { webcrypto as crypto } from 'node:crypto';

const token = process.env.TELEGRAM_BOT_TOKEN;
const [id = '100000001', username = 'dev_user'] = process.argv.slice(2);
if (!token) { console.error('Нужен TELEGRAM_BOT_TOKEN тестового бота'); process.exit(1); }

const enc = new TextEncoder();
const hmac = async (key, data) => {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
};
const fields = {
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: 'DEV',
  user: JSON.stringify({ id: Number(id), first_name: 'Dev', username, language_code: 'ru' }),
};
const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
const secret = await hmac(enc.encode('WebAppData'), token);
const hash = Buffer.from(await hmac(secret, dcs)).toString('hex');
const params = new URLSearchParams({ ...fields, hash });
console.log(`VITE_DEV_INIT_DATA=${params.toString()}`);
