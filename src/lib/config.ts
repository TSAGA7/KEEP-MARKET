// Публичная конфигурация фронтенда. Здесь НЕТ секретов: anon key Supabase публичен по своей природе,
// доступ к данным ограничивает RLS. Service role key и токен бота во frontend не попадают никогда.
const env = import.meta.env;

export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? '',
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
  /** Разрешает страницу тестовой оплаты (только для development с PAYMENT_PROVIDER=mock на сервере) */
  enableMockPayment: env.VITE_ENABLE_MOCK_PAYMENT === 'true',
  /** initData для локальной разработки вне Telegram (подписывается скриптом scripts/dev-init-data.mjs тестовым ботом) */
  devInitData: env.DEV ? ((env.VITE_DEV_INIT_DATA as string | undefined) ?? '') : '',
  baseUrl: env.BASE_URL,
};

export const isConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey);

export function functionsUrl(name: string): string {
  return `${config.supabaseUrl}/functions/v1/${name}`;
}
