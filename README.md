# KEEP MARKET — Telegram Mini App

Магазин одежды, обуви, сумок и аксессуаров независимых брендов и легальных аналогов. Модель — дропшиппинг:
поставщик вручную подтверждает наличие и отправляет заказ. Покупатель оформляет **заявку без оплаты**,
менеджер проверяет наличие, согласует доставку и способ оплаты; онлайн-оплата доступна только для
подтверждённого заказа и только после подключения реального провайдера.

## Архитектура

```
Telegram (бот + Mini App)
        │ initData (подписан Telegram)
        ▼
GitHub Pages ── статический React-фронтенд (без секретов и бизнес-логики)
        │ HTTPS
        ▼
Supabase
 ├─ Edge Functions (Deno, секреты только здесь)
 │   auth-telegram ─ проверка подписи initData → JWT пользователя
 │   create-order ─ Zod-валидация → SQL create_order_request → уведомление менеджерам
 │   order-action ─ действия менеджера/покупателя → уведомления в бот
 │   payment-create / payment-webhook / payment-refund / payment-mock-simulate
 │   telegram-bot ─ webhook бота: /start по заявке, диалог покупатель ↔ менеджеры
 ├─ Postgres: таблицы + RLS + SECURITY DEFINER-функции (пересчёт цен, переходы статусов, роли, аудит)
 └─ Storage: product-images (публичный), private-documents (только owner/admin)
```

Ключевые решения:

- **Идентичность — только Telegram.** Сервер проверяет HMAC-подпись `initData` токеном бота и свежесть `auth_date`,
  затем выпускает JWT (`sub = profiles.id`). `initDataUnsafe` не используется для авторизации.
- **Все проверки на сервере.** Цена, наличие, допустимость варианта, лимиты количества, переходы статусов,
  роли — в SQL-функциях. Клиентские суммы — только «ожидаемые», при расхождении покупатель видит обновлённую корзину.
- **Заявка ≠ оплата.** «Заказать» создаёт заявку `new / unpaid`. Статус оплаты хранится отдельно и меняется
  только платёжными функциями; `paid` невозможен без подтверждённого платежа на полную сумму (ограничение в триггере).
- **Роли:** `owner` (один, создаётся только bootstrap-функцией), `admin`, `manager`, `customer` (любой профиль).
  Права проверяются в базе, а не скрытием кнопок.
- **Персональные данные** — в отдельной таблице `order_contacts`: покупатель видит свои, сотрудники — только через
  функцию `staff_get_order_contact`, каждый просмотр пишется в журнал. Уведомления менеджерам — без ПДн.
- **Закупочные цены** — в `product_costs`, `supplier_offers`, `order_item_costs`: только owner/admin.
  Публичный каталог — через представления `catalog_*` без внутренних полей.
- **Юридическая проверка ассортимента:** товар публикуется и заказывается только при `compliance_status = approved`
  и `trademark_review_status = approved`; одобрение — функцией проверки с обязательным чек-листом.

Подробнее: [docs/architecture.md](docs/architecture.md).

## Дерево проекта

```
├─ src/                         React + TS (Vite, Tailwind, Router, TanStack Query, RHF, Zod)
│  ├─ pages/                    Главная, Каталог, Товар, Корзина, Оформление, Заказы, Профиль, Документы
│  ├─ admin/                    Панель /admin: 15 разделов (pages/*), api.ts, ui.tsx
│  ├─ components/               UI-кит, иконки, карточки, раскладка, тосты
│  └─ lib/                      config, supabase, session (вход через Telegram), cart, api, telegram
├─ supabase/
│  ├─ migrations/               0001 ядро · 0002 каталог · 0003 заказы · 0004 витрина · 0005 заказ-RPC
│  │                            0006 платежи · 0007 админ · 0008 RLS · 0009 Storage · 0010 бот
│  ├─ functions/                Edge Functions + _shared/domain (общий код с фронтендом)
│  ├─ seed.sql                  демо-данные (помечены is_demo, без заказов и платежей)
│  └─ config.toml
├─ tests/
│  ├─ db/                       интеграционные тесты SQL/RLS на настоящем Postgres (PGlite)
│  ├─ unit/                     initData, JWT, платежи, корзина, доставка, CSV, статусы
│  └─ e2e/                      сценарий в браузере (Playwright) на мобильном экране
├─ scripts/                     postbuild (SPA для Pages), telegram-setup, dev-init-data, demo-изображения
├─ docs/                        инструкции
└─ .github/workflows/           deploy.yml (Pages), ci.yml (проверки PR)
```

## Локальный запуск

Требования: Node 20+, [Supabase CLI](https://supabase.com/docs/guides/cli), Docker (для локального Supabase).

```bash
npm install
supabase start                         # локальный Postgres + API, применит миграции и seed.sql
cp .env.example .env.local             # VITE_SUPABASE_URL=http://127.0.0.1:54321, anon key из `supabase status`
cp supabase/functions/.env.example supabase/functions/.env   # заполнить (тестовый бот, APP_JWT_SECRET = JWT secret из `supabase status`)
supabase functions serve --env-file supabase/functions/.env
npm run dev                            # http://localhost:5173
```

Вне Telegram каталог работает как гость. Чтобы войти локально, создайте **тестового** бота и сгенерируйте
`initData`: `TELEGRAM_BOT_TOKEN=<тестовый> npm run dev:init-data -- 123456789 myname` → строку положите в
`.env.local` как `VITE_DEV_INIT_DATA` (работает только в `npm run dev`).

Тесты:

```bash
npm test            # unit + интеграционные тесты БД (миграции применяются к встроенному Postgres 16)
npm run test:e2e    # браузерный сценарий (нужны Playwright и Chromium)
npm run typecheck
```

## Публикация

1. **Supabase** — проект, миграции, секреты, функции: [docs/supabase.md](docs/supabase.md).
2. **Telegram** — бот, Mini App, webhook, чат менеджеров: [docs/telegram.md](docs/telegram.md).
3. **GitHub Pages** — автодеплой после push в `main`: [docs/deploy.md](docs/deploy.md).
4. **Владелец и сотрудники**: [docs/admin.md](docs/admin.md).
5. **Оплата** (после проверки провайдера): [docs/payments.md](docs/payments.md).
6. **Юридическая модель, ПДн, документы**: [docs/compliance.md](docs/compliance.md).

## Что осталось настроить вручную

См. [docs/manual-steps.md](docs/manual-steps.md) — чек-лист запуска и известные ограничения.
