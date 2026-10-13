// Платежи: создаются только после подтверждения; webhook идемпотентен; отказ; возврат
import { beforeAll, describe, expect, it } from 'vitest';
import { as, createDb, createProfile, createSellableProduct, expectDbError, grantRole, one, orderPayload, q, type Db } from './harness';

let db: Db;
let owner: string, manager: string, alice: string;
let tee: { productId: string; variantId: string };

const svc = <T>(sql: string, params: unknown[] = []) => as(db, 'service_role', null, () => one<T>(db, sql, params));
const action = (orderId: string, act: string, payload: unknown = {}) =>
  as(db, 'authenticated', manager, () => one<{ r: { status: string } }>(db,
    `select public.staff_order_action($1, $2, $3::jsonb) r`, [orderId, act, JSON.stringify(payload)])).then((x) => x.r);

async function confirmedOnlineOrder(): Promise<string> {
  const r = await as(db, 'authenticated', alice, () => one<{ r: { order_id: string } }>(db, 'select public.create_order_request($1::jsonb) r',
    [JSON.stringify(orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 300000 }]))]));
  const id = r.r.order_id;
  await action(id, 'start_check');
  const item = await one<{ id: string }>(db, 'select id from public.order_items where order_id = $1', [id]);
  await action(id, 'record_availability', { items: [{ item_id: item.id, availability: 'confirmed' }], delivery_kopecks: 40000, customer_agreed_in_chat: true });
  await action(id, 'set_payment_method', { payment_method: 'online' });
  return id;
}

async function preparePayment(orderId: string, customer = alice) {
  const r = await svc<{ r: { payment_id: string; amount_kopecks: number; reused: boolean } }>(
    `select public.customer_payment_prepare($1, $2, 'mock', true) r`, [customer, orderId]);
  await svc(`select public.payment_attach_provider($1, $2, 'https://pay.test/x') as x`, [r.r.payment_id, `mock_${r.r.payment_id}`]);
  return r.r;
}

const event = (key: string, providerPaymentId: string, status: string, amount: number) =>
  svc<{ r: { result: string } }>(`select public.payment_apply_event('mock', $1, $2, 'payment.' || $3, $3, $4, '{}'::jsonb) r`,
    [key, providerPaymentId, status, amount]).then((x) => x.r.result);

beforeAll(async () => {
  db = await createDb();
  owner = await createProfile(db, 5001, 'owner');
  manager = await createProfile(db, 5002, 'mgr');
  alice = await createProfile(db, 6001, 'alice');
  await grantRole(db, owner, 'owner');
  await grantRole(db, manager, 'manager');
  await db.query(`update public.store_settings set value = 'true' where key = 'online_payment_enabled'`);
  tee = await createSellableProduct(db, { slug: 'pay-tee', price: 300000, stock: 50 });
});

