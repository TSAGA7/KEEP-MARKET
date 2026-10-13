// Оформление заявки, серверный пересчёт, наличие, статусы, workflow менеджера
import { beforeAll, describe, expect, it } from 'vitest';
import { as, createDb, createProfile, createSellableProduct, expectDbError, grantRole, one, orderPayload, q, type Db } from './harness';

let db: Db;
let manager: string, alice: string;
let tee: { productId: string; variantId: string };
let hoodie: { productId: string; variantId: string };

type OrderResult = { ok: boolean; order_id?: string; number?: string; duplicate?: boolean; total_kopecks?: number;
  problems?: Array<{ code: string; variant_id?: string; actual?: number; available?: number }>; telegram_token?: string };

const create = (payload: unknown, user = alice) =>
  as(db, 'authenticated', user, () => one<{ r: OrderResult }>(db, `select public.create_order_request($1::jsonb) r`, [JSON.stringify(payload)]))
    .then((x) => x.r);
const action = (orderId: string, act: string, payload: unknown = {}, user = manager) =>
  as(db, 'authenticated', user, () => one<{ r: { status: string; notify: string | null } }>(db,
    `select public.staff_order_action($1, $2, $3::jsonb) r`, [orderId, act, JSON.stringify(payload)])).then((x) => x.r);

beforeAll(async () => {
  db = await createDb();
  manager = await createProfile(db, 3001, 'mgr');
  alice = await createProfile(db, 4001, 'alice');
  await grantRole(db, manager, 'manager');
  tee = await createSellableProduct(db, { slug: 'tee', price: 199000, stock: 5 });
  hoodie = await createSellableProduct(db, { slug: 'hoodie', price: 450000, stock: 2 });
});

describe('создание заявки', () => {
  it('создаёт заявку с серверным расчётом суммы и без оплаты', async () => {
    const r = await create(orderPayload([
      { variant_id: tee.variantId, quantity: 2, expected_unit_price_kopecks: 199000 },
      { variant_id: hoodie.variantId, quantity: 1, expected_unit_price_kopecks: 450000 },
    ]));
    expect(r.ok).toBe(true);
    expect(r.number).toMatch(/^KM-\d{6}-\d{5}$/);
    expect(r.total_kopecks).toBe(2 * 199000 + 450000);
    expect(r.telegram_token).toMatch(/^[A-Za-z0-9]{22}$/);
    const o = await one<{ status: string; payment_status: string; delivery_kopecks: number | null }>(db,
      'select status, payment_status, delivery_kopecks from public.orders where id = $1', [r.order_id]);
    expect(o).toEqual({ status: 'new', payment_status: 'unpaid', delivery_kopecks: null });
    expect(await q(db, 'select * from public.payments where order_id = $1', [r.order_id])).toHaveLength(0);
    const items = await q<{ title_snapshot: string; unit_price_kopecks: number }>(db,
      'select title_snapshot, unit_price_kopecks from public.order_items where order_id = $1 order by unit_price_kopecks', [r.order_id]);
    expect(items.map((i) => Number(i.unit_price_kopecks))).toEqual([199000, 450000]);
    // Остаток не резервируется и не списывается
    const v = await one<{ stock_qty: number }>(db, 'select stock_qty from public.product_variants where id = $1', [tee.variantId]);
    expect(v.stock_qty).toBe(5);
  });

  it('повторная отправка с тем же ключом не создаёт дубликат', async () => {
    const payload = orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 199000 }]);
    const a = await create(payload);
    const b = await create(payload);
    expect(b.duplicate).toBe(true);
    expect(b.order_id).toBe(a.order_id);
  });

  it('не доверяет цене клиента: при расхождении возвращает актуальную корзину и не создаёт заявку', async () => {
    const before = await one<{ c: number }>(db, 'select count(*)::int c from public.orders');
    const r = await create(orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 100 }]));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.objectContaining({ code: 'PRICE_CHANGED', actual: 199000 })]);
    const after = await one<{ c: number }>(db, 'select count(*)::int c from public.orders');
    expect(after.c).toBe(before.c);
  });

  it('недоступный (снятый с публикации) товар не оформляется', async () => {
    const hidden = await createSellableProduct(db, { slug: 'hidden-item', price: 1000 });
    await db.query(`update public.products set status = 'hidden' where id = $1`, [hidden.productId]);
    const r = await create(orderPayload([{ variant_id: hidden.variantId, quantity: 1, expected_unit_price_kopecks: 1000 }]));
    expect(r.ok).toBe(false);
    expect(r.problems?.[0]?.code).toBe('UNAVAILABLE');
  });

  it('нулевой и недостаточный остаток блокируют оформление', async () => {
    const empty = await createSellableProduct(db, { slug: 'empty', price: 1000, stock: 0 });
    const r1 = await create(orderPayload([{ variant_id: empty.variantId, quantity: 1, expected_unit_price_kopecks: 1000 }]));
    expect(r1.problems?.[0]?.code).toBe('OUT_OF_STOCK');
    const r2 = await create(orderPayload([{ variant_id: hoodie.variantId, quantity: 3, expected_unit_price_kopecks: 450000 }]));
    expect(r2.problems?.[0]).toMatchObject({ code: 'INSUFFICIENT_STOCK', available: 2 });
  });

  it('неактуальный остаток: заявка создаётся, но позиция помечена как требующая проверки', async () => {
    const stale = await createSellableProduct(db, { slug: 'stale', price: 5000, stock: 4, confirmedHoursAgo: 200 });
    const cat = await one<{ stock_state: string }>(db, 'select stock_state from public.catalog_products where id = $1', [stale.productId]);
    expect(cat.stock_state).toBe('needs_confirmation');
    const r = await create(orderPayload([{ variant_id: stale.variantId, quantity: 1, expected_unit_price_kopecks: 5000 }]));
    expect(r.ok).toBe(true);
    const it = await one<{ stock_was_fresh: boolean }>(db, 'select stock_was_fresh from public.order_items where order_id = $1', [r.order_id]);
    expect(it.stock_was_fresh).toBe(false);
  });

  it('неопубликованный (черновик) товар нельзя заказать даже по прямому id варианта', async () => {
    const p = await createSellableProduct(db, { slug: 'back-to-draft', price: 1000 });
    await db.query(`update public.products set status = 'draft' where id = $1`, [p.productId]);
    const r = await create(orderPayload([{ variant_id: p.variantId, quantity: 1, expected_unit_price_kopecks: 1000 }]));
    expect(r.problems?.[0]?.code).toBe('UNAVAILABLE');
  });

  it('валидация данных получателя и доставки на сервере', async () => {
    const base = [{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 199000 }];
    await expectDbError(create(orderPayload(base, { consent_pd: false })), 'consent_pd');
    await expectDbError(create(orderPayload(base, { contact: { recipient_name: 'Иван', phone: '123' } })), 'phone');
    await expectDbError(create(orderPayload(base, { delivery_method: 'russian_post', address: { city: 'Тверь', street: 'Ленина', house: '1' } })), 'POSTAL_CODE_REQUIRED');
    await expectDbError(create(orderPayload(base, { delivery_method: 'keep_courier_moscow', address: { full_address: 'кор' } })), 'FULL_ADDRESS_REQUIRED');
    await expectDbError(create(orderPayload(base, { address: { pickup_mode: 'manual', city: 'Москва', pickup_point_address: 'ул. 1', passport: '1234' } })), 'PASSPORT_NOT_ALLOWED');
    await expectDbError(create(orderPayload(base, { delivery_method: 'teleport' })), 'delivery_method');
    const ok = await create(orderPayload(base, { delivery_method: 'russian_post', address: { city: 'Тверь', street: 'Ленина', house: '1', postal_code: '170000' } }));
    expect(ok.ok).toBe(true);
  });

  it('количество вне допустимых пределов отклоняется', async () => {
    const r = await create(orderPayload([{ variant_id: tee.variantId, quantity: 0, expected_unit_price_kopecks: 199000 }]));
    expect(r.problems?.[0]?.code).toBe('QTY_INVALID');
  });
});

