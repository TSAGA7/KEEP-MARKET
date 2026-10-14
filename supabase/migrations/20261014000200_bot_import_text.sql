-- KEEP MARKET · Импорт: текст поста, пришедший отдельным сообщением (без фото)
-- Поставщики часто публикуют альбом и отдельный текст с ценой и размерами. Если такой текст переслан
-- в течение нескольких минут после альбома, бот дополняет последний черновик этого сотрудника.

create or replace function public.bot_import_attach_text(
  p_actor_telegram_id bigint,
  p_title text,
  p_description text,
  p_raw_caption text,
  p_price_kopecks bigint,
  p_sizes text[],
  p_window_seconds integer default 300
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid;
  v_product public.products;
  v_size text;
  i integer := 0;
  v_has_variants boolean;
  v_has_cost boolean;
  v_mode text := coalesce(public.get_setting('import_price_mode') #>> '{}', 'purchase');
  v_changed text[] := '{}';
begin
  select p.id into v_actor from public.profiles p
   where p.telegram_id = p_actor_telegram_id and not p.is_blocked
     and exists (select 1 from public.user_roles r where r.user_id = p.id and r.role in ('owner', 'admin'));
  if v_actor is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(trim(p_raw_caption), '') = '' then
    return jsonb_build_object('attached', false);
  end if;

  select pr.* into v_product
    from public.bot_imports bi join public.products pr on pr.id = bi.product_id
   where bi.actor_id = v_actor and bi.created_at > now() - make_interval(secs => least(greatest(p_window_seconds, 30), 1800))
     and pr.status = 'draft'
   order by bi.created_at desc limit 1
   for update of pr;
  if not found then
    return jsonb_build_object('attached', false);
  end if;

  if coalesce(v_product.import_source->>'title_from_caption', 'false') = 'false' and coalesce(trim(p_title), '') <> '' then
    v_changed := array_append(v_changed, 'название');
  end if;
  if v_product.description is null and coalesce(trim(p_description), '') <> '' then
    v_changed := array_append(v_changed, 'описание');
  end if;

  update public.products
     set title = case when coalesce(import_source->>'title_from_caption', 'false') = 'false' and coalesce(trim(p_title), '') <> ''
                      then left(p_title, 200) else title end,
         description = coalesce(description, nullif(trim(p_description), '')),
         internal_notes = left(coalesce(internal_notes || chr(10) || chr(10), '') || 'Текст поста поставщика:' || chr(10) || left(p_raw_caption, 4000), 8000),
         import_source = coalesce(import_source, '{}'::jsonb) || jsonb_build_object('title_from_caption', true)
   where id = v_product.id;

  if p_price_kopecks is not null and p_price_kopecks > 0 then
    if v_mode = 'retail' then
      if coalesce(v_product.price_kopecks, 0) = 0 then
        update public.products set price_kopecks = p_price_kopecks where id = v_product.id;
        v_changed := array_append(v_changed, 'цена');
      end if;
    else
      select exists (select 1 from public.product_costs where product_id = v_product.id) into v_has_cost;
      if not v_has_cost then
        insert into public.product_costs (product_id, purchase_price_kopecks, updated_by) values (v_product.id, p_price_kopecks, v_actor);
        v_changed := array_append(v_changed, 'закупочная цена');
      end if;
    end if;
  end if;

  select exists (select 1 from public.product_variants where product_id = v_product.id) into v_has_variants;
  if not v_has_variants and p_sizes is not null and array_length(p_sizes, 1) > 0 then
    foreach v_size in array p_sizes loop
      i := i + 1;
      exit when i > 20;
      insert into public.product_variants (product_id, sku, size, stock_qty, sort_order)
      values (v_product.id, null, left(v_size, 32), 0, i)
      on conflict do nothing;
    end loop;
    v_changed := array_append(v_changed, 'размеры');
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (v_actor, 'product_import_text_attached', 'products', v_product.id::text, jsonb_build_object('changed', v_changed));

  return jsonb_build_object('attached', true, 'product_id', v_product.id,
                            'title', (select title from public.products where id = v_product.id), 'changed', to_jsonb(v_changed));
end $$;

revoke execute on function public.bot_import_attach_text(bigint, text, text, text, bigint, text[], integer) from public, anon, authenticated;
grant execute on function public.bot_import_attach_text(bigint, text, text, text, bigint, text[], integer) to service_role;
