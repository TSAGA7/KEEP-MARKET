import { describe, expect, it } from 'vitest';
import { applyServerProblems, cartTotals, clampQty, createOrderSchema, type CartLine } from '@shared/checkout';
import { addressSchemaFor, enabledProviders, formatAddress, SHIPPING_PROVIDERS, DELIVERY_METHODS } from '@shared/delivery';
import { formatRub, parseRublesToKopecks, kopecksToRublesInput } from '@shared/money';
import { maskSensitive, publicErrorCode } from '@shared/log';

const line = (o: Partial<CartLine> = {}): CartLine => ({
  variantId: '0b7e1c1e-3f1b-4c0a-9d6e-2a8f1b3c4d5e', productId: 'p', slug: 's', title: 'Футболка', size: 'M', color: 'Чёрный',
  imageRef: null, unitPriceKopecks: 249000, quantity: 2, minQty: 1, maxQty: 10, stockQty: 5, stockState: 'in_stock', ...o,
});

describe('расчёт корзины', () => {
  it('суммирует в копейках, доставка неизвестна до согласования', () => {
    const t = cartTotals([line(), line({ variantId: 'x', unitPriceKopecks: 99990, quantity: 3 })]);
    expect(t).toEqual({ itemsCount: 5, itemsTotalKopecks: 498000 + 299970, deliveryKopecks: null, totalKopecks: 797970, hasUnavailable: false });
    expect(cartTotals([line()], 35000).totalKopecks).toBe(498000 + 35000);
  });

  it('не учитывает закончившиеся позиции и отмечает их', () => {
    const t = cartTotals([line(), line({ variantId: 'y', stockState: 'out_of_stock' })]);
    expect(t.itemsTotalKopecks).toBe(498000);
    expect(t.hasUnavailable).toBe(true);
  });

  it('отклоняет некорректные цены и количества', () => {
    expect(() => cartTotals([line({ unitPriceKopecks: 10.5 })])).toThrow();
    expect(() => cartTotals([line({ quantity: 0 })])).toThrow();
  });

  it('ограничивает количество пределами и остатком', () => {
    expect(clampQty(50, line())).toBe(5);
    expect(clampQty(0, line())).toBe(1);
    expect(clampQty(Number.NaN, line())).toBe(1);
  });

  it('применяет ответ сервера: новая цена, удаление недоступного, уменьшение количества', () => {
    const lines = [line({ variantId: 'a', title: 'A' }), line({ variantId: 'b', title: 'B' }), line({ variantId: 'c', title: 'C', quantity: 4 })];
    const r = applyServerProblems(lines, { ok: false, problems: [
      { code: 'PRICE_CHANGED', variant_id: 'a', expected: 249000, actual: 259000 },
      { code: 'UNAVAILABLE', variant_id: 'b' },
      { code: 'INSUFFICIENT_STOCK', variant_id: 'c', available: 2 },
    ] });
    expect(r.lines.map((l) => [l.variantId, l.unitPriceKopecks, l.quantity])).toEqual([['a', 259000, 2], ['c', 249000, 2]]);
    expect(r.changes).toHaveLength(3);
  });
});

describe('валидация заявки', () => {
  const base = {
    idempotency_key: 'abcdefgh123', items: [{ variant_id: '0b7e1c1e-3f1b-4c0a-9d6e-2a8f1b3c4d5e', quantity: 1, expected_unit_price_kopecks: 100 }],
    contact: { recipient_name: 'Иван Петров', phone: '+7 (900) 000-00-00', email: '' }, consent_pd: true as const,
  };

  it('форма адреса зависит от способа доставки', () => {
    expect(createOrderSchema.safeParse({ ...base, delivery_method: 'cdek_pickup', address: { pickup_mode: 'manual', city: 'Казань', pickup_point_address: 'ул. Баумана, 1' } }).success).toBe(true);
    expect(createOrderSchema.safeParse({ ...base, delivery_method: 'cdek_pickup', address: { pickup_mode: 'widget', city: 'Казань', pickup_point_address: 'x x x' } }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, delivery_method: 'russian_post', address: { city: 'Тверь', street: 'Ленина', house: '1' } }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, delivery_method: 'russian_post', address: { city: 'Тверь', street: 'Ленина', house: '1', postal_code: '170000' } }).success).toBe(true);
    expect(createOrderSchema.safeParse({ ...base, delivery_method: 'keep_courier_moscow', address: { full_address: 'Москва, ул. Тверская, 1', preferred_interval: '10:00–14:00' } }).success).toBe(true);
    expect(createOrderSchema.safeParse({ ...base, delivery_method: 'keep_courier_moscow', address: { full_address: 'Москва, ул. Тверская, 1', passport: '1' } }).success).toBe(false);
  });

  it('требует согласие на обработку ПДн и корректный телефон', () => {
    const addr = { pickup_mode: 'manual', city: 'Казань', pickup_point_address: 'ул. Баумана, 1' };
    expect(createOrderSchema.safeParse({ ...base, consent_pd: false, delivery_method: 'cdek_pickup', address: addr }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, contact: { ...base.contact, phone: '12-34' }, delivery_method: 'cdek_pickup', address: addr }).success).toBe(false);
  });

  it('каждый способ доставки имеет адаптер в ручном режиме и схему адреса', () => {
    for (const m of DELIVERY_METHODS) {
      expect(SHIPPING_PROVIDERS[m].method).toBe(m);
      expect(SHIPPING_PROVIDERS[m].isIntegrated).toBe(false);
      expect(addressSchemaFor(m)).toBeDefined();
    }
    expect(enabledProviders({ ozon_pickup: false }).map((p) => p.method)).not.toContain('ozon_pickup');
    expect(formatAddress('cdek_pickup', { city: 'Казань', pickup_mode: 'manual', pickup_point_address: 'ул. 1' })).toContain('требует согласования');
  });
});

describe('деньги и логи', () => {
  it('форматирует и разбирает рубли', () => {
    expect(formatRub(249000)).toBe('2 490 ₽');
    expect(parseRublesToKopecks('1 234,5')).toBe(123450);
    expect(parseRublesToKopecks('12.345')).toBeNull();
    expect(parseRublesToKopecks('-1')).toBeNull();
    expect(kopecksToRublesInput(123450)).toBe('1234,50');
  });

  it('маскирует персональные данные и не раскрывает детали ошибок', () => {
    const m = maskSensitive({ order: 'KM-1', contact: { phone: '+79001234567', email: 'a@b.ru' }, initData: 'secret' }) as Record<string, unknown>;
    expect(JSON.stringify(m)).not.toContain('1234567');
    expect(JSON.stringify(m)).not.toContain('a@b.ru');
    expect(JSON.stringify(m)).not.toContain('secret');
    expect(publicErrorCode('ERROR: duplicate key value violates unique constraint "x" DETAIL: Key (phone)=(+7900) exists')).toBe('ERROR');
    expect(publicErrorCode('PAYMENT_REQUIRED_BEFORE_SUPPLIER')).toBe('PAYMENT_REQUIRED_BEFORE_SUPPLIER');
  });
});
