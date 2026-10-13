-- KEEP MARKET · 0010 · Диалог покупателя с менеджером через бота
-- Сообщения покупателя бот пересылает в закрытый чат менеджеров; ответ менеджера (reply) — обратно покупателю.
-- Таблица доступна только service_role (Edge Function telegram-bot).

create table public.bot_relay_messages (
  id                  bigint generated always as identity primary key,
  manager_chat_id     bigint not null,
  manager_message_id  bigint not null,
  customer_chat_id    bigint not null,
  customer_id         uuid references public.profiles(id) on delete cascade,
  order_id            uuid references public.orders(id) on delete set null,
  created_at          timestamptz not null default now(),
  unique (manager_chat_id, manager_message_id)
);
alter table public.bot_relay_messages enable row level security;
revoke all on public.bot_relay_messages from anon, authenticated;
grant all on public.bot_relay_messages to service_role;

-- Привязка диалога к заявке по непрозрачному токену из deep link (без персональных данных в ссылке)
create or replace function public.bot_link_order(p_telegram_id bigint, p_chat_id bigint, p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_profile uuid; o public.orders;
begin
  select id into v_profile from public.profiles where telegram_id = p_telegram_id;
  if v_profile is null then return jsonb_build_object('result', 'no_profile'); end if;
  update public.profiles set bot_chat_id = p_chat_id, bot_started_at = coalesce(bot_started_at, now()) where id = v_profile;
  if p_token is null or p_token !~ '^[A-Za-z0-9]{10,40}$' then return jsonb_build_object('result', 'linked'); end if;
  select * into o from public.orders where telegram_token = p_token and customer_id = v_profile;
  if not found then return jsonb_build_object('result', 'order_not_found'); end if;
  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (v_profile, 'bot_dialog_opened', 'orders', o.id::text, '{}'::jsonb);
  return jsonb_build_object('result', 'order_linked', 'order_id', o.id, 'number', o.number, 'status', o.status);
end $$;
revoke execute on function public.bot_link_order(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.bot_link_order(bigint, bigint, text) to service_role;

-- Очистка старых связок сообщений (вызывается вместе с purge_expired_personal_data)
create or replace function public.purge_bot_relay(p_days integer default 90) returns integer
language sql security definer set search_path = public, pg_temp as $$
  with d as (delete from public.bot_relay_messages where created_at < now() - make_interval(days => p_days) returning 1)
  select count(*)::integer from d
$$;
revoke execute on function public.purge_bot_relay(integer) from public, anon, authenticated;
grant execute on function public.purge_bot_relay(integer) to service_role;
