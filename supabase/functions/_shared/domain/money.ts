// Деньги храним и считаем в целых копейках (bigint в БД, integer в JS — суммы магазина далеко от 2^53).

export type Kopecks = number;

export function assertKopecks(v: number): Kopecks {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Invalid kopecks amount: ${v}`);
  return v;
}

/** «1 234,50» / «1234.5» / «1234» → копейки. Возвращает null для некорректного ввода. */
export function parseRublesToKopecks(input: string): Kopecks | null {
  const s = input.replace(/\s| /g, '').replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [rub, kop = ''] = s.split('.');
  return Number(rub) * 100 + Number(kop.padEnd(2, '0'));
}

const rubFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

/** 249000 → «2 490 ₽», 249050 → «2 490,5 ₽» (неразрывные пробелы) */
export function formatRub(kopecks: Kopecks | null | undefined): string {
  if (kopecks === null || kopecks === undefined) return '—';
  const rub = kopecks / 100;
  const text = Number.isInteger(rub) ? rubFormatter.format(rub) : rub.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${text.replace(/\s/g, ' ')} ₽`;
}

export function kopecksToRublesInput(kopecks: Kopecks | null | undefined): string {
  if (kopecks === null || kopecks === undefined) return '';
  const rub = Math.floor(kopecks / 100);
  const kop = kopecks % 100;
  return kop === 0 ? String(rub) : `${rub},${String(kop).padStart(2, '0')}`;
}
