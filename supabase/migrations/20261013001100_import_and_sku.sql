-- KEEP MARKET · 0011 · Автоматические артикулы, импорт товаров из постов поставщиков через бота, обработка фото

-- ---------------------------------------------------------------------------
-- Артикулы: если не указан — магазин присваивает сам (KM-000001, варианты KM-000001-01)
-- ---------------------------------------------------------------------------
create sequence public.product_sku_seq start 1;
create sequence public.variant_sku_seq start 1;

create or replace function app.products_default_sku() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.sku is null or trim(new.sku) = '' then
    loop
      new.sku := 'KM-' || lpad(nextval('public.product_sku_seq')::text, 6, '0');
      exit when not exists (select 1 from public.products where sku = new.sku);
    end loop;
  else
    new.sku := trim(new.sku);
  end if;
  return new;
end $$;
-- Имя начинается с «products_0», чтобы срабатывать раньше остальных BEFORE-триггеров
create trigger products_0_default_sku before insert or update of sku on public.products
  for each row execute function app.products_default_sku();

create or replace function app.variants_default_sku() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_base text;
begin
  if new.sku is null or trim(new.sku) = '' then
    select sku into v_base from public.products where id = new.product_id;
    loop
      new.sku := coalesce(v_base, 'KM') || '-' || lpad(nextval('public.variant_sku_seq')::text, 4, '0');
      exit when not exists (select 1 from public.product_variants where sku = new.sku);
    end loop;
  else
    new.sku := trim(new.sku);
  end if;
  return new;
end $$;
create trigger product_variants_0_default_sku before insert or update of sku on public.product_variants
  for each row execute function app.variants_default_sku();

-- ---------------------------------------------------------------------------
-- Фото: оригинал и обработанная версия (удаление фона), статус обработки
-- ---------------------------------------------------------------------------
alter table public.product_images
  add column original_storage_path text,
  add column processed_storage_path text,
  add column processing_status text not null default 'none'
    check (processing_status in ('none', 'pending', 'processing', 'done', 'failed', 'skipped')),
  add column processing_error text,
  add column processing_started_at timestamptz,
  add column processed_at timestamptz;
create index product_images_processing_idx on public.product_images (processing_status, created_at)
  where processing_status in ('pending', 'processing');

-- ---------------------------------------------------------------------------
-- Поставщики: привязка к Telegram-каналу (для автоматического определения при пересылке)
-- ---------------------------------------------------------------------------
alter table public.suppliers
  add column telegram_chat_id bigint unique,
  add column telegram_username text check (telegram_username is null or telegram_username ~ '^[A-Za-z0-9_]{4,64}$');

alter table public.products
  add column import_source jsonb;

-- ---------------------------------------------------------------------------
-- Импорт: один пост (альбом фото) = один черновик товара
-- ---------------------------------------------------------------------------
create table public.bot_imports (
  id           uuid primary key default gen_random_uuid(),
  group_key    text not null unique,
  product_id   uuid not null references public.products(id) on delete cascade,
  actor_id     uuid references public.profiles(id) on delete set null,
  photo_count  integer not null default 0,
  created_at   timestamptz not null default now()
);
alter table public.bot_imports enable row level security;
revoke all on public.bot_imports from anon, authenticated;
grant all on public.bot_imports to service_role;
grant select on public.bot_imports to authenticated;
create policy bot_imports_admin_select on public.bot_imports for select to authenticated using (public.is_admin());

insert into public.store_settings (key, value, is_public, is_critical, description) values
  ('import_price_mode', '"purchase"', false, false, 'Цена из поста поставщика: purchase — записать как закупочную, retail — как розничную'),
  ('import_markup_percent', 'null', false, false, 'Наценка (%) для расчёта розничной цены из закупочной при импорте. null — розничную цену указывать вручную')
on conflict (key) do nothing;

