-- KEEP MARKET · 0008 · Row Level Security и минимальные привилегии
-- Правило: клиенту (anon/authenticated) разрешено только то, что явно выдано ниже.

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema app to anon, authenticated, service_role;

-- Сбрасываем всё, что Supabase выдаёт по умолчанию
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;

-- service_role (Edge Functions) — полный доступ (RLS для него не действует)
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema app to service_role;

-- Включаем RLS на ВСЕХ таблицах
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Функции, используемые политиками и представлениями
-- ---------------------------------------------------------------------------
grant execute on function public.has_any_role(text[]), public.is_owner(), public.is_admin(), public.is_staff(),
  public.current_user_id(), public.my_roles(), public.mask_phone(text), public.mask_name(text),
  public.order_transition_allowed(text, text) to anon, authenticated;
grant execute on function app.stock_state(integer, timestamptz), app.stock_freshness_hours(),
  app.product_is_sellable(public.products) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Витрина (anon + authenticated)
-- ---------------------------------------------------------------------------
grant select on public.catalog_products, public.catalog_variants, public.catalog_images, public.catalog_categories,
  public.catalog_collections, public.catalog_banners, public.public_settings to anon, authenticated;
grant execute on function public.catalog_search(text, text, bigint, bigint, text[], text[], text, integer, integer, text, boolean),
  public.catalog_filters(text), public.catalog_popular(integer), public.catalog_similar(uuid, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC покупателя и сотрудников (права проверяются внутри функций)
-- ---------------------------------------------------------------------------
grant execute on function public.create_order_request(jsonb), public.customer_confirm_order(uuid),
  public.customer_cancel_order(uuid, text) to authenticated;
grant execute on function public.staff_order_action(uuid, text, jsonb), public.staff_get_order_contact(uuid),
  public.staff_set_role(uuid, text, boolean), public.staff_review_product(uuid, text, text, jsonb, text),
  public.staff_confirm_stock(uuid, integer, text), public.staff_offer_availability(uuid),
  public.staff_import_preview(uuid, text, jsonb), public.staff_import_apply(uuid, boolean),
  public.staff_import_rollback(uuid), public.staff_import_discard(uuid), public.staff_dashboard(),
  public.staff_refund_prepare(uuid, bigint, text), public.staff_register_offline_payment(uuid, bigint, text),
  public.product_publish_blockers(uuid), public.purge_expired_personal_data() to authenticated;
-- Только service_role: bootstrap_owner, check_rate_limit, payment_*, refund_apply_result, customer_payment_prepare

-- ---------------------------------------------------------------------------
-- profiles / user_roles
-- ---------------------------------------------------------------------------
grant select on public.profiles to authenticated;
create policy profiles_select_self_or_staff on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());

grant select on public.user_roles to authenticated;
create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- Записи в user_roles только через staff_set_role / bootstrap_owner

-- ---------------------------------------------------------------------------
-- Каталог (чтение — сотрудники; запись — owner/admin)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['categories', 'products', 'product_variants', 'product_images', 'suppliers',
                           'homepage_banners', 'collections', 'collection_products', 'promo_codes']
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_staff())', t || '_staff_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_admin())', t || '_admin_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t || '_admin_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_admin())', t || '_admin_delete', t);
  end loop;
end $$;

-- Закупочные цены, предложения поставщиков, импорты, проверки, документы — только owner/admin
do $$
declare t text;
begin
  foreach t in array array['product_costs', 'supplier_offers', 'private_documents']
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t || '_admin_all', t);
  end loop;
  foreach t in array array['supplier_imports', 'supplier_import_rows', 'compliance_reviews', 'order_item_costs', 'payment_events', 'audit_logs']
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_admin())', t || '_admin_select', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Избранное — только своё
-- ---------------------------------------------------------------------------
grant select, insert, delete on public.favorites to authenticated;
create policy favorites_own_select on public.favorites for select to authenticated using (user_id = auth.uid());
create policy favorites_own_insert on public.favorites for insert to authenticated with check (user_id = auth.uid());
create policy favorites_own_delete on public.favorites for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Заказы: покупатель видит только свои; сотрудники — все. Запись только через RPC.
-- ---------------------------------------------------------------------------
grant select on public.orders, public.order_items, public.order_status_history, public.shipments,
  public.order_contacts, public.payments, public.refunds to authenticated;

create policy orders_select on public.orders for select to authenticated
  using (customer_id = auth.uid() or public.is_staff());

create policy order_items_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and (o.customer_id = auth.uid() or public.is_staff())));

create policy order_status_history_select on public.order_status_history for select to authenticated
  using (public.is_staff() or (visible_to_customer and exists (
    select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid())));

create policy shipments_select on public.shipments for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and (o.customer_id = auth.uid() or public.is_staff())));

-- Контакты получателя: напрямую — только сам покупатель. Сотрудники — через staff_get_order_contact (с журналом).
create policy order_contacts_own on public.order_contacts for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));

create policy payments_select on public.payments for select to authenticated
  using (public.is_admin() or exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));

create policy refunds_select on public.refunds for select to authenticated
  using (public.is_admin() or exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Настройки: сотрудники читают; admin меняет некритичные; owner — любые
-- ---------------------------------------------------------------------------
grant select, update on public.store_settings to authenticated;
create policy store_settings_staff_select on public.store_settings for select to authenticated using (public.is_staff());
create policy store_settings_update on public.store_settings for update to authenticated
  using (public.is_owner() or (public.is_admin() and not is_critical))
  with check (public.is_owner() or (public.is_admin() and not is_critical));

-- Запрет менять сам флаг критичности кем-либо, кроме владельца
create or replace function app.store_settings_guard() returns trigger language plpgsql as $$
begin
  if (new.is_critical is distinct from old.is_critical or new.is_public is distinct from old.is_public or new.key <> old.key)
     and auth.uid() is not null and not public.is_owner() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
create trigger store_settings_guard before update on public.store_settings
  for each row execute function app.store_settings_guard();
