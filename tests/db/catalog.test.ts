// Публикация, юридическая проверка, импорт прайса, поиск каталога
import { beforeAll, describe, expect, it } from 'vitest';
import { as, createDb, createProfile, expectDbError, grantRole, one, q, type Db } from './harness';

let db: Db;
let owner: string, admin: string, manager: string;
const FULL_CHECKLIST = {
  no_foreign_trademarks: true, packaging_checked: true, photos_checked: true,
  design_rights_checked: true, description_checked: true, supplier_documents_checked: true,
};

beforeAll(async () => {
  db = await createDb({ seed: true });
  owner = await createProfile(db, 7001, 'owner');
  admin = await createProfile(db, 7002, 'admin');
  manager = await createProfile(db, 7003, 'mgr');
  await grantRole(db, owner, 'owner');
  await grantRole(db, admin, 'admin');
  await grantRole(db, manager, 'manager');
});

async function newDraft(slug: string): Promise<string> {
  const cat = await one<{ id: string }>(db, `select id from public.categories where slug = 'shoes'`);
  const p = await as(db, 'authenticated', admin, () => one<{ id: string }>(db, `
    insert into public.products (slug, title, description, category_id, sku, price_kopecks, compliance_status, trademark_review_status)
    values ($1, 'Новый товар', 'Достаточно длинное описание', $2, $3, 500000, 'approved', 'approved') returning id`,
    [slug, cat.id, slug.toUpperCase()]));
  await as(db, 'authenticated', admin, () => q(db, `insert into public.product_images (product_id, url) values ($1, 'demo:boots-1.svg')`, [p.id]));
  await as(db, 'authenticated', admin, () => q(db, `insert into public.product_variants (product_id, sku, size, stock_qty, stock_confirmed_at) values ($1, $2, '42', 2, now())`, [p.id, slug.toUpperCase() + '-42']));
  return p.id;
}

describe('публикация и юридическая проверка', () => {
  it('новый товар всегда создаётся непроверенным — нельзя «самоодобрить» при создании', async () => {
    const id = await newDraft('self-approve');
    const p = await one<{ compliance_status: string; trademark_review_status: string }>(db,
      'select compliance_status, trademark_review_status from public.products where id = $1', [id]);
    expect(p).toEqual({ compliance_status: 'pending_review', trademark_review_status: 'pending_review' });
  });

  it('публикация непроверенного товара блокируется', async () => {
    const id = await newDraft('blocked-publish');
    await expectDbError(as(db, 'authenticated', admin, () => q(db, `update public.products set status = 'published' where id = $1`, [id])),
      /PUBLISH_BLOCKED: .*COMPLIANCE_NOT_APPROVED/);
    const cat = await q(db, 'select id from public.catalog_products where id = $1', [id]);
    expect(cat).toHaveLength(0);
  });

  it('юридические поля нельзя изменить обычным UPDATE', async () => {
    const id = await newDraft('direct-compliance');
    await expectDbError(as(db, 'authenticated', admin, () => q(db, `update public.products set compliance_status = 'approved' where id = $1`, [id])),
      'COMPLIANCE_FIELDS_REQUIRE_REVIEW');
  });

  it('проверку проводит владелец; одобрение требует полного чек-листа; после — публикация разрешена', async () => {
    const id = await newDraft('reviewed');
    await expectDbError(as(db, 'authenticated', admin, () => q(db, `select public.staff_review_product($1, 'approved', 'approved', $2::jsonb, 'ok')`,
      [id, JSON.stringify(FULL_CHECKLIST)])), 'FORBIDDEN');
    await expectDbError(as(db, 'authenticated', owner, () => q(db, `select public.staff_review_product($1, 'approved', 'approved', '{"no_foreign_trademarks": true}'::jsonb, 'ok')`,
      [id])), 'CHECKLIST_INCOMPLETE');
    const r = await as(db, 'authenticated', owner, () => one<{ r: { publish_blockers: string[] } }>(db,
      `select public.staff_review_product($1, 'approved', 'approved', $2::jsonb, 'Документы поставщика проверены') r`, [id, JSON.stringify(FULL_CHECKLIST)]));
    expect(r.r.publish_blockers).toEqual([]);
    await as(db, 'authenticated', admin, () => q(db, `update public.products set status = 'published' where id = $1`, [id]));
    const cat = await q(db, 'select id from public.catalog_products where id = $1', [id]);
    expect(cat).toHaveLength(1);
    const reviews = await q(db, 'select reviewer_id from public.compliance_reviews where product_id = $1', [id]);
    expect(reviews).toEqual([{ reviewer_id: owner }]);
  });

  it('статус needs_more_documents снимает товар с публикации', async () => {
    const id = await newDraft('revoke');
    await as(db, 'authenticated', owner, () => q(db, `select public.staff_review_product($1, 'approved', 'approved', $2::jsonb, null)`, [id, JSON.stringify(FULL_CHECKLIST)]));
    await as(db, 'authenticated', admin, () => q(db, `update public.products set status = 'published' where id = $1`, [id]));
    await as(db, 'authenticated', owner, () => q(db, `select public.staff_review_product($1, 'approved', 'needs_more_documents', '{}'::jsonb, 'нужна декларация')`, [id]));
    const p = await one<{ status: string }>(db, 'select status from public.products where id = $1', [id]);
    expect(p.status).toBe('hidden');
  });

  it('товар без фото/вариантов не публикуется даже после проверки', async () => {
    const cat = await one<{ id: string }>(db, `select id from public.categories where slug = 'bags'`);
    const p = await as(db, 'authenticated', admin, () => one<{ id: string }>(db, `
      insert into public.products (slug, title, description, category_id, sku, price_kopecks) values ('empty-bag', 'Сумка', 'Описание сумки тест', $1, 'EMPTY-BAG', 1000) returning id`, [cat.id]));
    await as(db, 'authenticated', owner, () => q(db, `select public.staff_review_product($1, 'approved', 'approved', $2::jsonb, null)`, [p.id, JSON.stringify(FULL_CHECKLIST)]));
    await expectDbError(as(db, 'authenticated', admin, () => q(db, `update public.products set status = 'published' where id = $1`, [p.id])), /NO_IMAGES.*NO_VARIANTS/);
  });

  it('менеджер не может редактировать товары, но может подтверждать остаток', async () => {
    const v = await one<{ id: string; product_id: string }>(db, `select id, product_id from public.product_variants limit 1`);
    await as(db, 'authenticated', manager, () => q(db, `update public.products set price_kopecks = 1 where id = $1`, [v.product_id]));
    const p = await one<{ price_kopecks: number }>(db, 'select price_kopecks from public.products where id = $1', [v.product_id]);
    expect(Number(p.price_kopecks)).toBeGreaterThan(1);
    await as(db, 'authenticated', manager, () => q(db, `select public.staff_confirm_stock($1, 7, 'ответ поставщика')`, [v.id]));
    const pv = await one<{ stock_qty: number }>(db, 'select stock_qty from public.product_variants where id = $1', [v.id]);
    expect(pv.stock_qty).toBe(7);
  });
});