describe('платежи', () => {
  it('платёж нельзя создать для неподтверждённой заявки', async () => {
    const r = await as(db, 'authenticated', alice, () => one<{ r: { order_id: string } }>(db, 'select public.create_order_request($1::jsonb) r',
      [JSON.stringify(orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 300000 }]))]));
    await expectDbError(svc(`select public.customer_payment_prepare($1, $2, 'mock', true)`, [alice, r.r.order_id]), 'ORDER_NOT_CONFIRMED');
  });

  it('покупатель не может вызвать подготовку платежа напрямую', async () => {
    const id = await confirmedOnlineOrder();
    await expectDbError(as(db, 'authenticated', alice, () => q(db, `select public.customer_payment_prepare($1, $2, 'mock', true)`, [alice, id])), 'permission denied');
    await expectDbError(as(db, 'authenticated', alice, () => q(db, `select public.payment_apply_event('mock','k','p','t','succeeded',1,'{}')`)), 'permission denied');
  });

  it('чужой заказ оплатить нельзя', async () => {
    const id = await confirmedOnlineOrder();
    const bob = await createProfile(db, 6002, 'bob');
    await expectDbError(svc(`select public.customer_payment_prepare($1, $2, 'mock', true)`, [bob, id]), 'ORDER_NOT_FOUND');
  });

  it('успешный платёж подтверждается только уведомлением; повторное уведомление не обрабатывается дважды', async () => {
    const id = await confirmedOnlineOrder();
    const pay = await preparePayment(id);
    expect(pay.amount_kopecks).toBe(340000);
    // Повторный запрос возвращает тот же активный платёж
    const again = await svc<{ r: { payment_id: string; reused: boolean } }>(`select public.customer_payment_prepare($1, $2, 'mock', true) r`, [alice, id]);
    expect(again.r).toMatchObject({ payment_id: pay.payment_id, reused: true });

    let o = await one<{ payment_status: string }>(db, 'select payment_status from public.orders where id = $1', [id]);
    expect(o.payment_status).toBe('awaiting_payment');
    // Нельзя передать поставщику до оплаты (онлайн-сценарий)
    await expectDbError(action(id, 'send_to_supplier'), 'PAYMENT_REQUIRED_BEFORE_SUPPLIER');

    expect(await event('evt-1', `mock_${pay.payment_id}`, 'succeeded', 340000)).toBe('succeeded');
    expect(await event('evt-1', `mock_${pay.payment_id}`, 'succeeded', 340000)).toBe('duplicate');
    // Запоздавшее pending не откатывает успешный платёж
    expect(await event('evt-2', `mock_${pay.payment_id}`, 'pending', 340000)).toBe('ignored_regression');
    o = await one(db, 'select payment_status from public.orders where id = $1', [id]);
    expect(o.payment_status).toBe('paid');
    const evts = await q(db, 'select * from public.payment_events where payment_id = $1', [pay.payment_id]);
    expect(evts).toHaveLength(2);
    expect((await action(id, 'send_to_supplier')).status).toBe('supplier_processing');
  });

  it('неуспешный платёж не меняет статус заказа на оплачен, можно повторить', async () => {
    const id = await confirmedOnlineOrder();
    const pay = await preparePayment(id);
    expect(await event('evt-f1', `mock_${pay.payment_id}`, 'failed', 340000)).toBe('failed');
    const o = await one<{ payment_status: string; status: string }>(db, 'select payment_status, status from public.orders where id = $1', [id]);
    expect(o).toEqual({ payment_status: 'unpaid', status: 'confirmed' });
    const retry = await preparePayment(id);
    expect(retry.payment_id).not.toBe(pay.payment_id);
  });

  it('несовпадение суммы переводит заказ в «проблема», а не в «оплачен»', async () => {
    const id = await confirmedOnlineOrder();
    const pay = await preparePayment(id);
    expect(await event('evt-m1', `mock_${pay.payment_id}`, 'succeeded', 100)).toBe('amount_mismatch');
    const o = await one<{ payment_status: string; status: string }>(db, 'select payment_status, status from public.orders where id = $1', [id]);
    expect(o).toEqual({ payment_status: 'awaiting_payment', status: 'issue' });
  });

  it('уведомление о неизвестном платеже фиксируется и не влияет на заказы', async () => {
    expect(await event('evt-x', 'mock_unknown', 'succeeded', 1)).toBe('payment_not_found');
  });

  it('возврат: частичный, затем полный; сумма не может превысить оплату; менеджеру недоступно', async () => {
    const id = await confirmedOnlineOrder();
    const pay = await preparePayment(id);
    await event('evt-r0', `mock_${pay.payment_id}`, 'succeeded', 340000);
    await expectDbError(as(db, 'authenticated', manager, () => q(db, `select public.staff_refund_prepare($1, 1000, 'тест')`, [pay.payment_id])), 'FORBIDDEN');
    await expectDbError(as(db, 'authenticated', owner, () => q(db, `select public.staff_refund_prepare($1, 999999, 'много')`, [pay.payment_id])), 'REFUND_AMOUNT_INVALID');

    const r1 = await as(db, 'authenticated', owner, () => one<{ r: { refund_id: string } }>(db, `select public.staff_refund_prepare($1, 40000, 'Возврат доставки') r`, [pay.payment_id]));
    await svc(`select public.refund_apply_result($1, 'succeeded', 'rf_1') x`, [r1.r.refund_id]);
    // Повторная обработка результата — без двойного списания
    const dup = await svc<{ x: { result: string } }>(`select public.refund_apply_result($1, 'succeeded', 'rf_1') x`, [r1.r.refund_id]);
    expect(dup.x.result).toBe('already_processed');
    let o = await one<{ payment_status: string }>(db, 'select payment_status from public.orders where id = $1', [id]);
    expect(o.payment_status).toBe('partially_refunded');

    // Отменить оплаченный заказ без возврата нельзя
    await expectDbError(action(id, 'cancel', { reason: 'клиент отказался' }), 'REFUND_REQUIRED_BEFORE_CANCEL');

    const r2 = await as(db, 'authenticated', owner, () => one<{ r: { refund_id: string } }>(db, `select public.staff_refund_prepare($1, 300000, 'Полный возврат') r`, [pay.payment_id]));
    await svc(`select public.refund_apply_result($1, 'succeeded', 'rf_2') x`, [r2.r.refund_id]);
    o = await one(db, 'select payment_status from public.orders where id = $1', [id]);
    expect(o.payment_status).toBe('refunded');
    const p = await one<{ status: string; refunded_kopecks: number }>(db, 'select status, refunded_kopecks from public.payments where id = $1', [pay.payment_id]);
    expect(p).toEqual({ status: 'refunded', refunded_kopecks: 340000 });
  });

  it('офлайн-оплата фиксируется только owner/admin и только для согласованного офлайн-способа', async () => {
    const r = await as(db, 'authenticated', alice, () => one<{ r: { order_id: string } }>(db, 'select public.create_order_request($1::jsonb) r',
      [JSON.stringify(orderPayload([{ variant_id: tee.variantId, quantity: 1, expected_unit_price_kopecks: 300000 }]))]));
    const id = r.r.order_id;
    await expectDbError(as(db, 'authenticated', owner, () => q(db, `select public.staff_register_offline_payment($1, 300000, 'перевод')`, [id])), 'ORDER_NOT_CONFIRMED');
    await action(id, 'start_check');
    const item = await one<{ id: string }>(db, 'select id from public.order_items where order_id = $1', [id]);
    await action(id, 'record_availability', { items: [{ item_id: item.id, availability: 'confirmed' }], delivery_kopecks: 0, customer_agreed_in_chat: true });
    await action(id, 'set_payment_method', { payment_method: 'manual_transfer' });
    await expectDbError(as(db, 'authenticated', manager, () => q(db, `select public.staff_register_offline_payment($1, 300000, 'перевод')`, [id])), 'FORBIDDEN');
    await as(db, 'authenticated', owner, () => q(db, `select public.staff_register_offline_payment($1, 300000, 'Перевод по счёту №1')`, [id]));
    const o = await one<{ payment_status: string }>(db, 'select payment_status from public.orders where id = $1', [id]);
    expect(o.payment_status).toBe('paid');
  });
});
