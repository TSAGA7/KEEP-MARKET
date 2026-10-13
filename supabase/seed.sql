-- KEEP MARKET · ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ
-- Все записи помечены is_demo = true и отображаются в интерфейсе с меткой «Демо».
-- Seed НЕ создаёт заказов, платежей и покупателей. Бренд «KEEP Studio (демо)» вымышленный.
-- Не применяйте seed в production или удалите демо-товары перед запуском:
--   delete from public.products where is_demo; delete from public.homepage_banners where is_demo; delete from public.collections where is_demo;

do $$
declare
  v_supplier uuid;
  v_clothing uuid := (select id from public.categories where slug = 'clothing');
  v_shoes uuid := (select id from public.categories where slug = 'shoes');
  v_bags uuid := (select id from public.categories where slug = 'bags');
  v_acc uuid := (select id from public.categories where slug = 'accessories');
  v_col uuid;
  p record;
  v_pid uuid;
  v_size text;
  v_color record;
  i integer := 0;
begin
  if exists (select 1 from public.products where is_demo) then
    raise notice 'Демо-данные уже загружены';
    return;
  end if;

  insert into public.suppliers (internal_code, name, contacts, notes, terms, processing_days_min, processing_days_max)
  values ('DEMO-SUP', 'Демо-поставщик', '{"contact": "Тестовый контакт"}', 'ДЕМО: вымышленный поставщик для проверки интерфейса',
          'ДЕМО: условия не согласованы', 1, 3)
  returning id into v_supplier;

  perform set_config('app.review_ctx', 'on', true);

  for p in select * from (values
    ('demo-oversize-tee', 'Футболка оверсайз базовая', v_clothing, 'KM-DEMO-001', 249000::bigint, 'tee', array['S','M','L','XL'],
       '100% хлопок (демо-значение)', 'Свободный крой, плотный трикотаж. Демонстрационный товар для проверки витрины.'),
    ('demo-heavy-hoodie', 'Худи из плотного футера', v_clothing, 'KM-DEMO-002', 599000, 'hoodie', array['S','M','L','XL'],
       '80% хлопок, 20% полиэстер (демо-значение)', 'Капюшон с двойным слоем, карман-кенгуру. Демонстрационный товар.'),
    ('demo-cargo-pants', 'Брюки карго прямого кроя', v_clothing, 'KM-DEMO-003', 689000, 'pants', array['28','30','32','34'],
       null, 'Шесть карманов, регулируемые манжеты. Демонстрационный товар.'),
    ('demo-canvas-sneakers', 'Кеды из канваса', v_shoes, 'KM-DEMO-004', 549000, 'sneakers', array['39','40','41','42','43','44'],
       null, 'Низкие кеды на вулканизированной подошве. Демонстрационный товар.'),
    ('demo-leather-boots', 'Ботинки на тракторной подошве', v_shoes, 'KM-DEMO-005', 1290000, 'boots', array['40','41','42','43'],
       null, 'Высокие ботинки со шнуровкой. Демонстрационный товар.'),
    ('demo-tote-bag', 'Сумка-тоут из плотного хлопка', v_bags, 'KM-DEMO-006', 189000, 'tote', array[null::text],
       '100% хлопок (демо-значение)', 'Вместительная сумка на каждый день. Демонстрационный товар.'),
    ('demo-crossbody', 'Сумка через плечо', v_bags, 'KM-DEMO-007', 349000, 'crossbody', array[null::text],
       null, 'Компактная сумка с регулируемым ремнём. Демонстрационный товар.'),
    ('demo-beanie', 'Шапка бини в рубчик', v_acc, 'KM-DEMO-008', 129000, 'beanie', array[null::text],
       null, 'Тёплая шапка с отворотом. Демонстрационный товар.')
  ) as t(slug, title, category_id, sku, price, image, sizes, materials, description)
  loop
    i := i + 1;
    insert into public.products (slug, title, description, category_id, brand_name, sku, price_kopecks, materials, origin_description,
                                 is_demo, is_featured, status, supplier_id, compliance_status, trademark_review_status,
                                 compliance_notes, reviewed_at)
    values (p.slug, p.title, p.description, p.category_id, 'KEEP Studio (демо)', p.sku, p.price, p.materials,
            'ДЕМО: происхождение не указано — заполняется по документам поставщика',
            true, i <= 4, 'draft', v_supplier, 'approved', 'approved', 'ДЕМО: проверка не проводилась', now())
    returning id into v_pid;

    insert into public.product_images (product_id, url, alt, sort_order) values
      (v_pid, 'demo:' || p.image || '-1.svg', p.title, 0),
      (v_pid, 'demo:' || p.image || '-2.svg', p.title || ' — вид сзади', 1);

    for v_color in select * from (values ('Чёрный', '#111111'), ('Серый', '#8a8a8a')) c(name, hex) loop
      foreach v_size in array p.sizes loop
        insert into public.product_variants (product_id, sku, size, color, color_hex, stock_qty, stock_confirmed_at, sort_order)
        values (v_pid, p.sku || '-' || coalesce(v_size, 'OS') || '-' || left(v_color.hex, 4), v_size, v_color.name, v_color.hex,
                case when v_size = 'XL' then 0 else 3 end,
                case when p.slug = 'demo-leather-boots' then now() - interval '7 days' else now() end, 0);
      end loop;
    end loop;

    insert into public.product_costs (product_id, purchase_price_kopecks) values (v_pid, (p.price * 55) / 100);
    update public.products set status = 'published' where id = v_pid;
  end loop;

  perform set_config('app.review_ctx', 'off', true);

  insert into public.homepage_banners (title, subtitle, image_url, link_type, link_value, sort_order, is_demo) values
    ('Новый сезон', 'Демо-баннер: управляется из админ-панели', 'demo:banner-1.svg', 'catalog', null, 0, true),
    ('Базовый гардероб', 'Демо-подборка редакции', 'demo:banner-2.svg', 'collection', 'demo-essentials', 1, true);

  insert into public.collections (slug, title, description, sort_order, is_demo)
  values ('demo-essentials', 'Базовый гардероб', 'Демо-подборка: вещи на каждый день', 0, true)
  returning id into v_col;
  insert into public.collection_products (collection_id, product_id, sort_order)
  select v_col, id, row_number() over (order by sku) from public.products where slug in ('demo-oversize-tee', 'demo-heavy-hoodie', 'demo-canvas-sneakers', 'demo-tote-bag');
end $$;