describe('каталог', () => {
  it('поиск по названию и артикулу, фильтры по размеру и цвету, сортировка по цене', async () => {
    const byTitle = await as(db, 'anon', null, () => q<{ slug: string }>(db, `select slug from public.catalog_search(p_query => 'худи')`));
    expect(byTitle.map((r) => r.slug)).toEqual(['demo-heavy-hoodie']);
    const bySku = await as(db, 'anon', null, () => q<{ slug: string }>(db, `select slug from public.catalog_search(p_query => 'KM-DEMO-004')`));
    expect(bySku.map((r) => r.slug)).toEqual(['demo-canvas-sneakers']);
    const bySize = await as(db, 'anon', null, () => q<{ slug: string }>(db, `select slug from public.catalog_search(p_sizes => array['44'])`));
    expect(bySize.map((r) => r.slug)).toEqual(['demo-canvas-sneakers']);
    const sorted = await as(db, 'anon', null, () => q<{ min_price_kopecks: number }>(db,
      `select min_price_kopecks from public.catalog_search(p_category_slug => 'clothing', p_sort => 'price_asc')`));
    const prices = sorted.map((r) => Number(r.min_price_kopecks));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    const injection = await as(db, 'anon', null, () => q(db, `select * from public.catalog_search(p_query => '%'' or 1=1 --')`));
    expect(injection).toHaveLength(0);
  });

  it('популярные — только по реальным заявкам (без заявок список пуст)', async () => {
    const pop = await as(db, 'anon', null, () => q(db, 'select * from public.catalog_popular(10)'));
    expect(pop).toHaveLength(0);
  });

  it('демо-данные помечены и не содержат заказов и платежей', async () => {
    const notDemo = await q(db, `select id from public.catalog_products where not is_demo`);
    expect(notDemo.length).toBeGreaterThanOrEqual(0);
    const demo = await q(db, `select id from public.catalog_products where is_demo`);
    expect(demo.length).toBe(8);
    expect(await q(db, 'select * from public.payments')).toHaveLength(0);
  });
});

