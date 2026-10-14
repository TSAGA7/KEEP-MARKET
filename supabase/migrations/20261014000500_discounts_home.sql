-- KEEP MARKET · Скидки в %, настройка главной страницы, оформление без галочки согласия

-- ---------------------------------------------------------------------------
-- 1. Скидка на товар (0–90 %). Цена со скидкой считается на сервере — и в витрине, и при оформлении заказа
-- ---------------------------------------------------------------------------
alter table public.products add column if not exists discount_percent integer not null default 0
  check (discount_percent between 0 and 90);

-- Округление до целого рубля
create or replace function app.discounted_price(p_price bigint, p_percent integer) returns bigint
language sql immutable as $$
  select case when coalesce(p_percent, 0) <= 0 or p_price is null then p_price
              else (round(p_price * (100 - p_percent) / 100.0 / 100.0) * 100)::bigint end
$$;

create or replace view public.catalog_variants as
  select v.id, v.product_id, v.sku, v.size, v.color, v.color_hex,
         app.discounted_price(coalesce(v.price_override_kopecks, p.price_kopecks), p.discount_percent) as price_kopecks,
         v.stock_qty, v.stock_confirmed_at, v.min_qty, v.max_qty, v.sort_order,
         app.stock_state(v.stock_qty, v.stock_confirmed_at) as stock_state,
         case when p.discount_percent > 0 then coalesce(v.price_override_kopecks, p.price_kopecks) end as old_price_kopecks,
         p.discount_percent
  from public.product_variants v
  join public.products p on p.id = v.product_id
  where v.is_active and app.product_is_sellable(p);

create or replace view public.catalog_products as
  select p.id, p.slug, p.title, p.description, p.category_id,
         c.slug as category_slug, c.name as category_name,
         p.brand_name, p.sku, app.discounted_price(p.price_kopecks, p.discount_percent) as price_kopecks,
         app.discounted_price(coalesce(agg.min_price, p.price_kopecks), p.discount_percent) as min_price_kopecks,
         app.discounted_price(coalesce(agg.max_price, p.price_kopecks), p.discount_percent) as max_price_kopecks,
         p.materials, p.care, p.size_chart, p.origin_description,
         p.is_featured, p.is_demo, p.published_at, p.created_at,
         (select coalesce(i.url, 'storage:' || i.storage_path) from public.product_images i
            where i.product_id = p.id order by i.sort_order, i.created_at limit 1) as cover_ref,
         coalesce(agg.total_stock, 0) as total_stock,
         agg.last_confirmed_at as stock_confirmed_at,
         case
           when coalesce(agg.fresh_stock, 0) > 0 then 'in_stock'
           when coalesce(agg.total_stock, 0) > 0 then 'needs_confirmation'
           else 'out_of_stock'
         end as stock_state,
         coalesce(agg.sizes, '{}') as sizes,
         coalesce(agg.colors, '{}') as colors,
         p.discount_percent,
         case when p.discount_percent > 0 then coalesce(agg.min_price, p.price_kopecks) end as old_min_price_kopecks
  from public.products p
  left join public.categories c on c.id = p.category_id
  left join lateral (
    select min(coalesce(v.price_override_kopecks, p.price_kopecks)) as min_price,
           max(coalesce(v.price_override_kopecks, p.price_kopecks)) as max_price,
           sum(v.stock_qty)::integer as total_stock,
           sum(case when app.stock_state(v.stock_qty, v.stock_confirmed_at) = 'in_stock' then v.stock_qty else 0 end)::integer as fresh_stock,
           max(v.stock_confirmed_at) as last_confirmed_at,
           array_remove(array_agg(distinct v.size), null) as sizes,
           array_remove(array_agg(distinct v.color), null) as colors
    from public.product_variants v
    where v.product_id = p.id and v.is_active
  ) agg on true
  where app.product_is_sellable(p) and (c.id is null or c.is_active);

-- ---------------------------------------------------------------------------
-- 2. Главная страница: какие категории показывать и какие блоки
-- ---------------------------------------------------------------------------
alter table public.categories add column if not exists show_on_home boolean not null default true;

create or replace view public.catalog_categories as
  select c.id, c.parent_id, c.name, c.slug, c.sort_order, c.show_on_home
  from public.categories c
  where c.is_active;

