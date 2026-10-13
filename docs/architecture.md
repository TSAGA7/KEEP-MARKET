# Архитектура и бизнес-процессы

## Сценарий заказа

```
Покупатель                       Сервер (Supabase)                             Менеджер
──────────                       ─────────────────                             ────────
корзина (localStorage)
«Оформить заказ» → доставка,
получатель, проверка состава,
согласие на ПДн, «Заказать» ──► create-order: Zod, rate limit
                                create_order_request():
                                 • варианты существуют, активны, товар проверен
                                 • цены из БД, сравнение с ожидаемыми
                                 • остаток > 0 и ≥ количества (не резервируется)
                                 • идемпотентность по ключу
                                 • снимок названий/цен, контакты отдельно
                                 → заявка KM-ГГММДД-NNNNN: new / unpaid ─────► уведомление в чат менеджеров
◄── номер, ссылка t.me/<бот>?start=order_<токен>                               (номер, кол-во, сумма, ссылка)
Telegram-диалог (бот пересылает сообщения в чат менеджеров, ответы — обратно)
                                                                               «Начать проверку наличия»
                                                                               «Зафиксировать результат»:
                                                                                по позициям: в наличии / нет /
                                                                                замена / ожидание; цена — только
                                                                                с причиной; стоимость доставки
                                 изменились условия → awaiting_customer_confirmation
◄── уведомление «подтвердите» ──
«Подтвердить заказ» ───────────► confirmed
                                                                               «Согласовать способ оплаты»
                                 online → кнопка «Оплатить онлайн» у покупателя
                                 перевод / при получении → фиксация оплаты owner/admin
                                                                               «Передать поставщику»
                                                                               (online — только после paid)
                                                                               → ready_to_ship → «Отправить»
◄── уведомление с трек-номером ── shipped → delivered                          (трек-номер)
```

Если товара нет: позиция помечается «Нет в наличии», сумма пересчитывается, деньги не списываются, фиктивных
возвратов нет. Если недоступно всё — заявка отменяется с причиной.

## Статусы

Заявка: `new → checking_availability → awaiting_customer_confirmation ⇄ confirmed → supplier_processing →
ready_to_ship → shipped → delivered`, плюс `cancelled` (терминальный) и `issue` (из любого рабочего статуса,
возврат через «Решить проблему»). Матрица переходов — `order_transition_allowed()` в БД; тест сверяет её с
`supabase/functions/_shared/domain/orders.ts`.

Оплата (`orders.payment_status`): `unpaid → awaiting_payment → paid → partially_refunded / refunded`.
Детали платежей — `payments` (`created/pending/succeeded/failed/cancelled/refunded/partially_refunded`),
уведомления — `payment_events` с `UNIQUE(provider, event_key)`.

## Роли и доступ

| Действие | owner | admin | manager | customer |
|---|---|---|---|---|
| Каталог: создание/редактирование/публикация | ✓ | ✓ | просмотр | — |
| Закупочные цены, маржа | ✓ | ✓ | — | — |
| Юридическая проверка товара | ✓ | если разрешено настройкой | — | — |
| Поставщики, импорт прайсов, откат импорта | ✓ | ✓ | просмотр поставщиков | — |
| Заявки: проверка наличия, согласование, отправка | ✓ | ✓ | ✓ | — |
| Контакты получателя (с журналом) | ✓ | ✓ | ✓ | свои |
| Возвраты, фиксация офлайн-оплаты | ✓ | ✓ | — | — |
| Назначение ролей | admin, manager | manager | — | — |
| Критичные настройки (платежи, ПДн, чат менеджеров) | ✓ | — | — | — |
| Журнал действий | ✓ | ✓ | — | — |

## Модель данных (основное)

`profiles`, `user_roles`, `categories`, `products`, `product_costs`, `product_variants`, `product_images`,
`suppliers`, `supplier_offers`, `supplier_imports`, `supplier_import_rows`, `orders`, `order_contacts`,
`order_items`, `order_item_costs`, `order_status_history`, `shipments`, `payments`, `payment_events`, `refunds`,
`favorites`, `promo_codes`, `homepage_banners`, `collections`, `collection_products`, `compliance_reviews`,
`private_documents`, `audit_logs`, `store_settings`, `rate_limits`, `bot_relay_messages`.

Деньги — `bigint` в копейках. Идентификаторы — UUID. Заказы хранят снимок названия, артикула, варианта, цены,
количества и себестоимости на момент заявки.

## Безопасность

- RLS включён на всех таблицах; гранты выданы явно (миграция 0008), остальное отозвано.
- Секреты (service role, токен бота, JWT secret, ключи провайдера) — только в секретах Edge Functions.
- Ограничение частоты: `check_rate_limit` (вход, заявки, платежи, webhook).
- Ошибки клиенту — только коды (`publicErrorCode`), без SQL и ПДн; логи маскируются (`maskSensitive`).
- XSS: текст из БД выводится как текст (React экранирует), HTML не рендерится; CSP в production-сборке.
- Загрузка файлов: сигнатура (magic bytes) + размер на клиенте, MIME и лимит размера бакета + RLS на сервере.
- Журнал аудита неизменяем (триггер запрещает UPDATE/DELETE).