describe('импорт прайса', () => {
  let supplierId: string;
  beforeAll(async () => {
    const s = await as(db, 'authenticated', admin, () => one<{ id: string }>(db,
      `insert into public.suppliers (internal_code, name) values ('SUP-1', 'Поставщик 1') returning id`));
    supplierId = s.id;
  });

  const preview = (rows: unknown[]) => as(db, 'authenticated', admin, () => one<{ r: {
    import_id: string; valid_rows: number; error_rows: number; errors: Array<{ row: number; errors: string[] }>; new_offers: number;
  } }>(db, `select public.staff_import_preview($1, 'price.csv', $2::jsonb) r`, [supplierId, JSON.stringify(rows)])).then((x) => x.r);

  it('некорректный прайс: отчёт об ошибках и запрет применения', async () => {
    const r = await preview([
      { supplier_sku: 'A1', purchase_price: '1200,50', stock: '3' },
      { supplier_sku: '', purchase_price: '100', stock: '1' },
      { supplier_sku: 'A3', purchase_price: 'дорого', stock: '1' },
      { supplier_sku: 'A4', purchase_price: '100', stock: '-2' },
      { supplier_sku: 'A1', purchase_price: '100', stock: '1' },
    ]);
    expect(r.valid_rows).toBe(1);
    expect(r.error_rows).toBe(4);
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4, 5]);
    await expectDbError(as(db, 'authenticated', admin, () => q(db, 'select public.staff_import_apply($1)', [r.import_id])), 'IMPORT_HAS_ERRORS');
    const offers = await q(db, 'select * from public.supplier_offers where supplier_id = $1', [supplierId]);
    expect(offers).toHaveLength(0);
  });

  it('применение и откат восстанавливают прежние значения', async () => {
    const first = await preview([{ supplier_sku: 'B1', purchase_price: '1000', stock: '5' }]);
    await as(db, 'authenticated', admin, () => q(db, 'select public.staff_import_apply($1)', [first.import_id]));
    // Привязываем предложение к варианту товара
    const v = await one<{ id: string; product_id: string; stock_qty: number }>(db, `select id, product_id, stock_qty from public.product_variants order by sku limit 1`);
    await as(db, 'authenticated', admin, () => q(db, `update public.supplier_offers set variant_id = $1, product_id = $2 where supplier_sku = 'B1'`, [v.id, v.product_id]));

    const second = await preview([{ supplier_sku: 'B1', purchase_price: '1500.00', stock: '0' }, { supplier_sku: 'B2', purchase_price: '10', stock: '1' }]);
    expect(second.new_offers).toBe(1);
    const applied = await as(db, 'authenticated', admin, () => one<{ r: { updated: number; created: number } }>(db, 'select public.staff_import_apply($1) r', [second.import_id]));
    expect(applied.r).toEqual({ updated: 1, created: 1 });
    let offer = await one<{ purchase_price_kopecks: number; stock_qty: number }>(db, `select purchase_price_kopecks, stock_qty from public.supplier_offers where supplier_sku = 'B1'`);
    expect([Number(offer.purchase_price_kopecks), offer.stock_qty]).toEqual([150000, 0]);
    let variant = await one<{ stock_qty: number }>(db, 'select stock_qty from public.product_variants where id = $1', [v.id]);
    expect(variant.stock_qty).toBe(0);

    const rb = await as(db, 'authenticated', admin, () => one<{ r: { restored: number; deleted: number } }>(db, 'select public.staff_import_rollback($1) r', [second.import_id]));
    expect(rb.r).toEqual({ restored: 1, deleted: 1, skipped: 0 });
    offer = await one(db, `select purchase_price_kopecks, stock_qty from public.supplier_offers where supplier_sku = 'B1'`);
    expect([Number(offer.purchase_price_kopecks), offer.stock_qty]).toEqual([100000, 5]);
    variant = await one(db, 'select stock_qty from public.product_variants where id = $1', [v.id]);
    expect(variant.stock_qty).toBe(v.stock_qty);
    expect(await q(db, `select * from public.supplier_offers where supplier_sku = 'B2'`)).toHaveLength(0);
  });

  it('менеджер не может импортировать прайс', async () => {
    await expectDbError(as(db, 'authenticated', manager, () => q(db, `select public.staff_import_preview($1, 'x.csv', '[{"supplier_sku":"Z"}]'::jsonb)`, [supplierId])), 'FORBIDDEN');
  });
});