describe('статусы и workflow менеджера', () => {
  it('недопустимый переход статуса блокируется базой', async () => {
    const r = await create(orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 199000 }]));
    await expectDbError(q(db, `update public.orders set status = 'shipped' where id = $1`, [r.order_id]), 'INVALID_STATUS_TRANSITION');
    await expectDbError(action(r.order_id!, 'ship', { carrier: 'cdek' }), 'INVALID_STATUS_TRANSITION');
    await expectDbError(action(r.order_id!, 'send_to_supplier'), 'INVALID_STATE');
  });

  it('статус paid нельзя выставить без подтверждённого платежа', async () => {
    const r = await create(orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 199000 }]));
    await expectDbError(q(db, `update public.orders set payment_status = 'paid' where id = $1`, [r.order_id]), 'PAYMENT_STATUS_IS_MANAGED_BY_PAYMENTS');
    await db.exec(`select set_config('app.payment_ctx', 'on', false)`);
    await expectDbError(q(db, `update public.orders set payment_status = 'paid' where id = $1`, [r.order_id]), 'PAID_REQUIRES_SUCCEEDED_PAYMENT');
    await db.exec(`select set_config('app.payment_ctx', 'off', false)`);
  });

  it('полный цикл: отсутствие позиции → изменение условий → подтверждение покупателем → поставщик → отправка → доставка', async () => {
    const r = await create(orderPayload([
      { variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 199000 },
      { variant_id: hoodie.variantId, quantity: 1, expected_unit_price_kopecks: 450000 },
    ]));
    const id = r.order_id!;
    expect((await action(id, 'start_check')).status).toBe('checking_availability');

    const items = await q<{ id: string; unit_price_kopecks: number }>(db,
      'select id, unit_price_kopecks from public.order_items where order_id = $1 order by unit_price_kopecks', [id]);
    // Изменение цены без причины запрещено
    await expectDbError(action(id, 'record_availability', {
      items: [{ item_id: items[0]!.id, availability: 'confirmed', new_unit_price_kopecks: 210000 }],
    }), 'PRICE_CHANGE_REASON_REQUIRED');

    const res = await action(id, 'record_availability', {
      items: [
        { item_id: items[0]!.id, availability: 'confirmed' },
        { item_id: items[1]!.id, availability: 'unavailable', note: 'Нет у поставщика' },
      ],
      delivery_kopecks: 35000, eta_text: '3–5 дней',
    });
    expect(res.status).toBe('awaiting_customer_confirmation');
    expect(res.notify).toBe('needs_confirmation');
    const o1 = await one<{ total_kopecks: number; items_total_kopecks: number }>(db,
      'select total_kopecks, items_total_kopecks from public.orders where id = $1', [id]);
    expect(Number(o1.items_total_kopecks)).toBe(199000); // недоступная позиция исключена
    expect(Number(o1.total_kopecks)).toBe(199000 + 35000);
    // Никаких платежей/возвратов при отсутствии товара
    expect(await q(db, 'select * from public.payments where order_id = $1', [id])).toHaveLength(0);
    expect(await q(db, 'select * from public.refunds where order_id = $1', [id])).toHaveLength(0);

    const conf = await as(db, 'authenticated', alice, () => one<{ r: { status: string } }>(db, 'select public.customer_confirm_order($1) r', [id]));
    expect(conf.r.status).toBe('confirmed');

    await expectDbError(action(id, 'send_to_supplier'), 'PAYMENT_METHOD_REQUIRED');
    await expectDbError(action(id, 'set_payment_method', { payment_method: 'online' }), 'PAYMENT_METHOD_NOT_ALLOWED'); // онлайн выключен
    await action(id, 'set_payment_method', { payment_method: 'cash_on_delivery' });
    expect((await action(id, 'send_to_supplier')).status).toBe('supplier_processing');
    expect((await action(id, 'ready_to_ship')).status).toBe('ready_to_ship');
    const shipped = await action(id, 'ship', { carrier: 'cdek', tracking_number: '1234567890' });
    expect(shipped.status).toBe('shipped');
    expect(shipped.notify).toBe('shipped');
    expect((await action(id, 'deliver')).status).toBe('delivered');

    const hist = await q<{ to_status: string }>(db, 'select to_status from public.order_status_history where order_id = $1 order by id', [id]);
    expect(hist.map((h) => h.to_status)).toEqual(['new', 'checking_availability', 'awaiting_customer_confirmation', 'confirmed',
      'supplier_processing', 'ready_to_ship', 'shipped', 'delivered']);
    const ship = await one<{ tracking_number: string; status: string }>(db, 'select tracking_number, status from public.shipments where order_id = $1', [id]);
    expect(ship).toEqual({ tracking_number: '1234567890', status: 'delivered' });
  });

  it('отмена требует причины; при отсутствии товара — отмена без фиктивных платежей', async () => {
    const r = await create(orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 199000 }]));
    await action(r.order_id!, 'start_check');
    const item = await one<{ id: string }>(db, 'select id from public.order_items where order_id = $1', [r.order_id]);
    await expectDbError(action(r.order_id!, 'record_availability', { items: [{ item_id: item.id, availability: 'unavailable' }] }),
      'ALL_ITEMS_UNAVAILABLE_CANCEL_INSTEAD');
    await expectDbError(action(r.order_id!, 'cancel', {}), 'REASON_REQUIRED');
    const c = await action(r.order_id!, 'cancel', { reason: 'Нет в наличии у поставщика' });
    expect(c.status).toBe('cancelled');
    const o = await one<{ payment_status: string; cancel_reason: string }>(db, 'select payment_status, cancel_reason from public.orders where id = $1', [r.order_id]);
    expect(o).toEqual({ payment_status: 'unpaid', cancel_reason: 'Нет в наличии у поставщика' });
    await expectDbError(action(r.order_id!, 'start_check'), 'INVALID_STATUS_TRANSITION');
  });

  it('согласование в чате фиксируется явно и позволяет сразу подтвердить заказ', async () => {
    const r = await create(orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 199000 }]));
    await action(r.order_id!, 'start_check');
    const item = await one<{ id: string }>(db, 'select id from public.order_items where order_id = $1', [r.order_id]);
    const res = await action(r.order_id!, 'record_availability', {
      items: [{ item_id: item.id, availability: 'confirmed' }], delivery_kopecks: 0, customer_agreed_in_chat: true,
    });
    expect(res.status).toBe('confirmed');
  });

  it('покупатель может отменить неоплаченную заявку до передачи поставщику', async () => {
    const r = await create(orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 199000 }]));
    const c = await as(db, 'authenticated', alice, () => one<{ r: { status: string } }>(db, `select public.customer_cancel_order($1, 'передумал') r`, [r.order_id]));
    expect(c.r.status).toBe('cancelled');
  });
});
