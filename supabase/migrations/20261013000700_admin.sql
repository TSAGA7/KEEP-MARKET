-- KEEP MARKET · 0007 · Админ-функции: проверка ассортимента, остатки, импорт прайсов, дашборд, журнал изменений

insert into public.store_settings (key, value, is_public, is_critical, description) values
  ('admins_can_review_compliance', 'false', false, true, 'Разрешить администраторам (не только владельцу) проводить юридическую проверку товаров');

-- Себестоимость позиции заказа (видна только owner/admin, покупателю недоступна)
create table public.order_item_costs (
  order_item_id          uuid primary key references public.order_items(id) on delete cascade,
  purchase_price_kopecks bigint not null check (purchase_price_kopecks >= 0),
  source                 text not null default 'product_costs'
);

create or replace function app.order_items_capture_cost() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cost bigint;
begin
  select coalesce(
           (select so.purchase_price_kopecks from public.supplier_offers so
             where so.variant_id = new.variant_id and so.purchase_price_kopecks is not null
             order by so.confirmed_at desc nulls last limit 1),
           (select pc.purchase_price_kopecks from public.product_costs pc where pc.product_id = new.product_id))
    into v_cost;
  if v_cost is not null then
    insert into public.order_item_costs (order_item_id, purchase_price_kopecks) values (new.id, v_cost);
  end if;
  return new;
end $$;
create trigger order_items_capture_cost after insert on public.order_items
  for each row execute function app.order_items_capture_cost();

-- ---------------------------------------------------------------------------
-- Журнал изменений справочников (фиксируем, какие поля изменились, без значений ПДн)
-- ---------------------------------------------------------------------------
create or replace function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_changed text[]; v_id text;
begin
  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into v_changed
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key not in ('updated_at');
    if v_changed is null then return new; end if;
  end if;
  v_id := coalesce(to_jsonb(coalesce(new, old))->>'id', to_jsonb(coalesce(new, old))->>'product_id',
                   to_jsonb(coalesce(new, old))->>'key', to_jsonb(coalesce(new, old))->>'user_id');
  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (auth.uid(), lower(tg_op), tg_table_name, v_id,
          case when tg_op = 'UPDATE' then jsonb_build_object('fields', v_changed) else '{}'::jsonb end);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['products', 'product_costs', 'product_variants', 'product_images', 'categories', 'suppliers',
                           'supplier_offers', 'promo_codes', 'homepage_banners', 'collections', 'store_settings',
                           'user_roles', 'private_documents']
  loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app.audit_row_change()',
                   t || '_audit', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Юридические поля товара меняются только через функцию проверки
-- ---------------------------------------------------------------------------
create or replace function app.products_compliance_guard() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.review_ctx', true), '') = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    -- Новый товар всегда стартует непроверенным
    new.compliance_status := 'pending_review';
    new.trademark_review_status := 'pending_review';
    new.reviewed_at := null; new.reviewed_by := null;
    return new;
  end if;
  if new.compliance_status is distinct from old.compliance_status
     or new.trademark_review_status is distinct from old.trademark_review_status
     or new.reviewed_at is distinct from old.reviewed_at
     or new.reviewed_by is distinct from old.reviewed_by then
    raise exception 'COMPLIANCE_FIELDS_REQUIRE_REVIEW' using errcode = '42501';
  end if;
  return new;
end $$;
-- Срабатывает до products_guard (имена сортируются по алфавиту: "products_a..." < "products_guard")
create trigger products_a_compliance_guard before insert or update on public.products
  for each row execute function app.products_compliance_guard();

