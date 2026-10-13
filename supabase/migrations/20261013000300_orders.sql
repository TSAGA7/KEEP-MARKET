-- KEEP MARKET · 0003 · Заявки, позиции, контакты, история статусов, отправления, платежи

-- ---------------------------------------------------------------------------
-- Заявки/заказы. Статус выполнения и статус оплаты хранятся раздельно.
-- ---------------------------------------------------------------------------
create table public.orders (
  id                     uuid primary key default gen_random_uuid(),
  number                 text not null unique,
  customer_id            uuid not null references public.profiles(id) on delete restrict,
  status                 text not null default 'new' check (status in (
                           'new', 'checking_availability', 'awaiting_customer_confirmation', 'confirmed',
                           'supplier_processing', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'issue')),
  payment_status         text not null default 'unpaid' check (payment_status in (
                           'unpaid', 'awaiting_payment', 'paid', 'partially_refunded', 'refunded')),
  -- Способ расчёта согласует менеджер после проверки наличия
  payment_method         text check (payment_method in ('online', 'manual_transfer', 'cash_on_delivery', 'other')),
  delivery_method        text not null check (delivery_method in (
                           'cdek_pickup', 'cdek_courier', 'ozon_pickup', 'russian_post', 'yandex_delivery', 'keep_courier_moscow')),
  items_total_kopecks    bigint not null check (items_total_kopecks >= 0),
  discount_kopecks       bigint not null default 0 check (discount_kopecks >= 0),
  delivery_kopecks       bigint check (delivery_kopecks is null or delivery_kopecks >= 0),
  total_kopecks          bigint not null check (total_kopecks >= 0),
  promo_code_id          uuid references public.promo_codes(id) on delete set null,
  customer_comment       text check (customer_comment is null or char_length(customer_comment) <= 1000),
  manager_notes          text,
  -- Результат проверки и согласованные условия (сроки, стоимость доставки, способ оплаты)
  agreed_terms           jsonb not null default '{}'::jsonb,
  requires_customer_confirmation boolean not null default false,
  customer_confirmed_at  timestamptz,
  cancel_reason          text,
  cancelled_by           uuid references public.profiles(id) on delete set null,
  issue_reason           text,
  -- Непрозрачный токен для deep link в бота (без персональных данных)
  telegram_token         text not null unique,
  idempotency_key        text not null check (char_length(idempotency_key) between 8 and 80),
  consent_version        text not null,
  assigned_manager_id    uuid references public.profiles(id) on delete set null,
  pd_purged_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (customer_id, idempotency_key),
  constraint orders_cancel_reason check (status <> 'cancelled' or cancel_reason is not null),
  -- Без подтверждённой оплаты статус paid невозможен — проверяется на уровне платежей ниже
  constraint orders_total_consistency check (total_kopecks = greatest(items_total_kopecks - discount_kopecks, 0) + coalesce(delivery_kopecks, 0))
);
create index orders_customer_idx on public.orders (customer_id, created_at desc);
create index orders_status_idx on public.orders (status, created_at desc);
create trigger orders_touch before update on public.orders for each row execute function app.touch_updated_at();

-- Контакты получателя: отдельная таблица, доступ сотрудников только через функцию с записью в журнал
create table public.order_contacts (
  order_id       uuid primary key references public.orders(id) on delete cascade,
  recipient_name text not null check (char_length(recipient_name) between 2 and 160),
  phone          text not null check (char_length(phone) between 6 and 32),
  email          text check (email is null or char_length(email) <= 160),
  address        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create table public.order_items (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id) on delete cascade,
  product_id           uuid references public.products(id) on delete set null,
  variant_id           uuid references public.product_variants(id) on delete set null,
  -- Снимок на момент заявки
  title_snapshot       text not null,
  product_sku_snapshot text not null,
  variant_sku_snapshot text not null,
  size                 text,
  color                text,
  image_url_snapshot   text,
  unit_price_kopecks   bigint not null check (unit_price_kopecks >= 0),
  original_unit_price_kopecks bigint not null check (original_unit_price_kopecks >= 0),
  price_change_reason  text,
  quantity             integer not null check (quantity between 1 and 100),
  line_total_kopecks   bigint generated always as (unit_price_kopecks * quantity) stored,
  stock_was_fresh      boolean not null default false,
  availability         text not null default 'unknown' check (availability in ('unknown', 'confirmed', 'unavailable', 'replacement_offered', 'waiting')),
  availability_note    text,
  created_at           timestamptz not null default now(),
  constraint order_items_price_reason check (unit_price_kopecks = original_unit_price_kopecks or price_change_reason is not null)
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_product_idx on public.order_items (product_id);

create table public.order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  from_status text,
  to_status   text not null,
  changed_by  uuid references public.profiles(id) on delete set null,
  reason      text,
  -- visible_to_customer=false — внутренние заметки
  visible_to_customer boolean not null default true,
  created_at  timestamptz not null default now()
);
create index order_status_history_order_idx on public.order_status_history (order_id, created_at);

