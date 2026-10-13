-- KEEP MARKET · 0009 · Supabase Storage: фото товаров (публичные) и документы (приватные)
-- Выполняется только если схема storage существует (в Supabase — всегда).

do $outer$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'storage schema not found — пропускаем настройку бакетов';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('product-images', 'product-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
  on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
                                 allowed_mime_types = excluded.allowed_mime_types;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('private-documents', 'private-documents', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                 allowed_mime_types = excluded.allowed_mime_types;

  -- Фото: читать может любой (бакет публичный), загружать/менять/удалять — owner/admin
  execute $p$create policy "product_images_admin_insert" on storage.objects for insert to authenticated
    with check (bucket_id = 'product-images' and public.is_admin())$p$;
  execute $p$create policy "product_images_admin_update" on storage.objects for update to authenticated
    using (bucket_id = 'product-images' and public.is_admin())$p$;
  execute $p$create policy "product_images_admin_delete" on storage.objects for delete to authenticated
    using (bucket_id = 'product-images' and public.is_admin())$p$;

  -- Документы поставщиков и товаров: только owner/admin, бакет приватный (доступ по подписанным ссылкам)
  execute $p$create policy "private_documents_admin_select" on storage.objects for select to authenticated
    using (bucket_id = 'private-documents' and public.is_admin())$p$;
  execute $p$create policy "private_documents_admin_insert" on storage.objects for insert to authenticated
    with check (bucket_id = 'private-documents' and public.is_admin())$p$;
  execute $p$create policy "private_documents_admin_delete" on storage.objects for delete to authenticated
    using (bucket_id = 'private-documents' and public.is_admin())$p$;
end
$outer$;