-- Создать (или найти) черновик товара для поста. Вызывается только Edge Function бота (service_role).
-- Возвращает product_id и признак created, чтобы бот ответил один раз на альбом.
create or replace function public.bot_import_upsert(
  p_actor_telegram_id bigint,
  p_group_key text,
  p_title text,
  p_description text,
  p_raw_caption text,
  p_price_kopecks bigint,
  p_sizes text[],
  p_source jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid;
  v_product uuid;
  v_created boolean := false;
  v_supplier uuid;
  v_mode text := coalesce(public.get_setting('import_price_mode') #>> '{}', 'purchase');
  v_markup numeric := nullif(public.get_setting('import_markup_percent') #>> '{}', '')::numeric;
  v_retail bigint := 0;
  v_cost bigint := null;
  v_slug text;
  v_size text;
  i integer := 0;
begin
  select p.id into v_actor from public.profiles p
   where p.telegram_id = p_actor_telegram_id and not p.is_blocked
     and exists (select 1 from public.user_roles r where r.user_id = p.id and r.role in ('owner', 'admin'));
  if v_actor is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_group_key is null or char_length(p_group_key) > 120 then raise exception 'VALIDATION: group_key'; end if;

  select product_id into v_product from public.bot_imports where group_key = p_group_key;
  if v_product is not null then
    -- Подпись может прийти не с первым фото альбома — дополняем черновик, если он ещё пустой
    if coalesce(trim(p_raw_caption), '') <> '' then
      update public.products
         set description = coalesce(description, nullif(trim(p_description), '')),
             title = case when import_source->>'title_from_caption' = 'false' and coalesce(trim(p_title), '') <> '' then left(p_title, 200) else title end,
             internal_notes = coalesce(internal_notes, 'Текст поста поставщика:' || chr(10) || left(p_raw_caption, 4000)),
             import_source = import_source || jsonb_build_object('title_from_caption', true)
       where id = v_product and status = 'draft';
    end if;
    return jsonb_build_object('product_id', v_product, 'created', false);
  end if;

  -- Поставщик по каналу, из которого переслан пост
  select id into v_supplier from public.suppliers s
   where (p_source->>'chat_id') is not null and s.telegram_chat_id = (p_source->>'chat_id')::bigint
      or (p_source->>'username') is not null and lower(s.telegram_username) = lower(p_source->>'username')
   limit 1;

  if p_price_kopecks is not null and p_price_kopecks > 0 then
    if v_mode = 'retail' then
      v_retail := p_price_kopecks;
    else
      v_cost := p_price_kopecks;
      if v_markup is not null and v_markup > 0 then
        -- округление розничной цены до 10 ₽
        v_retail := (round(p_price_kopecks * (1 + v_markup / 100) / 1000.0) * 1000)::bigint;
      end if;
    end if;
  end if;

  v_slug := left(coalesce(nullif(p_source->>'slug_base', ''), 'tovar'), 90) || '-' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into public.products (slug, title, description, sku, price_kopecks, status, supplier_id, internal_notes, import_source, created_by)
  values (v_slug,
          left(coalesce(nullif(trim(p_title), ''), 'Новый товар из Telegram'), 200),
          nullif(trim(p_description), ''),
          null, v_retail, 'draft', v_supplier,
          case when coalesce(trim(p_raw_caption), '') <> '' then 'Текст поста поставщика:' || chr(10) || left(p_raw_caption, 4000) end,
          coalesce(p_source, '{}'::jsonb) || jsonb_build_object('imported_at', now(), 'title_from_caption', coalesce(trim(p_raw_caption), '') <> ''),
          v_actor)
  returning id into v_product;

  begin
    insert into public.bot_imports (group_key, product_id, actor_id) values (p_group_key, v_product, v_actor);
    v_created := true;
  exception when unique_violation then
    -- Параллельное сообщение того же альбома успело раньше — откатываем свой черновик
    delete from public.products where id = v_product;
    select product_id into v_product from public.bot_imports where group_key = p_group_key;
    return jsonb_build_object('product_id', v_product, 'created', false);
  end;

  if v_cost is not null then
    insert into public.product_costs (product_id, purchase_price_kopecks, updated_by) values (v_product, v_cost, v_actor);
  end if;

  -- Варианты по найденным размерам: остаток 0 и не подтверждён — менеджер уточняет у поставщика
  if p_sizes is not null then
    foreach v_size in array p_sizes loop
      i := i + 1;
      exit when i > 20;
      insert into public.product_variants (product_id, sku, size, stock_qty, sort_order)
      values (v_product, null, left(v_size, 32), 0, i)
      on conflict do nothing;
    end loop;
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (v_actor, 'product_imported_from_telegram', 'products', v_product::text,
          jsonb_build_object('supplier_found', v_supplier is not null, 'price_found', p_price_kopecks is not null, 'sizes', coalesce(array_length(p_sizes, 1), 0)));
  return jsonb_build_object('product_id', v_product, 'created', true, 'supplier_found', v_supplier is not null,
                            'retail_kopecks', v_retail, 'cost_kopecks', v_cost);
end $$;

create or replace function public.bot_import_add_photo(p_product_id uuid, p_group_key text, p_storage_path text, p_message_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  update public.bot_imports set photo_count = photo_count + 1 where group_key = p_group_key and product_id = p_product_id
  returning photo_count into v_count;
  if v_count is null then raise exception 'IMPORT_NOT_FOUND'; end if;
  insert into public.product_images (product_id, storage_path, original_storage_path, sort_order, processing_status)
  values (p_product_id, p_storage_path, p_storage_path, coalesce(p_message_id, v_count)::integer % 100000, 'pending');
  return jsonb_build_object('photo_count', v_count);
end $$;

revoke execute on function public.bot_import_upsert(bigint, text, text, text, text, bigint, text[], jsonb) from public, anon, authenticated;
revoke execute on function public.bot_import_add_photo(uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.bot_import_upsert(bigint, text, text, text, text, bigint, text[], jsonb) to service_role;
grant execute on function public.bot_import_add_photo(uuid, text, text, bigint) to service_role;
grant usage on sequence public.product_sku_seq, public.variant_sku_seq to authenticated, service_role;

-- Переключение фото: обработанное ↔ оригинал (owner/admin; RLS на product_images уже ограничивает запись)
create or replace function public.staff_image_use_version(p_image_id uuid, p_version text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare img public.product_images;
begin
  perform app.require_role(array['owner', 'admin']);
  select * into img from public.product_images where id = p_image_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_version = 'original' and img.original_storage_path is not null then
    update public.product_images set storage_path = img.original_storage_path where id = p_image_id;
  elsif p_version = 'processed' and img.processed_storage_path is not null then
    update public.product_images set storage_path = img.processed_storage_path where id = p_image_id;
  elsif p_version = 'reprocess' and img.original_storage_path is not null then
    update public.product_images set storage_path = img.original_storage_path, processing_status = 'pending', processing_error = null
     where id = p_image_id;
  else
    raise exception 'VERSION_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
end $$;
revoke execute on function public.staff_image_use_version(uuid, text) from public, anon;
grant execute on function public.staff_image_use_version(uuid, text) to authenticated;
