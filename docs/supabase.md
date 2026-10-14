# Настройка Supabase

## 1. Проект

1. Создайте проект на supabase.com (регион — ближайший к покупателям; учтите требования 152-ФЗ о локализации
   ПДн граждан РФ — см. [compliance.md](compliance.md)).
2. Settings → API: сохраните `Project URL`, `anon public key`, `service_role key` (секрет!) и **JWT Secret**.
   - Edge Function `auth-telegram` подписывает токены алгоритмом HS256 секретом `APP_JWT_SECRET`, и PostgREST должен
     принимать их. Используйте JWT Secret проекта (Legacy JWT secret). Если проект переведён на асимметричные
     JWT Signing Keys, добавьте в них общий секрет (shared secret, HS256) и укажите его как `APP_JWT_SECRET`.
     Проверьте вход после настройки: без этого RLS не узнает пользователя.
3. Authentication → Providers: e-mail регистрация не нужна (вход — только через Telegram).

## 2. Миграции (контролируемо, не из CI)

```bash
supabase login
supabase link --project-ref <ref>
supabase db push --dry-run     # посмотреть, что будет применено
supabase db push               # применить миграции из supabase/migrations
```

Демо-данные: `supabase/seed.sql` применяйте **только на тестовом проекте** (SQL Editor). В production — не применять
либо удалить: `delete from products where is_demo; delete from homepage_banners where is_demo; delete from collections where is_demo;`

Миграции рассчитаны на чистую базу. Новые изменения — только новыми файлами миграций, с проверкой на копии базы.
Если добавляете таблицы, повторите для них блок грантов и `enable row level security` из `0008_rls.sql`.

## 3. Секреты и функции

```bash
cp supabase/functions/.env.example supabase/functions/.env   # заполнить; файл в .gitignore
supabase secrets set --env-file supabase/functions/.env
supabase functions deploy auth-telegram create-order order-action payment-create payment-webhook payment-refund telegram-bot photo-kick
# payment-mock-simulate — только на тестовом проекте с APP_ENV=development
```

Обязательные секреты: `APP_ENV=production`, `APP_PUBLIC_URL`, `APP_ORIGINS`, `APP_JWT_SECRET`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_APP_SHORT_NAME` (рекомендуется), `PAYMENT_PROVIDER`.
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` платформа передаёт функциям сама.

Все функции настроены с `verify_jwt = false`: каждая сама проверяет доступ (свой JWT, подпись Telegram или провайдера).

## 4. Storage

Миграция `0009` создаёт бакеты:
- `product-images` — публичное чтение, запись только owner/admin, JPEG/PNG/WebP/AVIF до 5 МБ;
- `private-documents` — приватный, только owner/admin, PDF/JPEG/PNG до 20 МБ, выдача по подписанным ссылкам на 2 минуты.

## 5. Хранение ПДн по расписанию

Database → Extensions → включите `pg_cron`, затем в SQL Editor:

```sql
select cron.schedule('km-purge-pd', '30 3 * * *', $$select public.purge_expired_personal_data(); select public.purge_bot_relay(90);$$);
```

Срок хранения — настройка `pd_retention_days` (по умолчанию 1095 дней), утвердите его в политике обработки ПДн.

## 6. Проверка

```sql
select public.bootstrap_owner(<ваш telegram id>);   -- см. docs/admin.md
select count(*) from public.catalog_products;      -- витрина
```
