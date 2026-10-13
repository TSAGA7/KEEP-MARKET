// Переменные окружения Edge Functions (задаются через `supabase secrets set`, НИКОГДА не во frontend).
export function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`CONFIG_MISSING_${name}`);
  return v;
}

export const APP_ENV = env('APP_ENV') ?? 'production';
export const IS_PRODUCTION = APP_ENV === 'production';

export function allPaymentEnv() {
  return {
    APP_ENV,
    PAYMENT_PROVIDER: env('PAYMENT_PROVIDER'),
    MOCK_PAYMENT_SECRET: env('MOCK_PAYMENT_SECRET'),
    MOCK_CHECKOUT_URL: env('MOCK_CHECKOUT_URL'),
    YOOKASSA_SHOP_ID: env('YOOKASSA_SHOP_ID'),
    YOOKASSA_SECRET_KEY: env('YOOKASSA_SECRET_KEY'),
    YOOKASSA_SEND_RECEIPT: env('YOOKASSA_SEND_RECEIPT'),
    YOOKASSA_VAT_CODE: env('YOOKASSA_VAT_CODE'),
    YOOKASSA_ALLOWED_IPS: env('YOOKASSA_ALLOWED_IPS'),
  };
}
