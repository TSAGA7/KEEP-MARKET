-- KEEP MARKET · Упрощённый путь заказа, расходы на доставку, наличие без «срока проверки»
--
-- Путь заказа: Ожидает подтверждения менеджера (new) → Проверка наличия → Ожидает оплату → Ожидает отправку
--              → Отправлено → Доставлено. Отдельно: Отменено, Проблема.
-- Убраны этапы «ждём подтверждения покупателя», «подтверждён», «передан поставщику», «готов к отправке».
-- Магазин продаёт как собственный товар: покупателю нигде не сообщается о поставщиках.

-- ---------------------------------------------------------------------------
-- 1. Статусы: перенос старых заказов на новые этапы
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders disable trigger orders_guard;
update public.orders set status = 'awaiting_payment'  where status in ('awaiting_customer_confirmation', 'confirmed');
update public.orders set status = 'awaiting_shipment' where status in ('supplier_processing', 'ready_to_ship');
alter table public.orders enable trigger orders_guard;
alter table public.orders add constraint orders_status_check check (status in (
  'new', 'checking_availability', 'awaiting_payment', 'awaiting_shipment', 'shipped', 'delivered', 'cancelled', 'issue'));

-- История: старые этапы показываем новыми названиями, тексты без упоминаний поставщика
update public.order_status_history set to_status = 'awaiting_payment' where to_status in ('awaiting_customer_confirmation', 'confirmed');
update public.order_status_history set to_status = 'awaiting_shipment' where to_status in ('supplier_processing', 'ready_to_ship');
update public.order_status_history set from_status = 'awaiting_payment' where from_status in ('awaiting_customer_confirmation', 'confirmed');
update public.order_status_history set from_status = 'awaiting_shipment' where from_status in ('supplier_processing', 'ready_to_ship');
update public.order_status_history set reason = 'Проверка наличия' where reason = 'Менеджер проверяет наличие у поставщика';
update public.order_status_history set reason = 'Заказ ожидает отправку' where reason in ('Заказ передан поставщику', 'Заказ готов к отправке');

create or replace function public.order_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable as $$
  select case p_from
    when 'new' then p_to in ('checking_availability', 'awaiting_payment', 'cancelled', 'issue')
    when 'checking_availability' then p_to in ('awaiting_payment', 'cancelled', 'issue')
    when 'awaiting_payment' then p_to in ('awaiting_shipment', 'checking_availability', 'cancelled', 'issue')
    when 'awaiting_shipment' then p_to in ('shipped', 'cancelled', 'issue')
    when 'shipped' then p_to in ('delivered', 'issue')
    when 'delivered' then p_to in ('issue')
    when 'issue' then p_to in ('checking_availability', 'awaiting_payment', 'awaiting_shipment', 'shipped', 'delivered', 'cancelled')
    else false
  end
$$;

-- Оплата получена → заказ сам переходит в «Ожидает отправку»
create or replace function app.orders_paid_autoadvance() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' and new.status = 'awaiting_payment' then
    new.status := 'awaiting_shipment';
    perform set_config('app.status_reason', 'Оплата получена', true);
  end if;
  return new;
end $$;
-- Имя «orders_0_…» — срабатывает раньше orders_guard, который проверит переход и запишет историю
drop trigger if exists orders_0_paid_autoadvance on public.orders;
create trigger orders_0_paid_autoadvance before update of payment_status on public.orders
  for each row execute function app.orders_paid_autoadvance();

-- ---------------------------------------------------------------------------
-- 2. Расходы на доставку (курьер и т.п.) — необязательные, учитываются в разнице с закупкой
-- ---------------------------------------------------------------------------
-- Отдельная таблица: покупатель видит свой заказ целиком (select *), а наши расходы ему показывать нельзя
create table public.order_logistics_costs (
  order_id       uuid primary key references public.orders(id) on delete cascade,
  cost_kopecks   bigint not null check (cost_kopecks >= 0 and cost_kopecks <= 100000000),
  updated_by     uuid references public.profiles(id) on delete set null,
  updated_at     timestamptz not null default now()
);
alter table public.order_logistics_costs enable row level security;
revoke all on public.order_logistics_costs from anon, authenticated;
grant select on public.order_logistics_costs to authenticated;
grant all on public.order_logistics_costs to service_role;
create policy order_logistics_costs_admin_select on public.order_logistics_costs for select to authenticated using (public.is_admin());

