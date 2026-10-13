// RLS и серверная проверка ролей
import { beforeAll, describe, expect, it } from 'vitest';
import { as, createDb, createProfile, createSellableProduct, expectDbError, grantRole, one, orderPayload, q, type Db } from './harness';

let db: Db;
let owner: string, admin: string, manager: string, alice: string, bob: string;
let product: { productId: string; variantId: string };

beforeAll(async () => {
  db = await createDb();
  owner = await createProfile(db, 1001, 'owner');
  admin = await createProfile(db, 1002, 'admin');
  manager = await createProfile(db, 1003, 'manager');
  alice = await createProfile(db, 2001, 'alice');
  bob = await createProfile(db, 2002, 'bob');
  await grantRole(db, owner, 'owner');
  await grantRole(db, admin, 'admin');
  await grantRole(db, manager, 'manager');
  product = await createSellableProduct(db, { slug: 'sec-tee', price: 150000 });
  await db.query(`insert into public.product_costs (product_id, purchase_price_kopecks) values ($1, 70000)`, [product.productId]);
});

describe('витрина и закрытые данные', () => {
  it('anon видит каталог, но не таблицу products', async () => {
    const rows = await as(db, 'anon', null, () => q(db, 'select id, price_kopecks from public.catalog_products'));
    expect(rows).toHaveLength(1);
    await expectDbError(as(db, 'anon', null, () => q(db, 'select * from public.products')), 'permission denied');
  });

  it('публичный слой не содержит закупочных цен и внутренних полей', async () => {
    const cols = await q<{ column_name: string }>(db,
      `select column_name from information_schema.columns where table_name in ('catalog_products', 'catalog_variants')`);
    const names = cols.map((c) => c.column_name);
    for (const forbidden of ['purchase_price_kopecks', 'internal_notes', 'supplier_id', 'compliance_notes', 'supplier_documents_reference']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('покупатель не читает закупочные цены, предложения поставщиков и таблицу products', async () => {
    const costs = await as(db, 'authenticated', alice, () => q(db, 'select * from public.product_costs'));
    expect(costs).toHaveLength(0);
    const offers = await as(db, 'authenticated', alice, () => q(db, 'select * from public.supplier_offers'));
    expect(offers).toHaveLength(0);
    const prods = await as(db, 'authenticated', alice, () => q(db, 'select * from public.products'));
    expect(prods).toHaveLength(0);
  });

  it('менеджер видит товары, но не закупочные цены', async () => {
    const prods = await as(db, 'authenticated', manager, () => q(db, 'select id from public.products'));
    expect(prods.length).toBeGreaterThan(0);
    const costs = await as(db, 'authenticated', manager, () => q(db, 'select * from public.product_costs'));
    expect(costs).toHaveLength(0);
    const ownerCosts = await as(db, 'authenticated', owner, () => q(db, 'select * from public.product_costs'));
    expect(ownerCosts).toHaveLength(1);
  });

  it('покупатель не может изменять каталог', async () => {
    await as(db, 'authenticated', alice, () => q(db, `update public.products set price_kopecks = 1`));
    const p = await one<{ price_kopecks: number }>(db, 'select price_kopecks from public.products where id = $1', [product.productId]);
    expect(Number(p.price_kopecks)).toBe(150000);
    await expectDbError(
      as(db, 'authenticated', alice, () => q(db, `insert into public.categories (name, slug) values ('x', 'x')`)),
      'row-level security');
  });
});

describe('роли', () => {
  it('пользователь не может выдать себе роль напрямую', async () => {
    await expectDbError(
      as(db, 'authenticated', alice, () => q(db, `insert into public.user_roles (user_id, role) values ($1, 'owner')`, [alice])),
      'permission denied');
  });

  it('покупатель и менеджер не могут назначать роли', async () => {
    await expectDbError(as(db, 'authenticated', alice, () => q(db, `select public.staff_set_role($1, 'manager', true)`, [bob])), 'FORBIDDEN');
    await expectDbError(as(db, 'authenticated', manager, () => q(db, `select public.staff_set_role($1, 'manager', true)`, [bob])), 'FORBIDDEN');
  });

  it('admin может назначить менеджера, но не администратора и не владельца', async () => {
    await as(db, 'authenticated', admin, () => q(db, `select public.staff_set_role($1, 'manager', true)`, [bob]));
    const roles = await q(db, `select role from public.user_roles where user_id = $1`, [bob]);
    expect(roles).toEqual([{ role: 'manager' }]);
    await expectDbError(as(db, 'authenticated', admin, () => q(db, `select public.staff_set_role($1, 'admin', true)`, [bob])), 'FORBIDDEN');
    await expectDbError(as(db, 'authenticated', owner, () => q(db, `select public.staff_set_role($1, 'owner', true)`, [bob])), 'ROLE_NOT_ASSIGNABLE');
    await as(db, 'authenticated', owner, () => q(db, `select public.staff_set_role($1, 'manager', false)`, [bob]));
  });

  it('второй владелец невозможен, bootstrap доступен только service_role', async () => {
    await expectDbError(q(db, `insert into public.user_roles (user_id, role) values ($1, 'owner')`, [alice]), 'duplicate key');
    await expectDbError(as(db, 'authenticated', alice, () => q(db, `select public.bootstrap_owner(2001)`)), 'permission denied');
    await expectDbError(as(db, 'service_role', null, () => q(db, `select public.bootstrap_owner(2001)`)), 'OWNER_ALREADY_EXISTS');
  });

  it('прямой вызов админских RPC без прав блокируется', async () => {
    await expectDbError(as(db, 'authenticated', alice, () => q(db, `select public.staff_dashboard()`)), 'FORBIDDEN');
    await expectDbError(as(db, 'anon', null, () => q(db, `select public.staff_dashboard()`)), 'permission denied');
    const d = await as(db, 'authenticated', manager, () => one<{ d: Record<string, unknown> }>(db, `select public.staff_dashboard() d`));
    expect(d.d).not.toHaveProperty('paid_amount_kopecks'); // финансы — только owner/admin
    const d2 = await as(db, 'authenticated', owner, () => one<{ d: Record<string, unknown> }>(db, `select public.staff_dashboard() d`));
    expect(d2.d).toHaveProperty('paid_orders_cost_kopecks');
  });

  it('журнал аудита нельзя изменить', async () => {
    await expectDbError(q(db, `update public.audit_logs set action = 'x'`), 'AUDIT_LOG_IMMUTABLE');
  });
});

describe('заказы чужих покупателей', () => {
  let orderId: string;
  beforeAll(async () => {
    const r = await as(db, 'authenticated', alice, () => one<{ r: { order_id: string } }>(db,
      `select public.create_order_request($1::jsonb) r`,
      [JSON.stringify(orderPayload([{ variant_id: product.variantId, quantity: 1, expected_unit_price_kopecks: 150000 }]))]));
    orderId = r.r.order_id;
  });

  it('Bob не видит заказ, позиции, контакты и историю Alice', async () => {
    for (const t of ['orders', 'order_items', 'order_contacts', 'order_status_history']) {
      const rows = await as(db, 'authenticated', bob, () => q(db, `select * from public.${t}`));
      expect(rows, t).toHaveLength(0);
    }
    const own = await as(db, 'authenticated', alice, () => q(db, `select id from public.orders`));
    expect(own).toEqual([{ id: orderId }]);
  });

  it('Bob не может подтвердить или отменить заказ Alice', async () => {
    await expectDbError(as(db, 'authenticated', bob, () => q(db, `select public.customer_cancel_order($1, 'x')`, [orderId])), 'ORDER_NOT_FOUND');
  });

  it('покупатель не может менять заказ напрямую и вызывать действия менеджера', async () => {
    await expectDbError(as(db, 'authenticated', alice, () => q(db, `update public.orders set total_kopecks = 1`)), 'permission denied');
    await expectDbError(as(db, 'authenticated', alice, () => q(db, `select public.staff_order_action($1, 'start_check', '{}')`, [orderId])), 'FORBIDDEN');
  });

  it('сотрудник читает контакты только через функцию, просмотр попадает в журнал', async () => {
    const direct = await as(db, 'authenticated', manager, () => q(db, `select * from public.order_contacts`));
    expect(direct).toHaveLength(0);
    const c = await as(db, 'authenticated', manager, () => one<{ c: { phone: string } }>(db, `select public.staff_get_order_contact($1) c`, [orderId]));
    expect(c.c.phone).toBe('+79000000000');
    const log = await q(db, `select actor_id from public.audit_logs where action = 'pd_viewed' and entity_id = $1`, [orderId]);
    expect(log).toEqual([{ actor_id: manager }]);
  });
});
