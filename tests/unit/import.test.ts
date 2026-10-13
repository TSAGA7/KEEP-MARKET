import { describe, expect, it } from 'vitest';
import { parsePriceKopecks, parseSizes, parseSupplierPost } from '@shared/import';

describe('разбор поста поставщика', () => {
  const post = `🔥 Худи на молнии с потёртостями 🔥
Плотный футер 480 г, оверсайз
Размеры: S-XL
Цена: 12 900₽
Для заказа пишите @supplier_manager или +7 (999) 123-45-67
https://t.me/supplier_channel
#худи #новинка`;

  it('название, описание без контактов поставщика', () => {
    const p = parseSupplierPost(post);
    expect(p.title).toBe('Худи на молнии с потёртостями');
    expect(p.description).toBe('Плотный футер 480 г, оверсайз');
    expect(p.description).not.toMatch(/@|t\.me|999|#/);
    expect(p.slugBase).toBe('hudi-na-molnii-s-potertostyami');
  });

  it('цена и размеры', () => {
    const p = parseSupplierPost(post);
    expect(p.priceKopecks).toBe(1_290_000);
    expect(p.sizes).toEqual(['S', 'M', 'L', 'XL']);
  });

  it('разные форматы цены', () => {
    expect(parsePriceKopecks('Стоимость 4500 руб')).toBe(450_000);
    expect(parsePriceKopecks('всего 12.900 р')).toBe(1_290_000);
    expect(parsePriceKopecks('Цена — 7 990')).toBe(799_000);
    expect(parsePriceKopecks('Было 9 900₽, стало 7 900₽')).toBe(790_000);
    expect(parsePriceKopecks('Плотность 480 г')).toBeNull();
  });

  it('размеры: числовые диапазоны и список', () => {
    expect(parseSizes('Размеры 40-44')).toEqual(['40', '41', '42', '43', '44']);
    expect(parseSizes('р-р: 41, 42, 43.5')).toEqual(['41', '42', '43.5']);
    expect(parseSizes('S M L XL')).toEqual(['S', 'M', 'L', 'XL']);
    expect(parseSizes('Отличная вещь на каждый день')).toEqual([]);
  });

  it('пост без подписи', () => {
    const p = parseSupplierPost(null);
    expect(p).toMatchObject({ title: '', description: '', priceKopecks: null, sizes: [] });
  });
});
