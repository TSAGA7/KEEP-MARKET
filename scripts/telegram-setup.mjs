// Настройка бота: webhook (с секретом), кнопка меню «Открыть магазин», список команд.
// Запуск локально (токен НЕ сохраняется в репозиторий):
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... SUPABASE_URL=https://xxx.supabase.co APP_PUBLIC_URL=https://user.github.io/KEEP-MARKET/ node scripts/telegram-setup.mjs
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, SUPABASE_URL: supabaseUrl, APP_PUBLIC_URL: appUrl } = process.env;
if (!token || !secret || !supabaseUrl || !appUrl) {
  console.error('Нужны переменные: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SUPABASE_URL, APP_PUBLIC_URL');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
  console.error('TELEGRAM_WEBHOOK_SECRET: 32–256 символов A-Z, a-z, 0-9, _ и -');
  process.exit(1);
}
if (!appUrl.startsWith('https://')) {
  console.error('APP_PUBLIC_URL должен начинаться с https:// (требование Telegram для Mini App)');
  process.exit(1);
}

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log(`${method}: ${data.ok ? 'ok' : `ошибка — ${data.description}`}`);
  if (!data.ok) process.exitCode = 1;
  return data;
}

await call('setWebhook', {
  url: `${supabaseUrl.replace(/\/$/, '')}/functions/v1/telegram-bot`,
  secret_token: secret,
  allowed_updates: ['message'],
  drop_pending_updates: true,
});
await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Магазин', web_app: { url: appUrl } } });
await call('setMyCommands', {
  commands: [
    { command: 'shop', description: 'Открыть магазин' },
    { command: 'orders', description: 'Мои заказы' },
    { command: 'manager', description: 'Написать менеджеру' },
    { command: 'help', description: 'Поддержка' },
  ],
});
await call('setMyDescription', { description: 'KEEP MARKET — одежда, обувь, сумки и аксессуары независимых брендов. Оформление заказа и связь с менеджером.' });
const me = await call('getMe', {});
if (me.ok) console.log(`Бот @${me.result.username} настроен. Mini App: ${appUrl}`);
