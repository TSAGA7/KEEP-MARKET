// Автоартикулы и импорт товаров из постов через бота
import { beforeAll, describe, expect, it } from 'vitest';
import { as, createDb, createProfile, expectDbError, grantRole, one, q, type Db } from './harness';

let db: Db;
let owner: string, manager: string;

const upsert = (tg: number, key: string, o: Partial<{ title: string; desc: string; raw: string; price: number | null; sizes: string[]; source: object }> = {}) =>
  as(db, 'service_role', null, () => one<{ r: { product_id: string; created: boolean; cost_kopecks: number | null; retail_kopecks: number } }>(db,
    `select public.bot_import_upsert($1, $2, $3, $4, $5, $6, $7, $8::jsonb) r`,
    [tg, key, o.title ?? 'Худи', o.desc ?? 'Описание товара из поста', o.raw ?? 'Худи\nОписание', o.price ?? null, o.sizes ?? [], JSON.stringify(o.source ?? { slug_base: 'hudi' })]))
    .then((x) => x.r);

beforeAll(async () => {
  db = await createDb();
  owner = await createProfile(db, 9001, 'owner');
  manager = await createProfile(db, 9002, 'mgr');
  await grantRole(db, owner, 'owner');
  await grantRole(db, manager, 'manager');
});

describe('артикулы', () => {
  it('генерируются автоматически для товара и вариантов, если не указаны', async () => {
    const cat = await one<{ id: string }>(db, `select id from public.categories where slug = 'clothing'`);
    const p = await as(db, 'authenticated', owner, () => one<{ id: string; sku: string }>(db,
      `insert into public.products (slug, title, category_id, price_kopecks) values ('auto-sku', 'Товар', $1, 1000) returning id, sku`, [cat.id]));
    expect(p.sku).toMatch(/^KM-\d{6}$/);
    const v = await as(db, 'authenticated', owner, () => one<{ sku: string }>(db,
      `insert into public.product_variants (product_id, size) values ($1, 'M') returning sku`, [p.id]));
    expect(v.sku).toMatch(new RegExp(`^${p.sku}-\\d{4}$`));
    const manual = await as(db, 'authenticated', owner, () => one<{ sku: string }>(db,
      `insert into public.products (slug, title, sku, price_kopecks) values ('manual-sku', 'Товар 2', ' MY-1 ', 1000) returning sku`));
    expect(manual.sku).toBe('MY-1');
  });
});

describe('импорт из поста', () => {
  it('создаёт черновик: непроверенный, с закупочной ценой, вариантами без остатка', async () => {
    const r = await upsert(9001, 'album:1', { price: 1_290_000, sizes: ['S', 'M', 'L'] });
    expect(r.created).toBe(true);
    expect(r.cost_kopecks).toBe(1_290_000);
    const p = await one<{ status: string; compliance_status: string; price_kopecks: number; sku: string }>(db,
      'select status, compliance_status, price_kopecks, sku from public.products where id = $1', [r.product_id]);
    expect(p).toMatchObject({ status: 'draft', compliance_status: 'pending_review' });
    expect(Number(p.price_kopecks)).toBe(0);
    expect(p.sku).toMatch(/^KM-/);
    const vs = await q<{ size: string; stock_qty: number }>(db, 'select size, stock_qty from public.product_variants where product_id = $1 order by sort_order', [r.product_id]);
    expect(vs).toEqual([{ size: 'S', stock_qty: 0 }, { size: 'M', stock_qty: 0 }, { size: 'L', stock_qty: 0 }]);
    // На витрине черновика нет
    expect(await q(db, 'select id from public.catalog_products where id = $1', [r.product_id])).toHaveLength(0);
  });

  it('повтор того же альбома не создаёт второй товар; фото добавляются в очередь обработки', async () => {
    const a = await upsert(9001, 'album:2');
    const b = await upsert(9001, 'album:2');
    expect(b).toMatchObject({ product_id: a.product_id, created: false });
    for (const [i, path] of ['x/1.jpg', 'x/2.jpg'].entries()) {
      await as(db, 'service_role', null, () => q(db, 'select public.bot_import_add_photo($1, $2, $3, $4)', [a.product_id, 'album:2', path, 100 + i]));
    }
    const imgs = await q<{ processing_status: string; original_storage_path: string }>(db,
      'select processing_status, original_storage_path from public.product_images where product_id = $1 order by sort_order', [a.product_id]);
    expect(imgs).toEqual([{ processing_status: 'pending', original_storage_path: 'x/1.jpg' }, { processing_status: 'pending', original_storage_path: 'x/2.jpg' }]);
  });

  it('наценка из настроек рассчитывает розничную цену', async () => {
    await db.query(`update public.store_settings set value = '30' where key = 'import_markup_percent'`);
    const r = await upsert(9001, 'album:3', { price: 1_000_000 });
    expect(r.retail_kopecks).toBe(1_300_000);
    await db.query(`update public.store_settings set value = 'null' where key = 'import_markup_percent'`);
  });

  it('поставщик определяется по каналу', async () => {
    const s = await one<{ id: string }>(db, `insert into public.suppliers (internal_code, name, telegram_chat_id) values ('TG-1', 'Канал', -100123) returning id`);
    const r = await upsert(9001, 'album:4', { source: { chat_id: -100123, slug_base: 'x' } });
    const p = await one<{ supplier_id: string }>(db, 'select supplier_id from public.products where id = $1', [r.product_id]);
    expect(p.supplier_id).toBe(s.id);
  });

  it('импорт доступен только owner/admin и только через service_role', async () => {
    await expectDbError(upsert(9002, 'album:5'), 'FORBIDDEN');
    await expectDbError(upsert(5555, 'album:6'), 'FORBIDDEN');
    await expectDbError(as(db, 'authenticated', owner, () => q(db, `select public.bot_import_upsert(9001, 'k', 't', 'd', 'r', null, '{}', '{}')`)), 'permission denied');
  });

  it('переключение фото: обработанное ↔ оригинал', async () => {
    const r = await upsert(9001, 'album:7');
    await as(db, 'service_role', null, () => q(db, 'select public.bot_import_add_photo($1, $2, $3, 1)', [r.product_id, 'album:7', 'p/orig.jpg']));
    const img = await one<{ id: string }>(db, 'select id from public.product_images where product_id = $1', [r.product_id]);
    await db.query(`update public.product_images set storage_path = 'p/proc.jpg', processed_storage_path = 'p/proc.jpg', processing_status = 'done' where id = $1`, [img.id]);
    await as(db, 'authenticated', owner, () => q(db, `select public.staff_image_use_version($1, 'original')`, [img.id]));
    expect((await one<{ storage_path: string }>(db, 'select storage_path from public.product_images where id = $1', [img.id])).storage_path).toBe('p/orig.jpg');
    await expectDbError(as(db, 'authenticated', manager, () => q(db, `select public.staff_image_use_version($1, 'processed')`, [img.id])), 'FORBIDDEN');
  });
});