-- Расходы, которые раньше записывались в отправление (видно покупателю), переносим и стираем
insert into public.order_logistics_costs (order_id, cost_kopecks)
  select order_id, sum(cost_kopecks) from public.shipments where cost_kopecks is not null group by order_id
  on conflict (order_id) do nothing;
update public.shipments set cost_kopecks = null where cost_kopecks is not null;

create or replace function app.set_logistics_cost(p_order_id uuid, p_cost bigint, p_by uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_cost is null then
    delete from public.order_logistics_costs where order_id = p_order_id;
  else
    insert into public.order_logistics_costs (order_id, cost_kopecks, updated_by) values (p_order_id, p_cost, p_by)
    on conflict (order_id) do update set cost_kopecks = excluded.cost_kopecks, updated_by = excluded.updated_by, updated_at = now();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Действия менеджера
-- ---------------------------------------------------------------------------
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
    values (o.id, v->>'carrier', nullif(trim(coalesce(v->>'tracking_number', '')), ''), 'handed_over',
            null, now(), nullif(left(trim(coalesce(v->>'notes', '')), 500), ''), v_uid);
    if v_cost is not null and public.is_admin() then
      perform app.set_logistics_cost(o.id, v_cost, v_uid);
    end if;
    perform set_config('app.status_reason', 'Заказ отправлен', true);
    update public.orders set status = 'shipped' where id = o.id;
    v_notify := 'shipped';

  when 'set_logistics_cost' then
    if not public.is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
    v_cost := (v->>'cost_kopecks')::bigint;
    if v_cost is not null and (v_cost < 0 or v_cost > 100000000) then raise exception 'VALIDATION: cost_kopecks' using errcode = '22023'; end if;
    perform app.set_logistics_cost(o.id, v_cost, v_uid);

  when 'set_tracking' then
    if char_length(coalesce(trim(v->>'tracking_number'), '')) < 4 then raise exception 'VALIDATION: tracking_number' using errcode = '22023'; end if;
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
-- 4. Покупатель: отмена и оплата по новым этапам
-- ---------------------------------------------------------------------------
create or replace function public.customer_cancel_order(p_order_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := app.require_user(); o public.orders;
begin
  select * into o from public.orders where id = p_order_id and customer_id = v_uid for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('new', 'checking_availability', 'awaiting_payment') then
    raise exception 'CANNOT_CANCEL_IN_THIS_STATE' using errcode = 'P0001';
  end if;
  if o.payment_status <> 'unpaid' then
    raise exception 'CONTACT_MANAGER_TO_CANCEL_PAID_ORDER' using errcode = 'P0001';
  end if;
  update public.orders set status = 'cancelled', cancel_reason = 'Отменено покупателем: ' || left(coalesce(nullif(trim(p_reason), ''), 'без комментария'), 300),
                           cancelled_by = v_uid
   where id = p_order_id;
  perform app.audit('customer_cancelled', 'orders', p_order_id::text, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'status', 'cancelled');
end $$;

create or replace function public.customer_payment_prepare(p_customer_id uuid, p_order_id uuid, p_provider text, p_allow_test boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := p_customer_id;
  o public.orders;
  pay public.payments;
begin
  select * into o from public.orders where id = p_order_id and customer_id = v_uid for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('awaiting_payment', 'awaiting_shipment') then
    raise exception 'ORDER_NOT_CONFIRMED' using errcode = 'P0001';
  end if;
  if o.payment_method is distinct from 'online' then raise exception 'ONLINE_PAYMENT_NOT_AGREED' using errcode = 'P0001'; end if;
  if not coalesce((public.get_setting('online_payment_enabled') #>> '{}')::boolean, false) and not p_allow_test then
    raise exception 'ONLINE_PAYMENT_DISABLED' using errcode = 'P0001';
  end if;
  if o.payment_status in ('paid', 'partially_refunded', 'refunded') then raise exception 'ALREADY_PAID' using errcode = 'P0001'; end if;
  if o.delivery_kopecks is null then raise exception 'DELIVERY_COST_NOT_AGREED' using errcode = 'P0001'; end if;
  if o.total_kopecks <= 0 then raise exception 'NOTHING_TO_PAY' using errcode = 'P0001'; end if;

  select * into pay from public.payments where order_id = o.id and status in ('created', 'pending');
  if found then
    if pay.amount_kopecks = o.total_kopecks and pay.provider = p_provider then
      return jsonb_build_object('payment_id', pay.id, 'idempotency_key', pay.idempotency_key, 'amount_kopecks', pay.amount_kopecks,
                                'confirmation_url', pay.confirmation_url, 'provider_payment_id', pay.provider_payment_id,
                                'order_number', o.number, 'reused', true);
    end if;
    perform set_config('app.payment_ctx', 'on', true);
    update public.payments set status = 'cancelled', failure_reason = 'superseded' where id = pay.id;
  end if;

  insert into public.payments (order_id, provider, idempotency_key, amount_kopecks, status, is_test, created_by)
  values (o.id, p_provider, 'pay_' || app.random_token(28), o.total_kopecks, 'created', p_allow_test, v_uid)
  returning * into pay;
  perform app.set_order_payment_status(o.id);
  perform app.audit('payment_created', 'payments', pay.id::text,
                    jsonb_build_object('order_id', o.id, 'amount_kopecks', pay.amount_kopecks, 'provider', p_provider, 'test', p_allow_test));
  return jsonb_build_object('payment_id', pay.id, 'idempotency_key', pay.idempotency_key, 'amount_kopecks', pay.amount_kopecks,
                            'confirmation_url', null, 'provider_payment_id', null, 'order_number', o.number, 'reused', false);
end $$;

create or replace function public.staff_register_offline_payment(p_order_id uuid, p_amount_kopecks bigint, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := app.require_role(array['owner', 'admin']); o public.orders; pay public.payments;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status in ('new', 'cancelled') then
    raise exception 'ORDER_NOT_CONFIRMED' using errcode = 'P0001';
  end if;
  if o.payment_method = 'online' then
    raise exception 'OFFLINE_PAYMENT_NOT_AGREED' using errcode = 'P0001';
  end if;
  if char_length(coalesce(trim(p_note), '')) < 3 then raise exception 'NOTE_REQUIRED' using errcode = '22023'; end if;
  if p_amount_kopecks is null or p_amount_kopecks <= 0 then raise exception 'AMOUNT_INVALID' using errcode = '22023'; end if;
  if o.payment_method is null then
    update public.orders set payment_method = 'manual_transfer' where id = o.id;
  end if;
  perform set_config('app.payment_ctx', 'on', true);
  insert into public.payments (order_id, provider, provider_payment_id, idempotency_key, amount_kopecks, status, paid_at, created_by, failure_reason)
  values (o.id, 'manual', 'manual_' || app.random_token(16), 'man_' || app.random_token(28), p_amount_kopecks, 'succeeded', now(), v_uid, null)
  returning * into pay;
  perform app.set_order_payment_status(o.id);
  perform app.audit('offline_payment_registered', 'payments', pay.id::text,
                    jsonb_build_object('order_id', o.id, 'amount_kopecks', p_amount_kopecks, 'note', left(p_note, 300)));
  return jsonb_build_object('payment_id', pay.id, 'payment_status', (select payment_status from public.orders where id = o.id));
end $$;

-- ---------------------------------------------------------------------------
-- 5. Наличие: есть остаток — «В наличии», без срока давности проверки
-- ---------------------------------------------------------------------------
create or replace function app.stock_state(p_qty integer, p_confirmed_at timestamptz) returns text
language sql stable as $$
  select case when p_qty <= 0 then 'out_of_stock' else 'in_stock' end
$$;

-- ---------------------------------------------------------------------------
-- 6. Панель управления: новые этапы, расходы на доставку
-- ---------------------------------------------------------------------------
create or replace function public.staff_dashboard() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb; v_is_admin boolean;
begin
  perform app.require_role(array['owner', 'admin', 'manager']);
  v_is_admin := public.is_admin();
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

-- ---------------------------------------------------------------------------
-- 7. Тексты для покупателя и контакт менеджера
-- ---------------------------------------------------------------------------
update public.store_settings set value = '"Стоимость и срок доставки менеджер сообщит после подтверждения заказа."'
 where key = 'delivery_info' and value #>> '{}' ilike '%поставщик%';
update public.store_settings set value = '"https://t.me/keep_admin"'
 where key = 'manager_contact_url' and (value is null or value = 'null'::jsonb or value #>> '{}' = '');
update public.store_settings set description = 'Онлайн-заказ переходит в «Ожидает отправку» только после подтверждённой оплаты'
 where key = 'require_payment_before_supplier';
