// Разбор текста поста поставщика: название, описание без контактов поставщика, цена, размеры.
// Ничего не выдумываем: если цена/размеры не найдены — поля остаются пустыми, менеджер заполнит.

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;
const URL_RE = /(https?:\/\/\S+|t\.me\/\S+|www\.\S+)/gi;
const MENTION_RE = /(^|\s)@[A-Za-z0-9_]{4,}/g;
const PHONE_RE = /(\+?\d[\d\s()\-]{9,}\d)/g;
const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;
// Служебные строки поставщиков, которые не нужны покупателю
const NOISE_LINE = /^(заказ|для заказа|по вопросам|пишите|писать|связь|контакт|менеджер|опт|наличие уточняйте|в наличии уточняйте|доставка по|отправка|оплата|предоплата|цена\s*(?:опт|для|от)|order|dm|whatsapp|ватсап|telegram|телеграм)/i;

export const LETTER_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', 'OS', 'ONE SIZE'];

export function cleanLine(s: string): string {
  return s.replace(EMOJI, '').replace(URL_RE, '').replace(MENTION_RE, '$1').replace(PHONE_RE, '').replace(HASHTAG_RE, '$1')
    .replace(/[*_~`|]+/g, '').replace(/\s{2,}/g, ' ').trim().replace(/^[-–—•·:]+\s*/, '').trim();
}

/** Цена в копейках: «12 900 ₽», «12900 руб», «Цена: 12.900», «12,900р» */
export function parsePriceKopecks(text: string): number | null {
  const candidates: number[] = [];
  const toRub = (raw: string) => {
    const digits = raw.replace(/[\s .,](?=\d{3}\b)/g, '').replace(/[\s ]/g, '');
    const n = Number(digits.replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  };
  for (const m of text.matchAll(/(\d[\d\s .,]{0,10}\d|\d)\s*(?:₽|руб(?:\.|лей|ля)?|р\.?(?=\s|$)|rub)/gi)) {
    const n = toRub(m[1] as string);
    if (n >= 100 && n <= 5_000_000) candidates.push(n);
  }
  if (!candidates.length) {
    for (const m of text.matchAll(/(?:цена|стоимость|price)\s*[:\-–—]?\s*(\d[\d\s .,]{0,10}\d)/gi)) {
      const n = toRub(m[1] as string);
      if (n >= 100 && n <= 5_000_000) candidates.push(n);
    }
  }
  if (!candidates.length) return null;
  // Если указано несколько цен (старая/новая) — берём последнюю, обычно это актуальная
  return Math.round((candidates[candidates.length - 1] as number) * 100);
}

/** Размеры: строка с «размер/size/р-р» или последовательность буквенных размеров */
export function parseSizes(text: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const v = s.toUpperCase().replace(/\s+/g, ' ').trim();
    const norm = v === 'ONE SIZE' ? 'OS' : v;
    if (norm && !out.includes(norm)) out.push(norm);
  };
  const lines = text.split(/\r?\n/);
  const sizeLines = lines.filter((l) => /(размер|размеры|р-р|р\.|size|sizes)/i.test(l));
  const scan = sizeLines.length ? sizeLines.join(' ') : '';
  const letter = /\b(XXXL|XXL|XL|XS|XXS|[2-4]XL|S|M|L|OS|ONE SIZE)\b/gi;
  if (scan) {
    // Диапазоны «S-XL», «40-44»
    for (const m of scan.matchAll(/\b(XXS|XS|S|M|L|XL|XXL)\s*[-–—]\s*(XS|S|M|L|XL|XXL|XXXL)\b/gi)) {
      const order = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
      const a = order.indexOf((m[1] as string).toUpperCase()); const b = order.indexOf((m[2] as string).toUpperCase());
      if (a >= 0 && b > a) order.slice(a, b + 1).forEach(add);
    }
    for (const m of scan.matchAll(letter)) add(m[1] as string);
    for (const m of scan.matchAll(/\b(\d{2})\s*[-–—]\s*(\d{2})\b/g)) {
      const a = Number(m[1]); const b = Number(m[2]);
      if (a >= 20 && b <= 60 && b > a && b - a <= 16) for (let x = a; x <= b; x++) add(String(x));
    }
    for (const m of scan.matchAll(/\b(\d{2}(?:[.,]5)?)\b/g)) {
      const n = Number((m[1] as string).replace(',', '.'));
      if (n >= 20 && n <= 60) add((m[1] as string).replace(',', '.'));
    }
  } else {
    // Без явной подписи берём только строку, состоящую из буквенных размеров: «S M L XL»
    for (const l of lines) {
      const tokens = l.trim().split(/[\s,/|]+/).filter(Boolean);
      if (tokens.length >= 2 && tokens.every((t) => /^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-4]XL)$/i.test(t))) tokens.forEach(add);
    }
  }
  return out.slice(0, 20);
}

const TRANSLIT: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
export function slugBase(s: string): string {
  const v = s.toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return v || 'tovar';
}

export interface ParsedPost {
  title: string;
  description: string;
  priceKopecks: number | null;
  sizes: string[];
  slugBase: string;
}

export function parseSupplierPost(caption: string | null | undefined): ParsedPost {
  const raw = (caption ?? '').slice(0, 4000);
  const lines = raw.split(/\r?\n/).map(cleanLine).filter((l) => l.length > 0);
  const content = lines.filter((l) => !NOISE_LINE.test(l) && !/^(цена|стоимость|price)(?!\p{L})/iu.test(l) && !/(₽|руб)/i.test(l)
    && !/^(размер\p{L}*|р-р|size|sizes)(?!\p{L})/iu.test(l));
  const title = (content[0] ?? '').slice(0, 120);
  const description = content.slice(1).join('\n').slice(0, 3000);
  return {
    title,
    description,
    priceKopecks: parsePriceKopecks(raw),
    sizes: parseSizes(raw),
    slugBase: slugBase(title || 'tovar'),
  };
}
