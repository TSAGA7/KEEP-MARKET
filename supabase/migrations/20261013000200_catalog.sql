-- KEEP MARKET · 0002 · Каталог, поставщики, юридическая проверка, витрина

-- ---------------------------------------------------------------------------
-- Категории (дерево, редактируется администратором)
-- ---------------------------------------------------------------------------
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references public.categories(id) on delete restrict,
  name        text not null check (char_length(name) between 1 and 80),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint categories_not_self_parent check (parent_id is null or parent_id <> id)
);
create index categories_parent_idx on public.categories (parent_id, sort_order);
create trigger categories_touch before update on public.categories for each row execute function app.touch_updated_at();

-- Базовые категории из ТЗ (не демо-данные: структура каталога)
insert into public.categories (name, slug, sort_order) values
  ('Одежда', 'clothing', 10), ('Обувь', 'shoes', 20), ('Сумки', 'bags', 30), ('Аксессуары', 'accessories', 40);

-- ---------------------------------------------------------------------------
-- Поставщики
-- ---------------------------------------------------------------------------
create table public.suppliers (
  id                   uuid primary key default gen_random_uuid(),
  internal_code        text not null unique check (internal_code ~ '^[A-Z0-9_-]{2,32}$'),
  name                 text not null check (char_length(name) between 1 and 160),
  contacts             jsonb not null default '{}'::jsonb,
  notes                text,
  terms                text,
  processing_days_min  integer check (processing_days_min is null or processing_days_min >= 0),
  processing_days_max  integer check (processing_days_max is null or processing_days_max >= 0),
  is_active            boolean not null default true,
  checklist            jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint suppliers_days_order check (processing_days_min is null or processing_days_max is null or processing_days_min <= processing_days_max)
);
create trigger suppliers_touch before update on public.suppliers for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Товары
-- ---------------------------------------------------------------------------
create table public.products (
  id                           uuid primary key default gen_random_uuid(),
  slug                         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 120),
  title                        text not null check (char_length(title) between 1 and 200),
  description                  text check (description is null or char_length(description) <= 8000),
  category_id                  uuid references public.categories(id) on delete restrict,
  brand_name                   text check (brand_name is null or char_length(brand_name) <= 120),
  sku                          text not null unique check (char_length(sku) between 1 and 64),
  price_kopecks                bigint not null check (price_kopecks >= 0),
  materials                    text,
  care                         text,
  size_chart                   jsonb,
  origin_description           text,
  weight_grams                 integer check (weight_grams is null or weight_grams > 0),
  length_mm                    integer check (length_mm is null or length_mm > 0),
  width_mm                     integer check (width_mm is null or width_mm > 0),
  height_mm                    integer check (height_mm is null or height_mm > 0),
  is_featured                  boolean not null default false,
  is_demo                      boolean not null default false,
  status                       text not null default 'draft'
                               check (status in ('draft', 'pending_review', 'published', 'hidden', 'archived')),
  -- Юридическая проверка ассортимента
  supplier_id                  uuid references public.suppliers(id) on delete set null,
  supplier_documents_reference text,
  trademark_review_status      text not null default 'pending_review'
                               check (trademark_review_status in ('pending_review', 'approved', 'rejected', 'needs_more_documents')),
  compliance_status            text not null default 'pending_review'
                               check (compliance_status in ('pending_review', 'approved', 'rejected', 'needs_more_documents')),
  compliance_notes             text,
  reviewed_at                  timestamptz,
  reviewed_by                  uuid references public.profiles(id) on delete set null,
  internal_notes               text,
  published_at                 timestamptz,
  created_by                   uuid references public.profiles(id) on delete set null,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);
create index products_category_idx on public.products (category_id, status);
create index products_status_idx on public.products (status, published_at desc);
create index products_title_trgm_idx on public.products (lower(title));
create trigger products_touch before update on public.products for each row execute function app.touch_updated_at();

-- Себестоимость (закупочная цена) — отдельная таблица: видна только owner/admin
create table public.product_costs (
  product_id             uuid primary key references public.products(id) on delete cascade,
  purchase_price_kopecks bigint not null check (purchase_price_kopecks >= 0),
  updated_by             uuid references public.profiles(id) on delete set null,
  updated_at             timestamptz not null default now()
);