create or replace function public.staff_review_product(
  p_product_id uuid, p_trademark_status text, p_compliance_status text, p_checklist jsonb, p_notes text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid; p public.products;
begin
  if coalesce((public.get_setting('admins_can_review_compliance') #>> '{}')::boolean, false) then
    v_uid := app.require_role(array['owner', 'admin']);
  else
    v_uid := app.require_role(array['owner']);
  end if;
  if p_trademark_status not in ('pending_review', 'approved', 'rejected', 'needs_more_documents')
     or p_compliance_status not in ('pending_review', 'approved', 'rejected', 'needs_more_documents') then
    raise exception 'VALIDATION: status' using errcode = '22023';
  end if;
  -- Одобрение требует заполненного чек-листа
  if p_compliance_status = 'approved' and (
       coalesce((p_checklist->>'no_foreign_trademarks')::boolean, false) is not true
    or coalesce((p_checklist->>'packaging_checked')::boolean, false) is not true
    or coalesce((p_checklist->>'photos_checked')::boolean, false) is not true
    or coalesce((p_checklist->>'design_rights_checked')::boolean, false) is not true
    or coalesce((p_checklist->>'description_checked')::boolean, false) is not true
    or coalesce((p_checklist->>'supplier_documents_checked')::boolean, false) is not true) then
    raise exception 'CHECKLIST_INCOMPLETE' using errcode = '22023';
  end if;
  select * into p from public.products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.compliance_reviews (product_id, reviewer_id, trademark_review_status, compliance_status, checklist, notes)
  values (p_product_id, v_uid, p_trademark_status, p_compliance_status, coalesce(p_checklist, '{}'::jsonb), p_notes);
  perform set_config('app.review_ctx', 'on', true);
  update public.products
     set trademark_review_status = p_trademark_status, compliance_status = p_compliance_status,
         compliance_notes = p_notes, reviewed_at = now(), reviewed_by = v_uid,
         status = case when status = 'pending_review' and p_compliance_status = 'approved' and p_trademark_status = 'approved'
                       then 'hidden' else status end
   where id = p_product_id;
  perform set_config('app.review_ctx', 'off', true);
  select * into p from public.products where id = p_product_id;
  return jsonb_build_object('status', p.status, 'compliance_status', p.compliance_status,
                            'trademark_review_status', p.trademark_review_status,
                            'publish_blockers', to_jsonb(app.product_row_blockers(p)));
end $$;

-- ---------------------------------------------------------------------------
-- Подтверждение остатка менеджером (по ответу поставщика)
-- ---------------------------------------------------------------------------
create or replace function public.staff_confirm_stock(p_variant_id uuid, p_stock_qty integer, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := app.require_role(array['owner', 'admin', 'manager']);
begin
  if p_stock_qty is null or p_stock_qty < 0 or p_stock_qty > 100000 then raise exception 'VALIDATION: stock' using errcode = '22023'; end if;
  update public.product_variants set stock_qty = p_stock_qty, stock_confirmed_at = now() where id = p_variant_id;
  if not found then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform app.audit('stock_confirmed', 'product_variants', p_variant_id::text,
                    jsonb_build_object('stock_qty', p_stock_qty, 'note', left(coalesce(p_note, ''), 200)));
  return jsonb_build_object('ok', true, 'confirmed_at', now());
end $$;

-- Остатки предложений поставщиков для менеджера — без закупочных цен
create or replace function public.staff_offer_availability(p_product_id uuid)
returns table (offer_id uuid, supplier_name text, supplier_sku text, variant_id uuid, stock_qty integer,
               confirmed_at timestamptz, sizes text[], colors text[], manager_comment text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_role(array['owner', 'admin', 'manager']);
  return query
    select so.id, s.name, so.supplier_sku, so.variant_id, so.stock_qty, so.confirmed_at, so.sizes, so.colors, so.manager_comment
      from public.supplier_offers so join public.suppliers s on s.id = so.supplier_id
     where so.product_id = p_product_id
     order by so.confirmed_at desc nulls last;
end $$;

-- ---------------------------------------------------------------------------
-- Импорт CSV-прайса: предпросмотр → подтверждение → (при необходимости) откат
-- ---------------------------------------------------------------------------
create or replace function app.parse_price_to_kopecks(p text) returns bigint
language plpgsql immutable as $$
declare v text := replace(replace(trim(coalesce(p, '')), ' ', ''), ',', '.');
begin
  if v !~ '^\d{1,9}(\.\d{1,2})?$' then return null; end if;
  return round(v::numeric * 100)::bigint;
end $$;

create or replace function public.staff_import_preview(p_supplier_id uuid, p_filename text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := app.require_role(array['owner', 'admin']);
  v_import_id uuid;
  r jsonb; i integer := 0;
  v_errors text[];
  v_sku text; v_price bigint; v_stock integer; v_stock_raw text;
  v_valid integer := 0; v_err integer := 0;
  v_seen text[] := '{}';
begin
  if not exists (select 1 from public.suppliers where id = p_supplier_id) then
    raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'VALIDATION: rows' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) = 0 then raise exception 'EMPTY_FILE' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'TOO_MANY_ROWS' using errcode = '22023'; end if;

  insert into public.supplier_imports (supplier_id, filename, created_by)
  values (p_supplier_id, left(coalesce(nullif(trim(p_filename), ''), 'import.csv'), 200), v_uid)
  returning id into v_import_id;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_errors := '{}';
    v_sku := nullif(trim(coalesce(r->>'supplier_sku', '')), '');
    if v_sku is null then v_errors := v_errors || 'Не указан артикул поставщика'::text;
    elsif char_length(v_sku) > 96 then v_errors := v_errors || 'Артикул длиннее 96 символов'::text;
    elsif v_sku = any (v_seen) then v_errors := v_errors || 'Артикул повторяется в файле'::text;
    end if;
    if v_sku is not null then v_seen := v_seen || v_sku; end if;

    v_price := app.parse_price_to_kopecks(r->>'purchase_price');
    if coalesce(trim(r->>'purchase_price'), '') = '' then v_errors := v_errors || 'Не указана закупочная цена'::text;
    elsif v_price is null then v_errors := v_errors || 'Некорректная цена (ожидается число, до 2 знаков после запятой)'::text;
    elsif v_price = 0 then v_errors := v_errors || 'Закупочная цена равна нулю'::text;
    end if;

    v_stock_raw := trim(coalesce(r->>'stock', ''));
    if v_stock_raw = '' then v_errors := v_errors || 'Не указан остаток'::text; v_stock := null;
    elsif v_stock_raw !~ '^\d{1,6}$' then v_errors := v_errors || 'Остаток должен быть целым неотрицательным числом'::text; v_stock := null;
    else v_stock := v_stock_raw::integer;
    end if;

    insert into public.supplier_import_rows (import_id, row_number, raw, supplier_sku, title, purchase_price_kopecks, stock_qty,
                                             sizes, colors, errors, status)
    values (v_import_id, i, r, v_sku, nullif(left(trim(coalesce(r->>'title', '')), 200), ''), v_price, v_stock,
            coalesce((select array_agg(trim(x)) from unnest(string_to_array(coalesce(r->>'sizes', ''), '|')) x where trim(x) <> ''), '{}'),
            coalesce((select array_agg(trim(x)) from unnest(string_to_array(coalesce(r->>'colors', ''), '|')) x where trim(x) <> ''), '{}'),
            v_errors, case when cardinality(v_errors) = 0 then 'valid' else 'error' end);
    if cardinality(v_errors) = 0 then v_valid := v_valid + 1; else v_err := v_err + 1; end if;
  end loop;

  update public.supplier_imports set total_rows = i, valid_rows = v_valid, error_rows = v_err where id = v_import_id;
  perform app.audit('import_preview', 'supplier_imports', v_import_id::text,
                    jsonb_build_object('rows', i, 'valid', v_valid, 'errors', v_err));
  return jsonb_build_object('import_id', v_import_id, 'total_rows', i, 'valid_rows', v_valid, 'error_rows', v_err,
    'errors', coalesce((select jsonb_agg(jsonb_build_object('row', row_number, 'sku', supplier_sku, 'errors', errors) order by row_number)
                          from public.supplier_import_rows where import_id = v_import_id and status = 'error'), '[]'::jsonb),
    'new_offers', (select count(*) from public.supplier_import_rows ir
                    where ir.import_id = v_import_id and ir.status = 'valid'
                      and not exists (select 1 from public.supplier_offers so where so.supplier_id = p_supplier_id and so.supplier_sku = ir.supplier_sku)),
    'price_changes', (select count(*) from public.supplier_import_rows ir join public.supplier_offers so
                        on so.supplier_id = p_supplier_id and so.supplier_sku = ir.supplier_sku
                       where ir.import_id = v_import_id and ir.status = 'valid' and so.purchase_price_kopecks is distinct from ir.purchase_price_kopecks));
end $$;

create or replace function public.staff_import_apply(p_import_id uuid, p_apply_with_errors boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := app.require_role(array['owner', 'admin']);
  imp public.supplier_imports;
  r public.supplier_import_rows;
  so public.supplier_offers;
  v_prev jsonb;
  v_updated integer := 0; v_created integer := 0;
begin
  select * into imp from public.supplier_imports where id = p_import_id for update;
  if not found then raise exception 'IMPORT_NOT_FOUND' using errcode = 'P0002'; end if;
  if imp.status <> 'preview' then raise exception 'IMPORT_ALREADY_PROCESSED' using errcode = 'P0001'; end if;
  if imp.error_rows > 0 and not p_apply_with_errors then raise exception 'IMPORT_HAS_ERRORS' using errcode = 'P0001'; end if;
  if imp.valid_rows = 0 then raise exception 'NOTHING_TO_APPLY' using errcode = 'P0001'; end if;

  for r in select * from public.supplier_import_rows where import_id = p_import_id and status = 'valid' order by row_number loop
    select * into so from public.supplier_offers where supplier_id = imp.supplier_id and supplier_sku = r.supplier_sku for update;
    if found then
      v_prev := jsonb_build_object('purchase_price_kopecks', so.purchase_price_kopecks, 'stock_qty', so.stock_qty,
                                   'confirmed_at', so.confirmed_at, 'title', so.title, 'sizes', to_jsonb(so.sizes),
                                   'colors', to_jsonb(so.colors), 'last_import_id', so.last_import_id);
      if so.variant_id is not null then
        v_prev := v_prev || (select jsonb_build_object('variant_stock_qty', v.stock_qty, 'variant_stock_confirmed_at', v.stock_confirmed_at)
                               from public.product_variants v where v.id = so.variant_id);
      end if;
      update public.supplier_offers
         set purchase_price_kopecks = r.purchase_price_kopecks, stock_qty = r.stock_qty, confirmed_at = now(),
             title = coalesce(r.title, title),
             sizes = case when cardinality(r.sizes) > 0 then r.sizes else sizes end,
             colors = case when cardinality(r.colors) > 0 then r.colors else colors end,
             last_import_id = p_import_id
       where id = so.id;
      if so.variant_id is not null then
        update public.product_variants set stock_qty = r.stock_qty, stock_confirmed_at = now() where id = so.variant_id;
      end if;
      update public.supplier_import_rows set status = 'applied', offer_id = so.id, previous_values = v_prev where id = r.id;
      v_updated := v_updated + 1;
    else
      -- Новое предложение создаётся без привязки к товару: привязку делает сотрудник вручную
      insert into public.supplier_offers (supplier_id, supplier_sku, title, purchase_price_kopecks, stock_qty, sizes, colors, confirmed_at, last_import_id)
      values (imp.supplier_id, r.supplier_sku, r.title, r.purchase_price_kopecks, r.stock_qty, r.sizes, r.colors, now(), p_import_id)
      returning * into so;
      update public.supplier_import_rows set status = 'applied', offer_id = so.id, offer_created = true where id = r.id;
      v_created := v_created + 1;
    end if;
  end loop;
  update public.supplier_import_rows set status = 'skipped' where import_id = p_import_id and status = 'error';
  update public.supplier_imports set status = 'applied', applied_by = v_uid, applied_at = now() where id = p_import_id;
  perform app.audit('import_applied', 'supplier_imports', p_import_id::text,
                    jsonb_build_object('updated', v_updated, 'created', v_created));
  return jsonb_build_object('updated', v_updated, 'created', v_created);
end $$;

create or replace function public.staff_import_rollback(p_import_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := app.require_role(array['owner', 'admin']);
  imp public.supplier_imports;
  r public.supplier_import_rows;
  so public.supplier_offers;
  v_restored integer := 0; v_deleted integer := 0; v_skipped integer := 0;
begin
  select * into imp from public.supplier_imports where id = p_import_id for update;
  if not found then raise exception 'IMPORT_NOT_FOUND' using errcode = 'P0002'; end if;
  if imp.status <> 'applied' then raise exception 'IMPORT_NOT_APPLIED' using errcode = 'P0001'; end if;

  for r in select * from public.supplier_import_rows where import_id = p_import_id and status = 'applied' loop
    select * into so from public.supplier_offers where id = r.offer_id for update;
    -- Если предложение уже изменено более поздним импортом — не трогаем, чтобы не затереть новые данные
    if not found or so.last_import_id is distinct from p_import_id then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if r.offer_created then
      if so.variant_id is null and so.product_id is null then
        delete from public.supplier_offers where id = so.id;
        v_deleted := v_deleted + 1;
      else
        v_skipped := v_skipped + 1;
        continue;
      end if;
    else
      update public.supplier_offers
         set purchase_price_kopecks = (r.previous_values->>'purchase_price_kopecks')::bigint,
             stock_qty = (r.previous_values->>'stock_qty')::integer,
             confirmed_at = (r.previous_values->>'confirmed_at')::timestamptz,
             title = r.previous_values->>'title',
             sizes = coalesce((select array_agg(x) from jsonb_array_elements_text(r.previous_values->'sizes') x), '{}'),
             colors = coalesce((select array_agg(x) from jsonb_array_elements_text(r.previous_values->'colors') x), '{}'),
             last_import_id = (r.previous_values->>'last_import_id')::uuid
       where id = so.id;
      if so.variant_id is not null and r.previous_values ? 'variant_stock_qty' then
        update public.product_variants
           set stock_qty = (r.previous_values->>'variant_stock_qty')::integer,
               stock_confirmed_at = (r.previous_values->>'variant_stock_confirmed_at')::timestamptz
         where id = so.variant_id;
      end if;
      v_restored := v_restored + 1;
    end if;
    update public.supplier_import_rows set status = 'rolled_back' where id = r.id;
  end loop;
  update public.supplier_imports set status = 'rolled_back', rolled_back_by = v_uid, rolled_back_at = now() where id = p_import_id;
  perform app.audit('import_rolled_back', 'supplier_imports', p_import_id::text,
                    jsonb_build_object('restored', v_restored, 'deleted', v_deleted, 'skipped', v_skipped));
  return jsonb_build_object('restored', v_restored, 'deleted', v_deleted, 'skipped', v_skipped);
end $$;

create or replace function public.staff_import_discard(p_import_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_role(array['owner', 'admin']);
  update public.supplier_imports set status = 'discarded' where id = p_import_id and status = 'preview';
  if not found then raise exception 'IMPORT_NOT_IN_PREVIEW' using errcode = 'P0001'; end if;
  perform app.audit('import_discarded', 'supplier_imports', p_import_id::text, '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Dashboard. Заявки ≠ выручка: деньги считаются только по подтверждённым платежам.
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
    'orders_awaiting_customer', (select count(*) from public.orders where status = 'awaiting_customer_confirmation'),
    'orders_confirmed', (select count(*) from public.orders where status = 'confirmed'),
    'orders_supplier', (select count(*) from public.orders where status = 'supplier_processing'),
    'orders_ready', (select count(*) from public.orders where status = 'ready_to_ship'),
    'orders_shipped', (select count(*) from public.orders where status = 'shipped'),
    'orders_issue', (select count(*) from public.orders where status = 'issue'),
    'open_requests_amount_kopecks', (select coalesce(sum(total_kopecks), 0) from public.orders
                                      where status in ('new', 'checking_availability', 'awaiting_customer_confirmation')),
    'products_published', (select count(*) from public.products where status = 'published'),
    'products_pending_review', (select count(*) from public.products
                                 where status <> 'archived' and (compliance_status <> 'approved' or trademark_review_status <> 'approved')),
    'variants_stale_stock', (select count(*) from public.product_variants v join public.products p on p.id = v.product_id
                              where p.status = 'published' and v.is_active and v.stock_qty > 0
                                and app.stock_state(v.stock_qty, v.stock_confirmed_at) = 'needs_confirmation'),
    'stock_freshness_hours', app.stock_freshness_hours()
  ) into v;
  if v_is_admin then
    v := v || jsonb_build_object(
      -- Поступления: только подтверждённые провайдером/зафиксированные платежи
      'paid_amount_kopecks', (select coalesce(sum(amount_kopecks), 0) from public.payments where status in ('succeeded', 'partially_refunded', 'refunded')),
      'refunded_amount_kopecks', (select coalesce(sum(refunded_kopecks), 0) from public.payments),
      -- Закупочная стоимость оплаченных и не отменённых заказов (по снимку на момент заявки)
      'paid_orders_cost_kopecks', (select coalesce(sum(c.purchase_price_kopecks * oi.quantity), 0)
                                     from public.order_items oi
                                     join public.order_item_costs c on c.order_item_id = oi.id
                                     join public.orders o on o.id = oi.order_id
                                    where o.payment_status in ('paid', 'partially_refunded') and o.status <> 'cancelled'
                                      and oi.availability <> 'unavailable'),
      'paid_orders_items_kopecks', (select coalesce(sum(o.items_total_kopecks - o.discount_kopecks), 0)
                                     from public.orders o where o.payment_status in ('paid', 'partially_refunded') and o.status <> 'cancelled'),
      'paid_orders_without_cost', (select count(distinct o.id) from public.orders o join public.order_items oi on oi.order_id = o.id
                                    left join public.order_item_costs c on c.order_item_id = oi.id
                                   where o.payment_status in ('paid', 'partially_refunded') and c.order_item_id is null)
    );
  end if;
  return v;
end $$;