create table public.shipments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  carrier         text not null check (carrier in ('cdek', 'ozon', 'russian_post', 'yandex', 'keep_courier', 'other')),
  tracking_number text check (tracking_number is null or tracking_number ~ '^[A-Za-z0-9-]{4,40}$'),
  status          text not null default 'created' check (status in ('created', 'handed_over', 'in_transit', 'delivered', 'returned', 'lost')),
  cost_kopecks    bigint check (cost_kopecks is null or cost_kopecks >= 0),
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  notes           text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index shipments_order_idx on public.shipments (order_id);
create trigger shipments_touch before update on public.shipments for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Платежи. Данные банковских карт не хранятся никогда.
-- ---------------------------------------------------------------------------
create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders(id) on delete restrict,
  provider            text not null check (provider ~ '^[a-z0-9_]+$'),
  provider_payment_id text,
  idempotency_key     text not null unique,
  amount_kopecks      bigint not null check (amount_kopecks > 0),
  currency            text not null default 'RUB' check (currency = 'RUB'),
  status              text not null default 'created' check (status in (
                        'created', 'pending', 'succeeded', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  refunded_kopecks    bigint not null default 0 check (refunded_kopecks >= 0),
  confirmation_url    text,
  failure_reason      text,
  is_test             boolean not null default false,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  paid_at             timestamptz,
  unique (provider, provider_payment_id),
  constraint payments_refund_le_amount check (refunded_kopecks <= amount_kopecks)
);
create index payments_order_idx on public.payments (order_id, created_at desc);
-- Не больше одного активного (неоплаченного) платежа на заказ
create unique index payments_one_active_per_order on public.payments (order_id) where status in ('created', 'pending');
create trigger payments_touch before update on public.payments for each row execute function app.touch_updated_at();

-- Входящие уведомления провайдера. UNIQUE(provider, event_key) — защита от повторной обработки.
create table public.payment_events (
  id            bigint generated always as identity primary key,
  provider      text not null,
  event_key     text not null,
  payment_id    uuid references public.payments(id) on delete set null,
  event_type    text not null,
  payload       jsonb not null default '{}'::jsonb,
  result        text,
  received_at   timestamptz not null default now(),
  unique (provider, event_key)
);
create index payment_events_payment_idx on public.payment_events (payment_id, received_at);

create table public.refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references public.payments(id) on delete restrict,
  order_id           uuid not null references public.orders(id) on delete restrict,
  amount_kopecks     bigint not null check (amount_kopecks > 0),
  reason             text not null check (char_length(reason) between 3 and 500),
  status             text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  provider_refund_id text,
  idempotency_key    text not null unique,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index refunds_payment_idx on public.refunds (payment_id);

-- ---------------------------------------------------------------------------
-- Допустимые переходы статусов заявки
-- ---------------------------------------------------------------------------
create or replace function public.order_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable as $$
  select case p_from
    when 'new' then p_to in ('checking_availability', 'cancelled', 'issue')
    when 'checking_availability' then p_to in ('awaiting_customer_confirmation', 'confirmed', 'cancelled', 'issue')
    when 'awaiting_customer_confirmation' then p_to in ('confirmed', 'checking_availability', 'cancelled', 'issue')
    when 'confirmed' then p_to in ('supplier_processing', 'awaiting_customer_confirmation', 'cancelled', 'issue')
    when 'supplier_processing' then p_to in ('ready_to_ship', 'cancelled', 'issue')
    when 'ready_to_ship' then p_to in ('shipped', 'cancelled', 'issue')
    when 'shipped' then p_to in ('delivered', 'issue')
    when 'delivered' then p_to in ('issue')
    when 'issue' then p_to in ('checking_availability', 'awaiting_customer_confirmation', 'confirmed',
                               'supplier_processing', 'ready_to_ship', 'shipped', 'delivered', 'cancelled')
    else false
  end
$$;

create or replace function app.orders_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'new' then raise exception 'ORDER_MUST_START_AS_NEW'; end if;
    if new.payment_status <> 'unpaid' then raise exception 'ORDER_MUST_START_UNPAID'; end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not public.order_transition_allowed(old.status, new.status) then
      raise exception 'INVALID_STATUS_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
    end if;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, reason)
      values (new.id, old.status, new.status, auth.uid(),
              case new.status when 'cancelled' then new.cancel_reason when 'issue' then new.issue_reason
                              else current_setting('app.status_reason', true) end);
  end if;

  -- Статус оплаты меняется только платёжными функциями (они выставляют app.payment_ctx)
  if new.payment_status is distinct from old.payment_status
     and coalesce(current_setting('app.payment_ctx', true), '') <> 'on' then
    raise exception 'PAYMENT_STATUS_IS_MANAGED_BY_PAYMENTS' using errcode = '42501';
  end if;
  -- Статус paid возможен только при наличии подтверждённого платежа на полную сумму
  if new.payment_status = 'paid' and not exists (
       select 1 from public.payments p
       where p.order_id = new.id and p.status in ('succeeded', 'partially_refunded') and p.amount_kopecks >= new.total_kopecks) then
    raise exception 'PAID_REQUIRES_SUCCEEDED_PAYMENT' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger orders_guard before insert or update on public.orders
  for each row execute function app.orders_guard();

create or replace function app.orders_after_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, reason)
    values (new.id, null, 'new', auth.uid(), 'Заявка создана');
  return new;
end $$;
create trigger orders_after_insert after insert on public.orders
  for each row execute function app.orders_after_insert();

-- Генерация номера и токена
create sequence public.order_number_seq start 1001;

create or replace function app.new_order_number() returns text language sql volatile as $$
  select 'KM-' || to_char(now() at time zone 'Europe/Moscow', 'YYMMDD') || '-' || lpad(nextval('public.order_number_seq')::text, 5, '0')
$$;

create or replace function app.random_token(p_len integer default 22) returns text language sql volatile as $$
  -- 2×UUIDv4 (≈244 бита случайности) → base62-подобная строка без спецсимволов
  select left(translate(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', 'xyz'), p_len)
$$;