create table public.product_variants (
  id                     uuid primary key default gen_random_uuid(),
  product_id             uuid not null references public.products(id) on delete cascade,
  sku                    text not null unique check (char_length(sku) between 1 and 64),
  size                   text check (size is null or char_length(size) <= 32),
  color                  text check (color is null or char_length(color) <= 48),
  color_hex              text check (color_hex is null or color_hex ~ '^#[0-9a-fA-F]{6}$'),
  price_override_kopecks bigint check (price_override_kopecks is null or price_override_kopecks >= 0),
  stock_qty              integer not null default 0 check (stock_qty >= 0),
  stock_confirmed_at     timestamptz,
  min_qty                integer not null default 1 check (min_qty >= 1),
  max_qty                integer not null default 10 check (max_qty >= 1),
  is_active              boolean not null default true,
  sort_order             integer not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint product_variants_qty_order check (min_qty <= max_qty),
  constraint product_variants_unique_option unique nulls not distinct (product_id, size, color)
);
create index product_variants_product_idx on public.product_variants (product_id, sort_order);
create trigger product_variants_touch before update on public.product_variants for each row execute function app.touch_updated_at();

create table public.product_images (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products(id) on delete cascade,
  storage_path text,
  url          text,
  alt          text,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint product_images_source check (storage_path is not null or url is not null),
  -- https-ссылка или встроенная демо-картинка из /public/demo (только для демо-данных)
  constraint product_images_url_scheme check (url is null or url ~ '^https://' or url ~ '^demo:[a-z0-9-]+\.svg$')
);
create index product_images_product_idx on public.product_images (product_id, sort_order);

-- ---------------------------------------------------------------------------
-- Предложения поставщиков (закупочная цена, остаток, время подтверждения)
-- ---------------------------------------------------------------------------
create table public.supplier_offers (
  id                     uuid primary key default gen_random_uuid(),
  supplier_id            uuid not null references public.suppliers(id) on delete cascade,
  product_id             uuid references public.products(id) on delete set null,
  variant_id             uuid references public.product_variants(id) on delete set null,
  supplier_sku           text not null check (char_length(supplier_sku) between 1 and 96),
  title                  text,
  purchase_price_kopecks bigint check (purchase_price_kopecks is null or purchase_price_kopecks >= 0),
  stock_qty              integer not null default 0 check (stock_qty >= 0),
  sizes                  text[] not null default '{}',
  colors                 text[] not null default '{}',
  confirmed_at           timestamptz,
  manager_comment        text,
  last_import_id         uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (supplier_id, supplier_sku)
);
create index supplier_offers_variant_idx on public.supplier_offers (variant_id);
create index supplier_offers_product_idx on public.supplier_offers (product_id);
create trigger supplier_offers_touch before update on public.supplier_offers for each row execute function app.touch_updated_at();

-- Импорт прайсов
create table public.supplier_imports (
  id             uuid primary key default gen_random_uuid(),
  supplier_id    uuid not null references public.suppliers(id) on delete cascade,
  filename       text not null,
  status         text not null default 'preview' check (status in ('preview', 'applied', 'rolled_back', 'discarded')),
  total_rows     integer not null default 0,
  valid_rows     integer not null default 0,
  error_rows     integer not null default 0,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  applied_by     uuid references public.profiles(id) on delete set null,
  applied_at     timestamptz,
  rolled_back_by uuid references public.profiles(id) on delete set null,
  rolled_back_at timestamptz
);
create index supplier_imports_supplier_idx on public.supplier_imports (supplier_id, created_at desc);

