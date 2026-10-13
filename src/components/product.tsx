import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { imageUrl } from '@/lib/supabase';
import type { CatalogProduct, StockState } from '@/lib/types';
import { Price, DemoBadge, Skeleton } from './ui';
import { IconImage } from './icons';

export function ProductImage({ src, alt, className, eager }: { src: string | null; alt: string; className?: string; eager?: boolean }) {
  const url = imageUrl(src);
  return (
    <div className={clsx('relative overflow-hidden bg-concrete', className)}>
      {url ? (
        <img src={url} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-fog"><IconImage size={28} /><span className="sr-only">Нет фото</span></div>
      )}
    </div>
  );
}

export function stockText(state: StockState): string {
  if (state === 'in_stock') return 'В наличии';
  if (state === 'needs_confirmation') return 'Наличие уточняется';
  return 'Нет в наличии';
}

export function StockLine({ state, confirmedAt, className }: { state: StockState; confirmedAt?: string | null; className?: string }) {
  return (
    <span className={clsx('flex items-center gap-1.5 text-sm', state === 'in_stock' ? 'text-moss' : state === 'needs_confirmation' ? 'text-amber' : 'text-fog', className)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', state === 'in_stock' ? 'bg-moss' : state === 'needs_confirmation' ? 'bg-amber' : 'bg-fog')} aria-hidden />
      <span>
        {stockText(state)}
        {confirmedAt && state !== 'out_of_stock' ? <span className="text-fog">{`, проверено ${formatRelative(confirmedAt)}`}</span> : null}
      </span>
    </span>
  );
}

export function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffH = (Date.now() - d.getTime()) / 3_600_000;
  if (diffH < 1) return 'менее часа назад';
  if (diffH < 24) return `${Math.floor(diffH)} ч назад`;
  const days = Math.floor(diffH / 24);
  if (days < 7) return `${days} дн. назад`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function ProductCard({ p, priority }: { p: CatalogProduct; priority?: boolean }) {
  const soldOut = p.stock_state === 'out_of_stock';
  const range = p.min_price_kopecks !== p.max_price_kopecks;
  return (
    <Link to={`/product/${p.slug}`} className="group block focus-visible:outline-offset-4">
      <div className="relative">
        <ProductImage src={p.cover_ref} alt={p.title} eager={priority} className={clsx('aspect-[4/5]', soldOut && 'opacity-55')} />
        <div className="absolute left-2 top-2 flex gap-1">
          {p.is_demo ? <DemoBadge /> : null}
          {soldOut ? <span className="bg-paper px-2 py-0.5 text-xs">Нет в наличии</span> : null}
        </div>
      </div>
      <div className="flex flex-col gap-0.5 px-0.5 pt-2">
        {p.brand_name ? <span className="truncate text-xs text-graphite">{p.brand_name}</span> : null}
        <span className="line-clamp-2 text-sm leading-[18px]">{p.title}</span>
        <span className="mt-0.5 text-sm font-semibold">
          {range ? <span className="font-normal text-graphite">от </span> : null}
          <Price kopecks={p.min_price_kopecks} />
        </span>
      </div>
    </Link>
  );
}

export function ProductGrid({ items, loading }: { items: CatalogProduct[] | undefined; loading?: boolean }) {
  if (loading && !items?.length) {
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 px-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}><Skeleton className="aspect-[4/5]" /><Skeleton className="mt-2 h-3 w-3/4" /><Skeleton className="mt-1.5 h-3 w-1/3" /></div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-6 px-4">
      {(items ?? []).map((p, i) => <ProductCard key={p.id} p={p} priority={i < 4} />)}
    </div>
  );
}

export function ProductRail({ items }: { items: CatalogProduct[] }) {
  return (
    <div className="no-scrollbar flex snap-x gap-3 overflow-x-auto px-4">
      {items.map((p) => (
        <div key={p.id} className="w-[42%] shrink-0 snap-start"><ProductCard p={p} /></div>
      ))}
    </div>
  );
}

const LETTER_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL'];
/** Размеры по порядку: буквенные XS→XXL, числовые по возрастанию, остальные — как есть */
export function sortSizes(sizes: string[]): string[] {
  const rank = (s: string) => {
    const i = LETTER_SIZES.indexOf(s.toUpperCase());
    if (i >= 0) return i;
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) ? 100 + n : 10_000;
  };
  return [...sizes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

