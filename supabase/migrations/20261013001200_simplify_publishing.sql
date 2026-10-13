-- KEEP MARKET · 0012 · Упрощённая публикация (решение владельца)
-- Убраны: юридическая проверка и проверка товарных знаков как условие публикации и заказа,
-- обязательное описание. Колонки с прежними данными сохраняются (не используются), чтобы миграция была безопасной.
-- Для публикации нужны: категория, цена > 0, хотя бы одно фото и один активный вариант.

drop trigger if exists products_a_compliance_guard on public.products;

create or replace function app.product_row_blockers(p public.products) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text[] := '{}';
begin
  if p.category_id is null then v := v || 'NO_CATEGORY'::text; end if;
  if p.price_kopecks <= 0 then v := v || 'NO_PRICE'::text; end if;
  if not exists (select 1 from public.product_images i where i.product_id = p.id) then v := v || 'NO_IMAGES'::text; end if;
  if not exists (select 1 from public.product_variants pv where pv.product_id = p.id and pv.is_active) then v := v || 'NO_VARIANTS'::text; end if;
  return v;
end $$;

create or replace function app.product_is_sellable(p public.products) returns boolean
language sql stable as $$
  select p.status = 'published'
$$;

create or replace function app.products_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_blockers text[];
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    -- При создании фото и вариантов ещё нет — публикация возможна после сохранения черновика
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
