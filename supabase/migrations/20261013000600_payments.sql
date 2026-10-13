-- KEEP MARKET · 0006 · Платежи: создаются только для подтверждённых заказов.
-- Статус «оплачено» выставляется исключительно по проверенному уведомлению провайдера
-- (или фиксацией офлайн-оплаты владельцем/администратором с записью в журнал).

create or replace function app.set_order_payment_status(p_order_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_paid bigint; v_refunded bigint; v_total bigint; v_active boolean; v_new text;
begin
  select coalesce(sum(amount_kopecks) filter (where status in ('succeeded', 'partially_refunded', 'refunded')), 0),
         coalesce(sum(refunded_kopecks) filter (where status in ('succeeded', 'partially_refunded', 'refunded')), 0),
         bool_or(status in ('created', 'pending'))
    into v_paid, v_refunded, v_active
    from public.payments where order_id = p_order_id;
  select total_kopecks into v_total from public.orders where id = p_order_id;
  v_new := case
    when v_paid > 0 and v_refunded >= v_paid then 'refunded'
    when v_paid > 0 and v_refunded > 0 then 'partially_refunded'
    when v_paid >= v_total and v_paid > 0 then 'paid'
    when coalesce(v_active, false) then 'awaiting_payment'
    else 'unpaid'
  end;
  perform set_config('app.payment_ctx', 'on', true);
  update public.orders set payment_status = v_new where id = p_order_id and payment_status is distinct from v_new;
  perform set_config('app.payment_ctx', 'off', true);
end $$;

-- Покупатель запрашивает онлайн-оплату своего подтверждённого заказа.
-- Вызывается ТОЛЬКО Edge Function (service_role) после проверки JWT покупателя:
-- флаг тестового режима не должен быть доступен клиенту.
create or replace function public.customer_payment_prepare(p_customer_id uuid, p_order_id uuid, p_provider text, p_allow_test boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := p_customer_id;
  o public.orders;
  pay public.payments;
begin
  select * into o from public.orders where id = p_order_id and customer_id = v_uid for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('confirmed', 'supplier_processing', 'ready_to_ship') then
    raise exception 'ORDER_NOT_CONFIRMED' using errcode = 'P0001';
  end if;
  if o.payment_method is distinct from 'online' then raise exception 'ONLINE_PAYMENT_NOT_AGREED' using errcode = 'P0001'; end if;
  if not coalesce((public.get_setting('online_payment_enabled') #>> '{}')::boolean, false) and not p_allow_test then
    raise exception 'ONLINE_PAYMENT_DISABLED' using errcode = 'P0001';
  end if;
  if o.payment_status in ('paid', 'partially_refunded', 'refunded') then raise exception 'ALREADY_PAID' using errcode = 'P0001'; end if;
  if o.delivery_kopecks is null then raise exception 'DELIVERY_COST_NOT_AGREED' using errcode = 'P0001'; end if;
  if o.total_kopecks <= 0 then raise exception 'NOTHING_TO_PAY' using errcode = 'P0001'; end if;

  -- Уже есть активный платёж на ту же сумму — возвращаем его (идемпотентность)
  select * into pay from public.payments where order_id = o.id and status in ('created', 'pending');
  if found then
    if pay.amount_kopecks = o.total_kopecks and pay.provider = p_provider then
      return jsonb_build_object('payment_id', pay.id, 'idempotency_key', pay.idempotency_key, 'amount_kopecks', pay.amount_kopecks,
                                'confirmation_url', pay.confirmation_url, 'provider_payment_id', pay.provider_payment_id,
                                'order_number', o.number, 'reused', true);
    end if;
    -- Сумма изменилась — старый платёж отменяется
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

-- После ответа провайдера (только service_role)
create or replace function public.payment_attach_provider(p_payment_id uuid, p_provider_payment_id text, p_confirmation_url text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.payments
     set provider_payment_id = p_provider_payment_id, confirmation_url = p_confirmation_url,
         status = case when status = 'created' then 'pending' else status end
   where id = p_payment_id;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
end $$;

create or replace function public.payment_mark_failed_to_create(p_payment_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order uuid;
begin
  update public.payments set status = 'failed', failure_reason = left(p_reason, 300)
   where id = p_payment_id and status = 'created' returning order_id into v_order;
  if v_order is not null then perform app.set_order_payment_status(v_order); end if;
end $$;

-- Обработка проверенного уведомления провайдера (только service_role). Идемпотентно.
create or replace function public.payment_apply_event(
  p_provider text, p_event_key text, p_provider_payment_id text, p_event_type text,
  p_status text, p_amount_kopecks bigint, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event_id bigint;
  pay public.payments;
  v_result text;
begin
  if p_status not in ('pending', 'succeeded', 'failed', 'cancelled') then
    raise exception 'VALIDATION: status';
  end if;
  insert into public.payment_events (provider, event_key, event_type, payload)
  values (p_provider, p_event_key, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, event_key) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  select * into pay from public.payments
   where provider = p_provider and provider_payment_id = p_provider_payment_id for update;
  if not found then
    update public.payment_events set result = 'payment_not_found' where id = v_event_id;
    return jsonb_build_object('result', 'payment_not_found');
  end if;
  update public.payment_events set payment_id = pay.id where id = v_event_id;

  if p_status = 'succeeded' and p_amount_kopecks is distinct from pay.amount_kopecks then
    v_result := 'amount_mismatch';
    update public.orders set status = 'issue', issue_reason = 'Сумма оплаты не совпадает с платежом — проверить вручную'
     where id = pay.order_id and status <> 'issue' and public.order_transition_allowed(status, 'issue');
  elsif pay.status = p_status then
    v_result := 'no_change';
  elsif pay.status in ('succeeded', 'refunded', 'partially_refunded') then
    -- Успешный платёж не может откатиться в pending/failed из-за запоздавшего уведомления
    v_result := 'ignored_regression';
  elsif p_status = 'succeeded' then
    perform set_config('app.payment_ctx', 'on', true);
    update public.payments set status = 'succeeded', paid_at = now(), failure_reason = null where id = pay.id;
    v_result := case when pay.status in ('failed', 'cancelled') then 'late_success' else 'succeeded' end;
    if v_result = 'late_success' then
      update public.orders set status = 'issue', issue_reason = 'Оплата пришла после отмены платежа — проверить'
       where id = pay.order_id and public.order_transition_allowed(status, 'issue');
    end if;
  elsif p_status in ('failed', 'cancelled') then
    update public.payments set status = p_status, failure_reason = coalesce(p_payload->>'reason', p_status) where id = pay.id;
    v_result := p_status;
  else
    update public.payments set status = 'pending' where id = pay.id and status = 'created';
    v_result := 'pending';
  end if;

  perform app.set_order_payment_status(pay.order_id);
  update public.payment_events set result = v_result where id = v_event_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (null, 'payment_event', 'payments', pay.id::text,
          jsonb_build_object('provider', p_provider, 'event_type', p_event_type, 'result', v_result, 'order_id', pay.order_id));
  return jsonb_build_object('result', v_result, 'payment_id', pay.id, 'order_id', pay.order_id);
end $$;

-- ---------------------------------------------------------------------------
-- Возвраты (owner/admin)
-- ---------------------------------------------------------------------------
create or replace function public.staff_refund_prepare(p_payment_id uuid, p_amount_kopecks bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := app.require_role(array['owner', 'admin']);
  pay public.payments;
  v_pending bigint;
  rf public.refunds;
begin
  select * into pay from public.payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if pay.status not in ('succeeded', 'partially_refunded') then raise exception 'PAYMENT_NOT_REFUNDABLE' using errcode = 'P0001'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'REASON_REQUIRED' using errcode = '22023'; end if;
  select coalesce(sum(amount_kopecks), 0) into v_pending from public.refunds where payment_id = pay.id and status = 'pending';
  if p_amount_kopecks is null or p_amount_kopecks <= 0 or p_amount_kopecks > pay.amount_kopecks - pay.refunded_kopecks - v_pending then
    raise exception 'REFUND_AMOUNT_INVALID' using errcode = '22023';
  end if;
  insert into public.refunds (payment_id, order_id, amount_kopecks, reason, idempotency_key, created_by)
  values (pay.id, pay.order_id, p_amount_kopecks, left(trim(p_reason), 500), 'ref_' || app.random_token(28), v_uid)
  returning * into rf;
  perform app.audit('refund_requested', 'refunds', rf.id::text, jsonb_build_object('payment_id', pay.id, 'amount_kopecks', p_amount_kopecks));
  return jsonb_build_object('refund_id', rf.id, 'idempotency_key', rf.idempotency_key, 'provider', pay.provider,
                            'provider_payment_id', pay.provider_payment_id, 'amount_kopecks', rf.amount_kopecks, 'order_id', pay.order_id);
end $$;

-- Результат возврата от провайдера (service_role) или ручной возврат (provider = manual)
create or replace function public.refund_apply_result(p_refund_id uuid, p_status text, p_provider_refund_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare rf public.refunds; pay public.payments;
begin
  if p_status not in ('succeeded', 'failed') then raise exception 'VALIDATION: status'; end if;
  select * into rf from public.refunds where id = p_refund_id for update;
  if not found then raise exception 'REFUND_NOT_FOUND'; end if;
  if rf.status <> 'pending' then return jsonb_build_object('result', 'already_processed', 'status', rf.status); end if;
  update public.refunds set status = p_status, provider_refund_id = p_provider_refund_id, updated_at = now() where id = rf.id;
  if p_status = 'succeeded' then
    select * into pay from public.payments where id = rf.payment_id for update;
    update public.payments
       set refunded_kopecks = refunded_kopecks + rf.amount_kopecks,
           status = case when refunded_kopecks + rf.amount_kopecks >= amount_kopecks then 'refunded' else 'partially_refunded' end
     where id = pay.id;
    perform app.set_order_payment_status(rf.order_id);
  end if;
  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'refund_' || p_status, 'refunds', rf.id::text, jsonb_build_object('amount_kopecks', rf.amount_kopecks));
  return jsonb_build_object('result', p_status, 'order_id', rf.order_id);
end $$;

-- Фиксация фактической офлайн-оплаты (перевод/наложенный платёж) — owner/admin, с журналом
create or replace function public.staff_register_offline_payment(p_order_id uuid, p_amount_kopecks bigint, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := app.require_role(array['owner', 'admin']); o public.orders; pay public.payments;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status in ('new', 'checking_availability', 'awaiting_customer_confirmation', 'cancelled') then
    raise exception 'ORDER_NOT_CONFIRMED' using errcode = 'P0001';
  end if;
  if o.payment_method not in ('manual_transfer', 'cash_on_delivery', 'other') then
    raise exception 'OFFLINE_PAYMENT_NOT_AGREED' using errcode = 'P0001';
  end if;
  if char_length(coalesce(trim(p_note), '')) < 3 then raise exception 'NOTE_REQUIRED' using errcode = '22023'; end if;
  if p_amount_kopecks is null or p_amount_kopecks <= 0 then raise exception 'AMOUNT_INVALID' using errcode = '22023'; end if;
  perform set_config('app.payment_ctx', 'on', true);
  insert into public.payments (order_id, provider, provider_payment_id, idempotency_key, amount_kopecks, status, paid_at, created_by, failure_reason)
  values (o.id, 'manual', 'manual_' || app.random_token(16), 'man_' || app.random_token(28), p_amount_kopecks, 'succeeded', now(), v_uid, null)
  returning * into pay;
  perform app.set_order_payment_status(o.id);
  perform app.audit('offline_payment_registered', 'payments', pay.id::text,
                    jsonb_build_object('order_id', o.id, 'amount_kopecks', p_amount_kopecks, 'note', left(p_note, 300)));
  return jsonb_build_object('payment_id', pay.id, 'payment_status', (select payment_status from public.orders where id = o.id));
end $$;