insert into public.store_settings (key, value, is_public, is_critical, description) values
  ('home_sections', '{"in_stock": true, "new": true, "popular": true, "collections": true}', true, false,
   'Блоки главной страницы: in_stock — случайные товары в наличии, new — новые поступления, popular — популярное, collections — подборки')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Оформление заказа: согласие подтверждается нажатием «Заказать» (текст под кнопкой со ссылками
--    на политику и оферту). Сервер по-прежнему записывает версию политики в профиль.
-- ---------------------------------------------------------------------------
create or replace function public.create_order_request(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := app.require_user();
  v_key text := p->>'idempotency_key';
  v_existing public.orders;
  v_item jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_problems jsonb := '[]'::jsonb;
  v_items_total bigint := 0;
  v_discount bigint := 0;
  v_promo public.promo_codes;
  v_order_id uuid := gen_random_uuid();
  v_number text;
  v_token text;
  v_delivery_err text;
  v_method text := p->>'delivery_method';
  v_contact jsonb := coalesce(p->'contact', '{}'::jsonb);
  v_phone_digits text;
  v_max_lines integer := coalesce((public.get_setting('order_max_lines') #>> '{}')::integer, 30);
  v_setting_max integer := coalesce((public.get_setting('order_max_qty') #>> '{}')::integer, 10);
  v_count integer := 0;
  r record;
  v_qty integer;
  v_expected bigint;
  v_price bigint;
begin
  if v_key is null or char_length(v_key) < 8 or char_length(v_key) > 80 then
    raise exception 'VALIDATION: idempotency_key' using errcode = '22023';
  end if;

  -- Идемпотентность: повторная отправка возвращает уже созданную заявку
  select * into v_existing from public.orders where customer_id = v_uid and idempotency_key = v_key;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', v_existing.id, 'number', v_existing.number,
      'telegram_token', v_existing.telegram_token, 'total_kopecks', v_existing.total_kopecks,
      'items_count', (select coalesce(sum(quantity), 0) from public.order_items where order_id = v_existing.id));
  end if;

  if coalesce((p->>'consent_pd')::boolean, false) is not true then
    raise exception 'VALIDATION: consent_pd' using errcode = '22023';
  end if;

  if v_method is null or coalesce((public.get_setting('delivery_methods') ->> v_method)::boolean, false) is not true then
    raise exception 'VALIDATION: delivery_method' using errcode = '22023';
  end if;
  v_delivery_err := app.validate_delivery(v_method, p->'address');
  if v_delivery_err is not null then
    raise exception 'VALIDATION: %', v_delivery_err using errcode = '22023';
  end if;

  if char_length(coalesce(trim(v_contact->>'recipient_name'), '')) < 2 then
    raise exception 'VALIDATION: recipient_name' using errcode = '22023';
  end if;
  v_phone_digits := regexp_replace(coalesce(v_contact->>'phone', ''), '\D', '', 'g');
  if char_length(v_phone_digits) < 10 or char_length(v_phone_digits) > 15 then
    raise exception 'VALIDATION: phone' using errcode = '22023';
  end if;
  if coalesce(v_contact->>'email', '') <> '' and (v_contact->>'email') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'VALIDATION: email' using errcode = '22023';
  end if;

  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'VALIDATION: items_empty' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'items') > v_max_lines then
    raise exception 'VALIDATION: too_many_lines' using errcode = '22023';
  end if;

  -- Схлопываем дубликаты вариантов
  for v_item in
    select jsonb_build_object('variant_id', x->>'variant_id', 'quantity', sum((x->>'quantity')::integer),
                              'expected_unit_price_kopecks', max((x->>'expected_unit_price_kopecks')::bigint))
    from jsonb_array_elements(p->'items') x
    group by x->>'variant_id'
  loop
    v_count := v_count + 1;
    v_qty := (v_item->>'quantity')::integer;
    v_expected := (v_item->>'expected_unit_price_kopecks')::bigint;

    select v.id as variant_id, v.sku as variant_sku, v.size, v.color, v.stock_qty, v.stock_confirmed_at,
           v.min_qty, least(v.max_qty, v_setting_max) as max_qty, v.is_active,
           app.discounted_price(coalesce(v.price_override_kopecks, pr.price_kopecks), pr.discount_percent) as price,
           pr.id as product_id, pr.title, pr.sku as product_sku, pr.slug,
           app.product_is_sellable(pr) as sellable,
           (select coalesce(i.url, 'storage:' || i.storage_path) from public.product_images i
              where i.product_id = pr.id order by i.sort_order limit 1) as image_ref
      into r
      from public.product_variants v join public.products pr on pr.id = v.product_id
     where v.id = (v_item->>'variant_id')::uuid;

    if not found or not r.is_active or not r.sellable then
      v_problems := v_problems || jsonb_build_object('variant_id', v_item->>'variant_id', 'code', 'UNAVAILABLE');
      continue;
    end if;
    v_price := r.price;
    if r.stock_qty <= 0 then
      v_problems := v_problems || jsonb_build_object('variant_id', r.variant_id, 'code', 'OUT_OF_STOCK');
    elsif v_qty is null or v_qty < r.min_qty or v_qty > r.max_qty then
      v_problems := v_problems || jsonb_build_object('variant_id', r.variant_id, 'code', 'QTY_INVALID',
                                                     'min_qty', r.min_qty, 'max_qty', r.max_qty);
    elsif v_qty > r.stock_qty then
      v_problems := v_problems || jsonb_build_object('variant_id', r.variant_id, 'code', 'INSUFFICIENT_STOCK', 'available', r.stock_qty);
    end if;
    if v_expected is distinct from v_price then
      v_problems := v_problems || jsonb_build_object('variant_id', r.variant_id, 'code', 'PRICE_CHANGED',
                                                     'expected', v_expected, 'actual', v_price);
    end if;

    v_lines := v_lines || jsonb_build_object(
      'variant_id', r.variant_id, 'product_id', r.product_id, 'title', r.title, 'slug', r.slug,
      'product_sku', r.product_sku, 'variant_sku', r.variant_sku, 'size', r.size, 'color', r.color,
      'image_ref', r.image_ref, 'unit_price_kopecks', v_price, 'quantity', v_qty,
      'stock_state', app.stock_state(r.stock_qty, r.stock_confirmed_at), 'stock_qty', r.stock_qty);
    v_items_total := v_items_total + v_price * coalesce(v_qty, 0);
  end loop;

  -- Есть расхождения — заявку не создаём, возвращаем пересчитанную корзину для подтверждения покупателем
  if jsonb_array_length(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'problems', v_problems, 'lines', v_lines, 'items_total_kopecks', v_items_total);
  end if;

  -- Промокод
  if coalesce(trim(p->>'promo_code'), '') <> '' then
    select * into v_promo from public.promo_codes
     where code = upper(trim(p->>'promo_code')) and is_active
       and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
       and (max_uses is null or used_count < max_uses)
     for update;
    if not found or v_items_total < v_promo.min_order_kopecks then
      return jsonb_build_object('ok', false, 'problems', jsonb_build_array(jsonb_build_object('code', 'PROMO_INVALID')),
                                'lines', v_lines, 'items_total_kopecks', v_items_total);
    end if;
    v_discount := case v_promo.kind when 'percent' then (v_items_total * v_promo.value) / 100 else least(v_promo.value, v_items_total) end;
    update public.promo_codes set used_count = used_count + 1 where id = v_promo.id;
  end if;

  v_number := app.new_order_number();
  v_token := app.random_token(22);

  insert into public.orders (id, number, customer_id, delivery_method, items_total_kopecks, discount_kopecks,
                             delivery_kopecks, total_kopecks, promo_code_id, customer_comment, telegram_token,
                             idempotency_key, consent_version)
  values (v_order_id, v_number, v_uid, v_method, v_items_total, v_discount, null,
          greatest(v_items_total - v_discount, 0), v_promo.id, nullif(left(trim(coalesce(p->>'comment', '')), 1000), ''),
          v_token, v_key, coalesce(public.get_setting('privacy_policy_version') #>> '{}', 'unknown'));

  insert into public.order_contacts (order_id, recipient_name, phone, email, address)
  values (v_order_id, left(trim(v_contact->>'recipient_name'), 160), '+' || v_phone_digits,
          nullif(trim(coalesce(v_contact->>'email', '')), ''), coalesce(p->'address', '{}'::jsonb) - 'passport' - 'passport_number');

  insert into public.order_items (order_id, product_id, variant_id, title_snapshot, product_sku_snapshot, variant_sku_snapshot,
                                  size, color, image_url_snapshot, unit_price_kopecks, original_unit_price_kopecks, quantity, stock_was_fresh)
  select v_order_id, (l->>'product_id')::uuid, (l->>'variant_id')::uuid, l->>'title', l->>'product_sku', l->>'variant_sku',
         l->>'size', l->>'color', l->>'image_ref', (l->>'unit_price_kopecks')::bigint, (l->>'unit_price_kopecks')::bigint,
         (l->>'quantity')::integer, (l->>'stock_state') = 'in_stock'
  from jsonb_array_elements(v_lines) l;

  update public.profiles set consent_pd_version = coalesce(public.get_setting('privacy_policy_version') #>> '{}', 'unknown'),
                             consent_pd_at = now()
   where id = v_uid;

  perform app.audit('order_created', 'orders', v_order_id::text,
    jsonb_build_object('number', v_number, 'lines', v_count, 'total_kopecks', greatest(v_items_total - v_discount, 0)));

  return jsonb_build_object('ok', true, 'duplicate', false, 'order_id', v_order_id, 'number', v_number,
    'telegram_token', v_token, 'total_kopecks', greatest(v_items_total - v_discount, 0),
    'items_count', (select coalesce(sum(quantity), 0) from public.order_items where order_id = v_order_id));
end $$;

-- ---------------------------------------------------------------------------
-- 4. Трек-номер: любой непустой (раньше требовалось ≥4 латинских символов — «123» давал ошибку)
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
    values (o.id, v->>'carrier', nullif(left(trim(coalesce(v->>'tracking_number', '')), 60), ''), 'handed_over',
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
alter table public.shipments drop constraint if exists shipments_tracking_number_check;
alter table public.shipments add constraint shipments_tracking_number_check
  check (tracking_number is null or char_length(tracking_number) between 1 and 60);
