-- KEEP MARKET · 0013 · Удаление товаров из архива навсегда
-- Удалить можно только товар в статусе «В архиве» и только владельцу или администратору.
-- Фото, варианты, цены и прочие связанные записи удаляются каскадно.
-- В заказах остаётся снимок товара (название, артикул, цена), ссылка на товар обнуляется.
-- Функция возвращает пути файлов фото — интерфейс удаляет их из хранилища.

create or replace function public.admin_delete_archived_product(p_product_id uuid) returns text[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.products;
  v_paths text[];
begin
  perform app.require_role(array['owner', 'admin']);

  select * into p from public.products where id = p_product_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status <> 'archived' then raise exception 'NOT_ARCHIVED' using errcode = 'P0001'; end if;

  select coalesce(array_agg(distinct x), '{}') into v_paths
  from public.product_images i,
       lateral unnest(array[i.storage_path, i.original_storage_path, i.processed_storage_path]) as x
  where i.product_id = p_product_id and x is not null;

  delete from public.products where id = p_product_id;

  perform app.audit('product_deleted', 'products', p_product_id::text,
    jsonb_build_object('sku', p.sku, 'title', p.title));

  return v_paths;
end $$;

revoke execute on function public.admin_delete_archived_product(uuid) from public, anon;
grant execute on function public.admin_delete_archived_product(uuid) to authenticated;
