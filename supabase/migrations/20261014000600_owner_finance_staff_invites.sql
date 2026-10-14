-- KEEP MARKET · Финансы только владельцу, приглашение сотрудников по Telegram ID / @username

-- ---------------------------------------------------------------------------
-- 1. Финансы — только владелец
-- ---------------------------------------------------------------------------
create or replace function public.staff_dashboard() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb; v_is_admin boolean;
begin
  perform app.require_role(array['owner', 'admin', 'manager']);
  v_is_admin := public.is_owner();  -- деньги видит только владелец
  select jsonb_build_object(
    'orders_new', (select count(*) from public.orders where status = 'new'),
    'orders_checking', (select count(*) from public.orders where status = 'checking_availability'),
    'orders_awaiting_payment', (select count(*) from public.orders where status = 'awaiting_payment'),
    'orders_awaiting_shipment', (select count(*) from public.orders where status = 'awaiting_shipment'),
    'orders_shipped', (select count(*) from public.orders where status = 'shipped'),
    'orders_issue', (select count(*) from public.orders where status = 'issue'),
    'open_requests_amount_kopecks', (select coalesce(sum(total_kopecks), 0) from public.orders
                                      where status in ('new', 'checking_availability', 'awaiting_payment')),
    'products_published', (select count(*) from public.products where status = 'published')
  ) into v;
  if v_is_admin then
    v := v || jsonb_build_object(
      'paid_amount_kopecks', (select coalesce(sum(amount_kopecks), 0) from public.payments where status in ('succeeded', 'partially_refunded', 'refunded')),
      'refunded_amount_kopecks', (select coalesce(sum(refunded_kopecks), 0) from public.payments),
      'paid_orders_cost_kopecks', (select coalesce(sum(c.purchase_price_kopecks * oi.quantity), 0)
                                     from public.order_items oi
                                     join public.order_item_costs c on c.order_item_id = oi.id
                                     join public.orders o on o.id = oi.order_id
                                    where o.payment_status in ('paid', 'partially_refunded') and o.status <> 'cancelled'
                                      and oi.availability <> 'unavailable'),
      'paid_orders_logistics_kopecks', (select coalesce(sum(l.cost_kopecks), 0) from public.order_logistics_costs l
                                         join public.orders o on o.id = l.order_id
                                         where o.payment_status in ('paid', 'partially_refunded') and o.status <> 'cancelled'),
      'paid_orders_items_kopecks', (select coalesce(sum(o.items_total_kopecks - o.discount_kopecks), 0)
                                     from public.orders o where o.payment_status in ('paid', 'partially_refunded') and o.status <> 'cancelled'),
      'paid_orders_without_cost', (select count(distinct o.id) from public.orders o join public.order_items oi on oi.order_id = o.id
                                    left join public.order_item_costs c on c.order_item_id = oi.id
                                   where o.payment_status in ('paid', 'partially_refunded') and c.order_item_id is null)
    );
  end if;
  return v;
end $$;

drop policy if exists order_logistics_costs_admin_select on public.order_logistics_costs;
create policy order_logistics_costs_owner_select on public.order_logistics_costs for select to authenticated using (public.is_owner());

