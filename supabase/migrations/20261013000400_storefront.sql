-- KEEP MARKET · 0004 · Публичный слой витрины (только безопасные поля, только проверенные товары)
-- Покупатель НИКОГДА не читает таблицы products/variants напрямую: только эти представления и функции.
-- Закупочные цены, поставщики, внутренние заметки и юридические комментарии сюда не попадают.

create or replace function app.stock_freshness_hours() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (value #>> '{}')::integer from public.store_settings where key = 'stock_freshness_hours'), 48)
$$;

create or replace function app.stock_state(p_qty integer, p_confirmed_at timestamptz) returns text
language sql stable as $$
  select case
    when p_qty <= 0 then 'out_of_stock'
    when p_confirmed_at is null or p_confirmed_at < now() - make_interval(hours => app.stock_freshness_hours()) then 'needs_confirmation'
    else 'in_stock'
  end
$$;

create or replace function app.product_is_sellable(p public.products) returns boolean
language sql stable as $$
  select p.status = 'published' and p.compliance_status = 'approved' and p.trademark_review_status = 'approved'
$$;

create or replace view public.catalog_categories as
  select c.id, c.parent_id, c.name, c.slug, c.sort_order
  from public.categories c
  where c.is_active;

create or replace view public.catalog_variants as
  select v.id, v.product_id, v.sku, v.size, v.color, v.color_hex,
         coalesce(v.price_override_kopecks, p.price_kopecks) as price_kopecks,
         v.stock_qty, v.stock_confirmed_at, v.min_qty, v.max_qty, v.sort_order,
         app.stock_state(v.stock_qty, v.stock_confirmed_at) as stock_state
  from public.product_variants v
  join public.products p on p.id = v.product_id
  where v.is_active and app.product_is_sellable(p);

create or replace view public.catalog_images as
  select i.id, i.product_id, coalesce(i.url, 'storage:' || i.storage_path) as image_ref, i.alt, i.sort_order
  from public.product_images i
  join public.products p on p.id = i.product_id
  where app.product_is_sellable(p);

create or replace view public.catalog_products as
  select p.id, p.slug, p.title, p.description, p.category_id,
         c.slug as category_slug, c.name as category_name,
         p.brand_name, p.sku, p.price_kopecks,
         coalesce(agg.min_price, p.price_kopecks) as min_price_kopecks,
         coalesce(agg.max_price, p.price_kopecks) as max_price_kopecks,
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
         coalesce(agg.colors, '{}') as colors
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

create or replace view public.catalog_collections as
  select id, slug, title, description, sort_order, is_demo from public.collections where is_active;

create or replace view public.catalog_banners as
  select id, title, subtitle, coalesce(image_url, 'storage:' || storage_path) as image_ref,
         link_type, link_value, sort_order, is_demo
  from public.homepage_banners
  where is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now());

create or replace view public.public_settings as
  select key, value from public.store_settings where is_public;

-- ---------------------------------------------------------------------------
-- Поиск и фильтры каталога
-- ---------------------------------------------------------------------------
create or replace function public.catalog_search(
  p_query text default null,
  p_category_slug text default null,
  p_price_min bigint default null,
  p_price_max bigint default null,
  p_sizes text[] default null,
  p_colors text[] default null,
  p_sort text default 'new',
  p_limit integer default 24,
  p_offset integer default 0,
  p_collection_slug text default null,
  p_in_stock_only boolean default false
) returns setof public.catalog_products
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_q text := nullif(trim(coalesce(p_query, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 24), 1), 60);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if v_q is not null and char_length(v_q) > 80 then v_q := left(v_q, 80); end if;
  return query
  select cp.* from public.catalog_products cp
  where (v_q is null
         or cp.title ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
         or cp.sku ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
         or exists (select 1 from public.catalog_variants cv where cv.product_id = cp.id and cv.sku ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'))
    and (p_category_slug is null or cp.category_slug = p_category_slug
         or cp.category_id in (select c.id from public.categories c join public.categories parent on parent.id = c.parent_id
                               where parent.slug = p_category_slug and c.is_active))
    and (p_price_min is null or cp.max_price_kopecks >= p_price_min)
    and (p_price_max is null or cp.min_price_kopecks <= p_price_max)
    and (p_sizes is null or cardinality(p_sizes) = 0 or cp.sizes && p_sizes)
    and (p_colors is null or cardinality(p_colors) = 0 or cp.colors && p_colors)
    and (not coalesce(p_in_stock_only, false) or cp.stock_state <> 'out_of_stock')
    and (p_collection_slug is null or cp.id in (
          select cpr.product_id from public.collection_products cpr
          join public.collections col on col.id = cpr.collection_id
          where col.slug = p_collection_slug and col.is_active))
  order by
    case when cp.stock_state = 'out_of_stock' then 1 else 0 end,
    case when p_sort = 'price_asc' then cp.min_price_kopecks end asc nulls last,
    case when p_sort = 'price_desc' then cp.min_price_kopecks end desc nulls last,
    cp.published_at desc nulls last, cp.id
  limit v_limit offset v_offset;
end $$;

create or replace function public.catalog_filters(p_category_slug text default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with base as (
    select cp.* from public.catalog_products cp
    where p_category_slug is null or cp.category_slug = p_category_slug
       or cp.category_id in (select c.id from public.categories c join public.categories parent on parent.id = c.parent_id
                             where parent.slug = p_category_slug)
  )
  select jsonb_build_object(
    'sizes', coalesce((select jsonb_agg(distinct s order by s) from base, unnest(base.sizes) s), '[]'::jsonb),
    'colors', coalesce((select jsonb_agg(distinct c order by c) from base, unnest(base.colors) c), '[]'::jsonb),
    'price_min', (select min(min_price_kopecks) from base),
    'price_max', (select max(max_price_kopecks) from base),
    'count', (select count(*) from base)
  )
$$;

-- «Популярные» — только по реальным заявкам за 90 дней (без вымышленных метрик). Пусто, если заявок нет.
create or replace function public.catalog_popular(p_limit integer default 12)
returns setof public.catalog_products
language sql stable security definer set search_path = public, pg_temp as $$
  select cp.* from public.catalog_products cp
  join (
    select oi.product_id, sum(oi.quantity) as qty
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.created_at > now() - interval '90 days' and o.status <> 'cancelled'
    group by oi.product_id
    having sum(oi.quantity) >= 2
  ) pop on pop.product_id = cp.id
  order by pop.qty desc, cp.published_at desc
  limit least(greatest(coalesce(p_limit, 12), 1), 30)
$$;

-- Похожие товары: та же категория, ближайшая цена
create or replace function public.catalog_similar(p_product_id uuid, p_limit integer default 8)
returns setof public.catalog_products
language sql stable security definer set search_path = public, pg_temp as $$
  select cp.* from public.catalog_products cp
  join public.catalog_products base on base.id = p_product_id
  where cp.id <> base.id and cp.category_id = base.category_id
  order by case when cp.stock_state = 'out_of_stock' then 1 else 0 end,
           abs(cp.min_price_kopecks - base.min_price_kopecks), cp.published_at desc
  limit least(greatest(coalesce(p_limit, 8), 1), 20)
$$;
