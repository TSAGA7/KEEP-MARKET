import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCsv, priceRowsFromCsv } from '@shared/csv';
import { ORDER_STATUSES, ORDER_TRANSITIONS, PAYMENT_STATUSES, availableStaffActions, canTransition, humanizeError } from '@shared/orders';
import { createDb, one } from '../db/harness';

describe('CSV-прайс', () => {
  it('разбирает кавычки, ; и переносы строк', () => {
    const rows = parseCsv('артикул;цена;остаток\r\n"A;1";"1 200,50";3\n"B ""кв""";10;0\n');
    expect(rows).toEqual([['артикул', 'цена', 'остаток'], ['A;1', '1 200,50', '3'], ['B "кв"', '10', '0']]);
  });

  it('распознаёт русские заголовки и сообщает об отсутствующих колонках', () => {
    const ok = priceRowsFromCsv('Артикул поставщика,Наименование,Цена,Остаток,Размеры\nX1,Худи,5000,2,S|M\n');
    expect(ok.mapping.missing).toEqual([]);
    expect(ok.rows[0]).toMatchObject({ supplier_sku: 'X1', title: 'Худи', purchase_price: '5000', stock: '2', sizes: 'S|M' });
    const bad = priceRowsFromCsv('артикул;название\nX;Y');
    expect(bad.mapping.missing).toEqual(['purchase_price', 'stock']);
    expect(bad.rows).toEqual([]);
  });

  it('незакрытая кавычка — ошибка файла', () => {
    expect(() => parseCsv('a;b\n"x;1')).toThrow('незакрытая кавычка');
  });

  it('пример прайса из репозитория корректен', () => {
    const text = readFileSync(new URL('../../docs/examples/supplier-price.csv', import.meta.url), 'utf8');
    const r = priceRowsFromCsv(text);
    expect(r.mapping.missing).toEqual([]);
    expect(r.rows.length).toBeGreaterThan(0);
  });
});

describe('статусы: frontend и база совпадают', () => {
  it('матрица переходов идентична order_transition_allowed() в Postgres', async () => {
    const db = await createDb();
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const r = await one<{ ok: boolean }>(db, 'select public.order_transition_allowed($1, $2) ok', [from, to]);
        expect(r.ok, `${from} -> ${to}`).toBe(canTransition(from, to));
      }
    }
    const cs = await one<{ def: string }>(db, `select pg_get_constraintdef(oid) def from pg_constraint where conname = 'orders_payment_status_check'`);
    for (const s of PAYMENT_STATUSES) expect(cs.def).toContain(`'${s}'`);
    expect(cs.def).not.toContain(`'paid_pending'`);
  });

  it('из отменённого заказа нет переходов; у каждого статуса есть действия', () => {
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
    for (const s of ORDER_STATUSES) expect(availableStaffActions(s).length).toBeGreaterThan(0);
  });

  it('ошибки сервера переводятся в понятный текст', () => {
    expect(humanizeError('PAYMENT_REQUIRED_BEFORE_SUPPLIER')).toContain('после подтверждённой оплаты');
    expect(humanizeError('some internal SQL text')).toBe('Что-то пошло не так. Попробуйте ещё раз');
  });
});