create or replace function public.staff_order_action(p_order_id uuid, p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := app.require_role(array['owner', 'admin', 'manager']);
  o public.orders;
  v jsonb := coalesce(p_payload, '{}'::jsonb);
  it jsonb;
  v_reason text := nullif(trim(coalesce(v->>'reason', '')), '');
  v_available_count integer;
  v_target text;
  v_new_price bigint;
  v_cost bigint;
  v_allowed_methods jsonb;
  v_notify text := null;  -- тип уведомления покупателю (обрабатывается Edge Function)
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;

  case p_action
  when 'start_check' then
    perform set_config('app.status_reason', 'Проверка наличия', true);
    update public.orders set status = 'checking_availability', assigned_manager_id = coalesce(assigned_manager_id, v_uid) where id = o.id;
    v_notify := 'checking';

  when 'record_availability' then
    if o.status not in ('new', 'checking_availability', 'issue') then
      raise exception 'INVALID_STATE' using errcode = 'P0001';
    end if;
    for it in select * from jsonb_array_elements(coalesce(v->'items', '[]'::jsonb)) loop
      if (it->>'availability') not in ('confirmed', 'unavailable', 'replacement_offered', 'waiting') then
        raise exception 'VALIDATION: availability' using errcode = '22023';
      end if;
      v_new_price := (it->>'new_unit_price_kopecks')::bigint;
      if v_new_price is not null then
        if v_new_price < 0 then raise exception 'VALIDATION: price' using errcode = '22023'; end if;
        if char_length(coalesce(trim(it->>'price_change_reason'), '')) < 3 then
          raise exception 'PRICE_CHANGE_REASON_REQUIRED' using errcode = '22023';
        end if;
      end if;
      update public.order_items oi
         set availability = it->>'availability',
             availability_note = nullif(left(trim(coalesce(it->>'note', '')), 500), ''),
             unit_price_kopecks = coalesce(v_new_price, oi.unit_price_kopecks),
             price_change_reason = case when v_new_price is not null and v_new_price <> oi.original_unit_price_kopecks
                                        then left(trim(it->>'price_change_reason'), 500) else oi.price_change_reason end
       where oi.id = (it->>'item_id')::uuid and oi.order_id = o.id;
      if not found then raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002'; end if;
    end loop;
    -- Позиции, которые менеджер не отметил, считаются в наличии
    update public.order_items set availability = 'confirmed' where order_id = o.id and availability = 'unknown';
    select count(*) into v_available_count from public.order_items where order_id = o.id and availability <> 'unavailable';
    if v_available_count = 0 then
      raise exception 'ALL_ITEMS_UNAVAILABLE_CANCEL_INSTEAD' using errcode = 'P0001';
    end if;
    if v ? 'delivery_kopecks' and v->>'delivery_kopecks' is not null then
      if (v->>'delivery_kopecks')::bigint < 0 then raise exception 'VALIDATION: delivery_kopecks' using errcode = '22023'; end if;
      update public.orders set delivery_kopecks = (v->>'delivery_kopecks')::bigint,
             total_kopecks = greatest(items_total_kopecks - discount_kopecks, 0) + (v->>'delivery_kopecks')::bigint
       where id = o.id;
    end if;
    update public.orders
       set agreed_terms = agreed_terms || jsonb_strip_nulls(jsonb_build_object(
             'checked_at', now(), 'checked_by', v_uid,
             'eta_text', nullif(left(trim(coalesce(v->>'eta_text', '')), 300), ''),
             'delivery_note', nullif(left(trim(coalesce(v->>'delivery_note', '')), 500), ''))),
           manager_notes = coalesce(nullif(trim(coalesce(v->>'manager_notes', '')), ''), manager_notes)
     where id = o.id;
    perform app.recalc_order_totals(o.id);
    if o.status = 'new' then
      perform set_config('app.status_reason', 'Проверка наличия', true);
      update public.orders set status = 'checking_availability', assigned_manager_id = coalesce(assigned_manager_id, v_uid) where id = o.id;
    end if;
    perform set_config('app.status_reason', 'Товар в наличии, заказ ожидает оплату', true);
    update public.orders set status = 'awaiting_payment', requires_customer_confirmation = false where id = o.id;
    v_notify := 'awaiting_payment';

  when 'set_payment_method' then
    if o.status in ('shipped', 'delivered', 'cancelled') then raise exception 'INVALID_STATE' using errcode = 'P0001'; end if;
    v_allowed_methods := coalesce(public.get_setting('payment_methods'), '[]'::jsonb);
    if coalesce((public.get_setting('online_payment_enabled') #>> '{}')::boolean, false) then
      v_allowed_methods := v_allowed_methods || '["online"]'::jsonb;
    end if;
    if not (v_allowed_methods ? (v->>'payment_method')) then
      raise exception 'PAYMENT_METHOD_NOT_ALLOWED' using errcode = '22023';
    end if;
    update public.orders set payment_method = v->>'payment_method',
           agreed_terms = agreed_terms || jsonb_build_object('payment_method', v->>'payment_method', 'payment_agreed_at', now())
     where id = o.id;
    v_notify := case when v->>'payment_method' = 'online' then 'payment_available' else null end;

  when 'await_shipment' then
    if o.status <> 'awaiting_payment' then raise exception 'INVALID_STATE' using errcode = 'P0001'; end if;
    if o.payment_method = 'online' and o.payment_status <> 'paid'
       and coalesce((public.get_setting('require_payment_before_supplier') #>> '{}')::boolean, true) then
      raise exception 'PAYMENT_REQUIRED_BEFORE_SUPPLIER' using errcode = 'P0001';
    end if;
    perform set_config('app.status_reason', 'Заказ ожидает отправку', true);
    update public.orders set status = 'awaiting_shipment' where id = o.id;
    v_notify := 'awaiting_shipment';

  when 'ship' then
    if (v->>'carrier') is null then raise exception 'CARRIER_REQUIRED' using errcode = '22023'; end if;
    v_cost := (v->>'cost_kopecks')::bigint;
    if v_cost is not null and v_cost < 0 then raise exception 'VALIDATION: cost_kopecks' using errcode = '22023'; end if;
    insert into public.shipments (order_id, carrier, tracking_number, status, cost_kopecks, shipped_at, notes, created_by)
    values (o.id, v->>'carrier', nullif(left(trim(coalesce(v->>'tracking_number', '')), 60), ''), 'handed_over',
            null, now(), nullif(left(trim(coalesce(v->>'notes', '')), 500), ''), v_uid);
    if v_cost is not null and public.is_owner() then
      perform app.set_logistics_cost(o.id, v_cost, v_uid);
    end if;
    perform set_config('app.status_reason', 'Заказ отправлен', true);
    update public.orders set status = 'shipped' where id = o.id;
    v_notify := 'shipped';

  when 'set_logistics_cost' then
    if not public.is_owner() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
    v_cost := (v->>'cost_kopecks')::bigint;
    if v_cost is not null and (v_cost < 0 or v_cost > 100000000) then raise exception 'VALIDATION: cost_kopecks' using errcode = '22023'; end if;
    perform app.set_logistics_cost(o.id, v_cost, v_uid);

  when 'set_tracking' then
    if char_length(coalesce(trim(v->>'tracking_number'), '')) < 1 then raise exception 'VALIDATION: tracking_number' using errcode = '22023'; end if;
    update public.shipments set tracking_number = trim(v->>'tracking_number')
     where id = coalesce((v->>'shipment_id')::uuid, (select id from public.shipments where order_id = o.id order by created_at desc limit 1))
       and order_id = o.id;
    if not found then raise exception 'SHIPMENT_NOT_FOUND' using errcode = 'P0002'; end if;
    v_notify := 'tracking';

  when 'deliver' then
    update public.shipments set status = 'delivered', delivered_at = now() where order_id = o.id and status <> 'delivered';
    perform set_config('app.status_reason', 'Заказ доставлен', true);
    update public.orders set status = 'delivered' where id = o.id;
    v_notify := 'delivered';

  when 'cancel' then
    if v_reason is null then raise exception 'REASON_REQUIRED' using errcode = '22023'; end if;
    if o.payment_status in ('paid', 'partially_refunded') then
      raise exception 'REFUND_REQUIRED_BEFORE_CANCEL' using errcode = 'P0001';
    end if;
    perform set_config('app.payment_ctx', 'on', true);
    update public.payments set status = 'cancelled', failure_reason = 'order_cancelled'
     where order_id = o.id and status in ('created', 'pending');
    update public.orders set status = 'cancelled', cancel_reason = left(v_reason, 500), cancelled_by = v_uid,
                             payment_status = case when payment_status = 'awaiting_payment' then 'unpaid' else payment_status end
     where id = o.id;
    v_notify := 'cancelled';

  when 'issue' then
    if v_reason is null then raise exception 'REASON_REQUIRED' using errcode = '22023'; end if;
    update public.orders set status = 'issue', issue_reason = left(v_reason, 500) where id = o.id;

  when 'resolve_issue' then
    v_target := v->>'target_status';
    if o.status <> 'issue' or v_target is null then raise exception 'INVALID_STATE' using errcode = 'P0001'; end if;
    if v_target = 'cancelled' then raise exception 'USE_CANCEL_ACTION' using errcode = 'P0001'; end if;
    perform set_config('app.status_reason', coalesce(v_reason, 'Проблема решена'), true);
    update public.orders set status = v_target, issue_reason = null where id = o.id;

  when 'add_note' then
    if v_reason is null then raise exception 'NOTE_REQUIRED' using errcode = '22023'; end if;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, reason, visible_to_customer)
    values (o.id, o.status, o.status, v_uid, left(v_reason, 1000), false);

  when 'assign_to_me' then
    update public.orders set assigned_manager_id = v_uid where id = o.id;

  else
    raise exception 'UNKNOWN_ACTION' using errcode = '22023';
  end case;

  perform app.audit('order_' || p_action, 'orders', o.id::text, v - 'reason' || jsonb_build_object('has_reason', v_reason is not null));
  select * into o from public.orders where id = p_order_id;
  return jsonb_build_object('ok', true, 'order_id', o.id, 'number', o.number, 'status', o.status,
                            'payment_status', o.payment_status, 'total_kopecks', o.total_kopecks, 'notify', v_notify);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Сотрудники: роль можно выдать по Telegram ID или @username, даже если человек ещё не открывал магазин.
--    Тогда создаётся приглашение — роль появится при первом входе.
-- ---------------------------------------------------------------------------
create table public.staff_invites (
  id           uuid primary key default gen_random_uuid(),
  telegram_id  bigint,
  username     text check (username is null or username ~ '^[A-Za-z0-9_]{4,64}$'),
  role         text not null check (role in ('admin', 'manager')),
  invited_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint staff_invites_ident check (telegram_id is not null or username is not null)
);
create unique index staff_invites_tg_role on public.staff_invites (telegram_id, role) where telegram_id is not null;
create unique index staff_invites_un_role on public.staff_invites (lower(username), role) where username is not null;
alter table public.staff_invites enable row level security;
revoke all on public.staff_invites from anon, authenticated;
grant select on public.staff_invites to authenticated;
grant all on public.staff_invites to service_role;
create policy staff_invites_admin_select on public.staff_invites for select to authenticated using (public.is_admin());

-- Выдать роль: p_ident — Telegram ID (цифры) или @username
create or replace function public.staff_invite(p_ident text, p_role text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := app.require_role(array['owner', 'admin']);
  v_ident text := trim(regexp_replace(coalesce(p_ident, ''), '^(https?://)?(t\.me/)?@?', '', 'i'));
  v_tg bigint;
  v_un text;
  v_user uuid;
begin
  if p_role not in ('admin', 'manager') then raise exception 'ROLE_NOT_ASSIGNABLE' using errcode = '42501'; end if;
  if p_role = 'admin' and not public.is_owner() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_ident ~ '^[0-9]{4,15}$' then
    v_tg := v_ident::bigint;
    select id into v_user from public.profiles where telegram_id = v_tg;
  elsif v_ident ~ '^[A-Za-z0-9_]{4,64}$' then
    v_un := v_ident;
    select id into v_user from public.profiles where lower(username) = lower(v_un) limit 1;
  else
    raise exception 'VALIDATION: staff_ident' using errcode = '22023';
  end if;

  if v_user is not null then
    perform public.staff_set_role(v_user, p_role, true);
    return jsonb_build_object('result', 'granted');
  end if;

  insert into public.staff_invites (telegram_id, username, role, invited_by) values (v_tg, v_un, p_role, v_actor)
  on conflict do nothing;
  perform app.audit('staff_invited', 'staff_invites', coalesce(v_tg::text, v_un), jsonb_build_object('role', p_role));
  return jsonb_build_object('result', 'invited');
end $$;

create or replace function public.staff_invite_cancel(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := app.require_role(array['owner', 'admin']); v_role text;
begin
  select role into v_role from public.staff_invites where id = p_id;
  if v_role = 'admin' and not public.is_owner() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  delete from public.staff_invites where id = p_id;
end $$;

revoke execute on function public.staff_invite(text, text), public.staff_invite_cancel(uuid) from public, anon;
grant execute on function public.staff_invite(text, text), public.staff_invite_cancel(uuid) to authenticated;

-- При входе (создании/обновлении профиля) приглашение превращается в роль
create or replace function app.profiles_apply_staff_invites() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare inv record;
begin
  for inv in
    select * from public.staff_invites
     where telegram_id = new.telegram_id
        or (new.username is not null and username is not null and lower(username) = lower(new.username))
  loop
    if not new.is_blocked and not exists (select 1 from public.user_roles where user_id = new.id and role = 'owner') then
      insert into public.user_roles (user_id, role, granted_by) values (new.id, inv.role, inv.invited_by) on conflict do nothing;
      insert into public.audit_logs (actor_id, action, entity, entity_id, details)
      values (inv.invited_by, 'role_granted', 'user_roles', new.id::text, jsonb_build_object('role', inv.role, 'via', 'invite'));
    end if;
    delete from public.staff_invites where id = inv.id;
  end loop;
  return new;
end $$;
create trigger profiles_apply_staff_invites after insert or update of telegram_id, username on public.profiles
  for each row execute function app.profiles_apply_staff_invites();
