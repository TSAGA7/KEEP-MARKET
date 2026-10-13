// Разбор CSV-прайса поставщика (RFC 4180: кавычки, экранирование "", переносы строк в кавычках).
// Разделитель определяется автоматически: ; (Excel RU) или ,

export const PRICE_COLUMNS = {
  supplier_sku: ['supplier_sku', 'sku', 'артикул', 'артикул поставщика', 'код'],
  title: ['title', 'name', 'название', 'наименование', 'товар'],
  purchase_price: ['purchase_price', 'price', 'цена', 'закупочная цена', 'цена закупки', 'опт'],
  stock: ['stock', 'qty', 'quantity', 'остаток', 'количество', 'наличие'],
  sizes: ['sizes', 'size', 'размеры', 'размер'],
  colors: ['colors', 'color', 'цвета', 'цвет'],
} as const;
export type PriceColumn = keyof typeof PRICE_COLUMNS;
export const REQUIRED_PRICE_COLUMNS: PriceColumn[] = ['supplier_sku', 'purchase_price', 'stock'];

export function detectDelimiter(firstLine: string): ',' | ';' | '\t' {
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const candidates: Array<',' | ';' | '\t'> = [';', ',', '\t'];
  return candidates.reduce((best, c) => (count(c) > count(best) ? c : best), ';');
}

export function parseCsv(input: string, delimiter?: ',' | ';' | '\t'): string[][] {
  const text = input.replace(/^﻿/, '');
  const delim = delimiter ?? detectDelimiter(text.split(/\r?\n/, 1)[0] ?? '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (inQuotes) throw new Error('CSV: незакрытая кавычка');
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export interface PriceMapping {
  columns: Partial<Record<PriceColumn, number>>;
  missing: PriceColumn[];
  unknownHeaders: string[];
}

export function mapPriceHeaders(header: string[]): PriceMapping {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const columns: Partial<Record<PriceColumn, number>> = {};
  (Object.keys(PRICE_COLUMNS) as PriceColumn[]).forEach((col) => {
    const idx = norm.findIndex((h) => (PRICE_COLUMNS[col] as readonly string[]).includes(h));
    if (idx >= 0) columns[col] = idx;
  });
  const used = new Set(Object.values(columns));
  return {
    columns,
    missing: REQUIRED_PRICE_COLUMNS.filter((c) => columns[c] === undefined),
    unknownHeaders: header.filter((_, i) => !used.has(i)),
  };
}

export type PriceRow = Record<PriceColumn, string>;

/** Преобразует CSV в строки для серверного предпросмотра. Значения НЕ доверенные — проверяет сервер. */
export function priceRowsFromCsv(text: string, maxRows = 5000): { rows: PriceRow[]; mapping: PriceMapping } {
  const table = parseCsv(text);
  if (table.length === 0) throw new Error('Файл пуст');
  const mapping = mapPriceHeaders(table[0] as string[]);
  if (mapping.missing.length) return { rows: [], mapping };
  const body = table.slice(1);
  if (body.length > maxRows) throw new Error(`Слишком много строк: ${body.length} (максимум ${maxRows})`);
  const get = (r: string[], c: PriceColumn) => {
    const idx = mapping.columns[c];
    return idx === undefined ? '' : (r[idx] ?? '').trim().slice(0, 500);
  };
  const rows = body.map((r) => ({
    supplier_sku: get(r, 'supplier_sku'),
    title: get(r, 'title'),
    purchase_price: get(r, 'purchase_price'),
    stock: get(r, 'stock'),
    sizes: get(r, 'sizes'),
    colors: get(r, 'colors'),
  }));
  return { rows, mapping };
}
