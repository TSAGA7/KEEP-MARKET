-- KEEP MARKET · 0001 · Ядро: профили, роли, настройки, аудит, rate limit
-- Миграции рассчитаны на чистую базу Supabase (Postgres 15+). Без pgcrypto: gen_random_uuid() встроен.

create schema if not exists app;
comment on schema app is 'Внутренние вспомогательные функции KEEP MARKET (не публикуются через API)';

-- ---------------------------------------------------------------------------
-- Профили покупателей и сотрудников. Идентичность — только Telegram (initData проверяется на сервере).
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                uuid primary key default gen_random_uuid(),
  telegram_id       bigint not null unique,
  username          text,
  first_name        text,
  last_name         text,
  language_code     text,
  photo_url         text,
  -- Бот может писать пользователю только после того, как пользователь сам открыл бота
  bot_chat_id       bigint,
  bot_started_at    timestamptz,
  is_blocked        boolean not null default false,
  consent_pd_version text,
  consent_pd_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_login_at     timestamptz,
  constraint profiles_username_len check (username is null or char_length(username) <= 64)
);
comment on table public.profiles is 'Пользователи (покупатели и сотрудники), идентифицируются по Telegram ID';

-- ---------------------------------------------------------------------------
-- Роли. customer — неявная роль любого профиля. Сотруднические роли — только здесь.
-- ---------------------------------------------------------------------------
create table public.user_roles (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null check (role in ('owner', 'admin', 'manager')),
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);
-- Владелец может быть только один
create unique index user_roles_single_owner on public.user_roles ((true)) where role = 'owner';

-- ---------------------------------------------------------------------------
-- Проверка ролей. SECURITY DEFINER, чтобы использовать в RLS без рекурсии.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_id() returns uuid
language sql stable as $$ select auth.uid() $$;

create or replace function public.has_any_role(p_roles text[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id and not p.is_blocked
    where ur.user_id = auth.uid() and ur.role = any (p_roles)
  );
$$;

create or replace function public.is_owner() returns boolean
language sql stable as $$ select public.has_any_role(array['owner']) $$;
create or replace function public.is_admin() returns boolean
language sql stable as $$ select public.has_any_role(array['owner', 'admin']) $$;
create or replace function public.is_staff() returns boolean
language sql stable as $$ select public.has_any_role(array['owner', 'admin', 'manager']) $$;

create or replace function app.require_role(p_roles text[]) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not public.has_any_role(p_roles) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create or replace function app.require_user() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_blocked boolean;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  select is_blocked into v_blocked from public.profiles where id = auth.uid();
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = '28000'; end if;
  if v_blocked then raise exception 'USER_BLOCKED' using errcode = '42501'; end if;
  return auth.uid();
end $$;

-- Роли текущего пользователя (для интерфейса; права всё равно проверяются на сервере)
create or replace function public.my_roles() returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(role order by role), '{}') from public.user_roles where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Маскирование персональных данных
-- ---------------------------------------------------------------------------
create or replace function public.mask_phone(p text) returns text
language sql immutable as $$
  select case
    when p is null then null
    when length(regexp_replace(p, '\D', '', 'g')) < 6 then '***'
    else left(regexp_replace(p, '\D', '', 'g'), 2) || '*****' || right(regexp_replace(p, '\D', '', 'g'), 2)
  end
$$;

create or replace function public.mask_name(p text) returns text
language sql immutable as $$
  select case when p is null or p = '' then null else left(p, 1) || '***' end
$$;

