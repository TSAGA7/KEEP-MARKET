# Развёртывание frontend на GitHub Pages

1. Репозиторий → Settings → Pages → Source: **GitHub Actions**.
2. Settings → Secrets and variables → Actions → **Variables** (это публичные значения, не секреты):
   - `VITE_SUPABASE_URL` — `https://<ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` — anon public key
   - `VITE_BASE_PATH` — необязательно; по умолчанию `/<имя репозитория>/` (для `KEEP-MARKET` — `/KEEP-MARKET/`)
3. Push в `main` → workflow `Deploy frontend to GitHub Pages`: typecheck → тесты → сборка → публикация.
   Адрес: `https://<user>.github.io/KEEP-MARKET/`.
4. В секретах Supabase укажите `APP_PUBLIC_URL` и `APP_ORIGINS` с этим адресом (origin — `https://<user>.github.io`).

Маршрутизация: React Router с `basename = BASE_URL`; `scripts/postbuild.mjs` копирует `index.html` в `404.html`,
поэтому прямые ссылки (`/product/...`, `/admin/orders/...`) открываются и после обновления страницы.

Service role key и токен бота в Pages **не попадают**: сборка использует только `VITE_*` переменные.

## Миграции и Edge Functions

Не деплоятся автоматически. Порядок релиза backend:

```bash
supabase db push --dry-run   # проверить
supabase db push             # применить (сначала на тестовом проекте)
supabase functions deploy <имена>
```

## Свой домен (при необходимости)

1. DNS: CNAME `shop.example.ru → <user>.github.io`.
2. Settings → Pages → Custom domain, включить «Enforce HTTPS».
3. `VITE_BASE_PATH=/` (переменная Actions), пересобрать.
4. Обновить URL Mini App в @BotFather, `APP_PUBLIC_URL`/`APP_ORIGINS` в Supabase, `npm run telegram:setup`.