create table public.supplier_import_rows (
  id                     uuid primary key default gen_random_uuid(),
  import_id              uuid not null references public.supplier_imports(id) on delete cascade,
  row_number             integer not null check (row_number >= 1),
  raw                    jsonb not null,
  supplier_sku           text,
  title                  text,
  purchase_price_kopecks bigint,
  stock_qty              integer,
  sizes                  text[],
  colors                 text[],
  errors                 text[] not null default '{}',
  status                 text not null default 'pending' check (status in ('valid', 'error', 'applied', 'rolled_back', 'skipped', 'pending')),
  offer_id               uuid references public.supplier_offers(id) on delete set null,
  offer_created          boolean not null default false,
  previous_values        jsonb,
  unique (import_id, row_number)
);
alter table public.supplier_offers
  add constraint supplier_offers_last_import_fk foreign key (last_import_id) references public.supplier_imports(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Юридическая проверка и приватные документы
-- ---------------------------------------------------------------------------
create table public.compliance_reviews (
  id                      uuid primary key default gen_random_uuid(),
  product_id              uuid references public.products(id) on delete cascade,
  supplier_id             uuid references public.suppliers(id) on delete cascade,
  reviewer_id             uuid references public.profiles(id) on delete set null,
  trademark_review_status text check (trademark_review_status in ('pending_review', 'approved', 'rejected', 'needs_more_documents')),
  compliance_status       text check (compliance_status in ('pending_review', 'approved', 'rejected', 'needs_more_documents')),
  checklist               jsonb not null default '{}'::jsonb,
  notes                   text,
  created_at              timestamptz not null default now(),
  constraint compliance_reviews_target check ((product_id is not null) <> (supplier_id is not null))
);
create index compliance_reviews_product_idx on public.compliance_reviews (product_id, created_at desc);

create table public.private_documents (
  id           uuid primary key default gen_random_uuid(),
  owner_type   text not null check (owner_type in ('supplier', 'product')),
  owner_id     uuid not null,
  title        text not null check (char_length(title) between 1 and 200),
  doc_type     text not null default 'other' check (doc_type in ('certificate', 'declaration', 'contract', 'invoice', 'trademark', 'photo', 'other')),
  storage_path text not null,
  mime_type    text,
  size_bytes   bigint check (size_bytes is null or size_bytes between 1 and 20971520),
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index private_documents_owner_idx on public.private_documents (owner_type, owner_id);

-- ---------------------------------------------------------------------------
-- Витрина: баннеры, подборки, избранное, промокоды
-- ---------------------------------------------------------------------------
create table public.homepage_banners (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 120),
  subtitle   text,
  image_url  text check (image_url is null or image_url ~ '^https://' or image_url ~ '^demo:[a-z0-9-]+\.svg$'),
  storage_path text,
  link_type  text not null default 'none' check (link_type in ('none', 'product', 'category', 'collection', 'catalog', 'external')),
  link_value text,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  is_demo    boolean not null default false,
  starts_at  timestamptz,
  ends_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint homepage_banners_external_https check (link_type <> 'external' or link_value ~ '^https://')
);
create trigger homepage_banners_touch before update on public.homepage_banners for each row execute function app.touch_updated_at();

create table public.collections (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title       text not null,
  description text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  is_demo     boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.collection_products (
  collection_id uuid not null references public.collections(id) on delete cascade,
  product_id    uuid not null references public.products(id) on delete cascade,
  sort_order    integer not null default 0,
  primary key (collection_id, product_id)
);

create table public.favorites (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

create table public.promo_codes (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique check (code ~ '^[A-Z0-9_-]{3,32}$'),
  kind               text not null check (kind in ('percent', 'fixed')),
  value              bigint not null check (value > 0),
  min_order_kopecks  bigint not null default 0 check (min_order_kopecks >= 0),
  max_uses           integer check (max_uses is null or max_uses > 0),
  used_count         integer not null default 0 check (used_count >= 0),
  starts_at          timestamptz,
  ends_at            timestamptz,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  constraint promo_percent_range check (kind <> 'percent' or value between 1 and 90)
);

-- ---------------------------------------------------------------------------
-- Правила публикации: опубликовать можно только проверенный и заполненный товар
-- ---------------------------------------------------------------------------
create or replace function app.product_row_blockers(p public.products) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text[] := '{}';
begin
  if p.compliance_status <> 'approved' then v := v || 'COMPLIANCE_NOT_APPROVED'::text; end if;
  if p.trademark_review_status <> 'approved' then v := v || 'TRADEMARK_NOT_APPROVED'::text; end if;
  if p.category_id is null then v := v || 'NO_CATEGORY'::text; end if;
  if p.price_kopecks <= 0 then v := v || 'NO_PRICE'::text; end if;
  if p.description is null or char_length(trim(p.description)) < 10 then v := v || 'NO_DESCRIPTION'::text; end if;
  if not exists (select 1 from public.product_images i where i.product_id = p.id) then v := v || 'NO_IMAGES'::text; end if;
  if not exists (select 1 from public.product_variants pv where pv.product_id = p.id and pv.is_active) then v := v || 'NO_VARIANTS'::text; end if;
  return v;
end $$;

create or replace function app.product_publish_blockers(p_product_id uuid) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.products;
begin
  select * into p from public.products where id = p_product_id;
  if not found then return array['NOT_FOUND']; end if;
  return app.product_row_blockers(p);
end $$;

create or replace function public.product_publish_blockers(p_product_id uuid) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_role(array['owner', 'admin', 'manager']);
  return app.product_publish_blockers(p_product_id);
end $$;

create or replace function app.products_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_blockers text[];
begin
  -- Если проверка отозвана — товар автоматически снимается с публикации
  if new.status = 'published'
     and (new.compliance_status <> 'approved' or new.trademark_review_status <> 'approved')
     and tg_op = 'UPDATE' and old.status = 'published' then
    new.status := 'hidden';
  end if;
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    -- Для INSERT изображений/вариантов ещё нет — публикация при создании невозможна
    if tg_op = 'INSERT' then
      v_blockers := array['CREATE_AS_DRAFT_FIRST'];
    else
      v_blockers := app.product_row_blockers(new);
    end if;
    if coalesce(array_length(v_blockers, 1), 0) > 0 then
      raise exception 'PUBLISH_BLOCKED: %', array_to_string(v_blockers, ',') using errcode = 'P0001';
    end if;
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end $$;

create trigger products_guard before insert or update on public.products
  for each row execute function app.products_guard();