-- ---------------------------------------------------------------------------
-- Журнал действий (только вставка через функцию, правка и удаление запрещены)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id         bigint generated always as identity primary key,
  actor_id   uuid references public.profiles(id) on delete set null,
  action     text not null,
  entity     text not null,
  entity_id  text,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs (entity, entity_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create or replace function app.audit(p_action text, p_entity text, p_entity_id text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function app.audit_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'AUDIT_LOG_IMMUTABLE' using errcode = '42501';
end $$;
create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function app.audit_immutable();

-- ---------------------------------------------------------------------------
-- Настройки магазина (ключ → значение). is_public = видно покупателям.
-- ---------------------------------------------------------------------------
create table public.store_settings (
  key        text primary key check (key ~ '^[a-z0-9_]+$'),
  value      jsonb not null,
  is_public  boolean not null default false,
  -- critical = менять может только владелец (безопасность, платежи, роли)
  is_critical boolean not null default false,
  description text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.store_settings (key, value, is_public, is_critical, description) values
  ('store_name', '"KEEP MARKET"', true, false, 'Название магазина'),
  ('telegram_channel_url', 'null', true, false, 'Ссылка на Telegram-канал магазина'),
  ('telegram_bot_username', 'null', true, false, 'Username бота без @ (для перехода к менеджеру)'),
  ('manager_contact_url', 'null', true, false, 'Резервная ссылка на менеджера (t.me/...)'),
  ('support_hours', '"Ежедневно 10:00–20:00 МСК"', true, false, 'Часы работы поддержки'),
  ('seller_info', '{"legal_name": null, "inn": null, "ogrn": null, "address": null, "email": null, "phone": null}', true, false, 'Реквизиты продавца — заполнить перед запуском'),
  ('stock_freshness_hours', '48', true, false, 'Через сколько часов остаток считается неактуальным'),
  ('order_min_qty', '1', true, false, 'Минимальное количество одной позиции'),
  ('order_max_qty', '10', true, false, 'Максимальное количество одной позиции'),
  ('order_max_lines', '30', true, false, 'Максимум позиций в заявке'),
  ('delivery_methods', '{"cdek_pickup": true, "cdek_courier": true, "ozon_pickup": true, "russian_post": true, "yandex_delivery": true, "keep_courier_moscow": true}', true, false, 'Включённые способы доставки (предпочтения покупателя)'),
  ('delivery_info', '"Стоимость и срок доставки менеджер согласует после проверки наличия у поставщика."', true, false, 'Текст о доставке в карточке товара'),
  ('return_policy', '"Возврат и обмен — в соответствии с Законом РФ «О защите прав потребителей» и правилами дистанционной торговли. Текст политики необходимо утвердить у юриста."', true, false, 'Условия возврата'),
  ('offer_text', 'null', true, false, 'Публичная оферта / пользовательское соглашение'),
  ('privacy_policy_text', 'null', true, false, 'Политика обработки персональных данных'),
  ('privacy_policy_version', '"draft-1"', true, false, 'Версия политики ПДн, на которую даётся согласие'),
  ('online_payment_enabled', 'false', true, true, 'Онлайн-оплата включена (только после подключения реального провайдера)'),
  ('payment_methods', '["manual_transfer", "cash_on_delivery"]', true, true, 'Способы расчёта, которые менеджер может согласовать'),
  ('require_payment_before_supplier', 'true', false, true, 'Передавать поставщику онлайн-заказ только после подтверждённой оплаты'),
  ('pd_retention_days', '1095', false, true, 'Срок хранения контактных данных закрытых заказов (дней)'),
  ('manager_chat_id', 'null', false, true, 'Telegram chat_id менеджеров для уведомлений о заявках'),
  ('admin_base_url', 'null', false, false, 'Публичный URL фронтенда для ссылок на карточку заявки');

create or replace function public.get_setting(p_key text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select value from public.store_settings where key = p_key
$$;

-- ---------------------------------------------------------------------------
-- Ограничение частоты запросов (используется Edge Functions через service role)
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);

create or replace function public.check_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into public.rate_limits (key, window_start, hits) values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;
  -- Подчищаем старые окна
  delete from public.rate_limits where window_start < now() - interval '1 day';
  return v_hits <= p_limit;
end $$;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

-- Защита от самостоятельного повышения прав: роли меняются только функциями ниже.
-- (Прямые INSERT/UPDATE/DELETE на user_roles для клиентов запрещены RLS и грантами.)

-- Первичное создание владельца — только service_role / SQL Editor, только если владельца ещё нет.
create or replace function public.bootstrap_owner(p_telegram_id bigint) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if exists (select 1 from public.user_roles where role = 'owner') then
    raise exception 'OWNER_ALREADY_EXISTS';
  end if;
  select id into v_id from public.profiles where telegram_id = p_telegram_id;
  if v_id is null then
    raise exception 'PROFILE_NOT_FOUND: владелец должен один раз открыть Mini App, чтобы создался профиль';
  end if;
  insert into public.user_roles (user_id, role) values (v_id, 'owner');
  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
    values (null, 'bootstrap_owner', 'user_roles', v_id::text, jsonb_build_object('telegram_id', p_telegram_id));
  return v_id;
end $$;

-- Назначение/снятие ролей сотрудникам.
-- owner: может выдавать admin и manager. admin: может выдавать только manager. Роль owner не выдаётся.
create or replace function public.staff_set_role(p_user_id uuid, p_role text, p_grant boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := app.require_role(array['owner', 'admin']);
begin
  if p_role not in ('admin', 'manager') then
    raise exception 'ROLE_NOT_ASSIGNABLE' using errcode = '42501';
  end if;
  if p_role = 'admin' and not public.is_owner() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id = v_actor then
    raise exception 'CANNOT_CHANGE_OWN_ROLES' using errcode = '42501';
  end if;
  if exists (select 1 from public.user_roles where user_id = p_user_id and role = 'owner') then
    raise exception 'CANNOT_CHANGE_OWNER' using errcode = '42501';
  end if;
  -- admin не может снять другого admin
  if not public.is_owner() and exists (select 1 from public.user_roles where user_id = p_user_id and role = 'admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_grant then
    insert into public.user_roles (user_id, role, granted_by) values (p_user_id, p_role, v_actor)
    on conflict do nothing;
  else
    delete from public.user_roles where user_id = p_user_id and role = p_role;
  end if;
  perform app.audit(case when p_grant then 'role_granted' else 'role_revoked' end, 'user_roles', p_user_id::text,
    jsonb_build_object('role', p_role));
end $$;
