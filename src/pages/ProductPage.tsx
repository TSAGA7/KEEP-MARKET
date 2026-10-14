import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getProduct, getPublicSettings, similarProducts } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { useFavorites } from '@/lib/favorites';
import { useSession } from '@/lib/session';
import { haptic } from '@/lib/telegram';
import type { CatalogVariant } from '@/lib/types';
import { Gallery, ProductRail, StockLine, sortSizes } from '@/components/product';
import { Button, Chip, DemoBadge, EmptyState, ErrorState, Price, SectionTitle, Skeleton, Stepper } from '@/components/ui';
import { IconChevronDown, IconHeart } from '@/components/icons';
import { useToast } from '@/components/toast';

function Details({ title, children, defaultOpen }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group border-b border-line" open={defaultOpen}>
      <summary className="flex h-14 cursor-pointer list-none items-center justify-between font-medium [&::-webkit-details-marker]:hidden">
        {title}<IconChevronDown className="text-fog transition-transform group-open:rotate-180" />
      </summary>
      <div className="whitespace-pre-line pb-4 text-graphite">{children}</div>
    </details>
  );
}

export default function ProductPage() {
  const { slug = '' } = useParams();
  const q = useQuery({ queryKey: ['product', slug], queryFn: () => getProduct(slug) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: getPublicSettings });
  const similar = useQuery({ queryKey: ['similar', q.data?.product.id], queryFn: () => similarProducts(q.data!.product.id), enabled: !!q.data });
  const cart = useCart();
  const fav = useFavorites();
  const session = useSession();
  const toast = useToast();

  const variants = q.data?.variants ?? [];
  const colors = useMemo(() => [...new Map(variants.filter((v) => v.color).map((v) => [v.color as string, v.color_hex])).entries()], [variants]);
  const [color, setColor] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    // Единственный цвет выбирается автоматически
    if (colors.length === 1 && !color) setColor(colors[0]![0]);
  }, [colors, color]);

  const sizesForColor = useMemo(() => {
    const list = variants.filter((v) => v.size && (!colors.length || !color || v.color === color));
    const order = sortSizes([...new Set(variants.map((v) => v.size).filter(Boolean))] as string[]);
    return order.map((s) => ({ size: s, variant: list.find((v) => v.size === s) ?? null }));
  }, [variants, color, colors.length]);

  const needsColor = colors.length > 0;
  const needsSize = variants.some((v) => v.size);
  const selected: CatalogVariant | null = useMemo(() => {
    if (!variants.length) return null;
    if (!needsColor && !needsSize) return variants[0] ?? null;
    return variants.find((v) => (!needsColor || v.color === color) && (!needsSize || v.size === size)) ?? null;
  }, [variants, needsColor, needsSize, color, size]);

  useEffect(() => { setQty(1); }, [selected?.id]);

  if (q.isLoading) {
    return <div><Skeleton className="aspect-[4/5] w-full" /><div className="space-y-3 p-4"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-5 w-1/3" /></div></div>;
  }
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  if (!q.data) {
    return <EmptyState title="Товар не найден" text="Возможно, он снят с продажи или ссылка устарела." action={<Link to="/catalog" className="underline underline-offset-4">Перейти в каталог</Link>} />;
  }

  const { product, images } = q.data;
  const price = selected?.price_kopecks ?? product.min_price_kopecks;
  const maxQty = selected ? Math.max(selected.min_qty, Math.min(selected.max_qty, selected.stock_qty)) : 1;
  const soldOut = selected ? selected.stock_state === 'out_of_stock' : product.stock_state === 'out_of_stock';
  const isFav = fav.has(product.id);
  const deliveryInfo = typeof settings.data?.delivery_info === 'string' ? settings.data.delivery_info : null;
  const returnPolicy = typeof settings.data?.return_policy === 'string' ? settings.data.return_policy : null;
  const missingChoice = (needsColor && !color) ? 'Выберите цвет' : (needsSize && !size) ? 'Выберите размер' : null;

  const addToCart = () => {
    if (!selected) {
      setShowErrors(true);
      haptic('error');
      return;
    }
    if (selected.stock_state === 'out_of_stock') return;
    cart.add({
      variantId: selected.id, productId: product.id, slug: product.slug, title: product.title,
      size: selected.size, color: selected.color, imageRef: images[0]?.image_ref ?? product.cover_ref,
      unitPriceKopecks: selected.price_kopecks, quantity: qty, minQty: selected.min_qty, maxQty: selected.max_qty,
      stockQty: selected.stock_qty, stockState: selected.stock_state,
    });
    toast('Добавлено в корзину', 'success');
  };

  return (
    <article>
      <div className="relative">
        <Gallery images={images} title={product.title} />
        <button
          onClick={() => (fav.enabled ? fav.toggle(product.id) : toast('Избранное доступно при входе через Telegram', 'info'))}
          aria-pressed={isFav} aria-label={isFav ? 'Убрать из избранного' : 'Добавить в избранное'}
          className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center bg-paper/90">
          <IconHeart filled={isFav} />
        </button>
        {product.is_demo ? <div className="absolute left-3 top-3"><DemoBadge /></div> : null}
      </div>

      <div className="px-4 pt-5">
        {product.brand_name ? <p className="text-sm text-graphite">{product.brand_name}</p> : null}
        <h1 className="mt-1 font-display text-xl leading-tight">{product.title}</h1>
        <div className="mt-4">
          <span key={price} className="hang-tag animate-tag text-md font-semibold"><Price kopecks={price} /></span>
        </div>
        <StockLine state={selected?.stock_state ?? product.stock_state} confirmedAt={selected?.stock_confirmed_at ?? product.stock_confirmed_at} className="mt-3" />
        {(selected?.stock_state ?? product.stock_state) === 'needs_confirmation' ? (
          <p className="mt-3 text-sm text-graphite">Остаток давно не подтверждался поставщиком. Заявку можно оформить — менеджер проверит наличие до оплаты.</p>
        ) : null}

        {needsColor ? (
          <fieldset className="mt-6">
            <legend className="mb-2 text-sm text-graphite">Цвет{color ? <span className="text-ink">: {color}</span> : null}</legend>
            <div className="flex flex-wrap gap-2">
              {colors.map(([c, hex]) => (
                <Chip key={c} active={color === c} onClick={() => { setColor(c); setSize(null); haptic('select'); }}>
                  <span className="inline-flex items-center gap-2">{hex ? <span className="h-3.5 w-3.5 ring-1 ring-inset ring-black/15" style={{ background: hex }} aria-hidden /> : null}{c}</span>
                </Chip>
              ))}
            </div>
          </fieldset>
        ) : null}

        {needsSize ? (
          <fieldset className="mt-5">
            <legend className="mb-2 text-sm text-graphite">Размер</legend>
            <div className="flex flex-wrap gap-2">
              {sizesForColor.map(({ size: s, variant }) => {
                const unavailable = !variant || variant.stock_state === 'out_of_stock';
                return (
                  <Chip key={s} active={size === s} disabled={unavailable} title={unavailable ? 'Нет в наличии' : undefined}
                    onClick={() => { setSize(s); haptic('select'); }}>{s}</Chip>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        {showErrors && missingChoice ? <p className="mt-3 text-sm text-rust" role="alert">{missingChoice}</p> : null}

        {selected && !soldOut ? (
          <div className="mt-5 flex items-center gap-3">
            <Stepper value={qty} min={selected.min_qty} max={maxQty} onChange={setQty} label="Количество" />
            <span className="text-sm text-graphite">{selected.stock_qty <= 3 ? `осталось ${selected.stock_qty} шт.` : ''}</span>
          </div>
        ) : null}

        <div className="mt-8">
          {product.description ? <Details title="Описание" defaultOpen>{product.description}</Details> : null}
          {product.materials || product.care ? (
            <Details title="Состав и уход">{[product.materials, product.care].filter(Boolean).join('\n\n')}</Details>
          ) : null}
          {product.size_chart?.rows?.length ? (
            <Details title="Таблица размеров">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-ink">
                  <thead><tr>{product.size_chart.columns.map((c) => <th key={c} className="py-1.5 pr-3 font-medium">{c}</th>)}</tr></thead>
                  <tbody>{product.size_chart.rows.map((r, i) => <tr key={i} className="border-t border-line">{r.map((c, j) => <td key={j} className="num py-1.5 pr-3">{c}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </Details>
          ) : null}
          <Details title="Доставка">{deliveryInfo ?? 'Способ и стоимость доставки менеджер согласует после проверки наличия.'}</Details>
          <Details title="Возврат">{returnPolicy ?? 'Условия возврата уточняйте у менеджера.'}</Details>
          <div className="flex h-14 items-center justify-between text-sm text-graphite">
            <span>Артикул</span><span className="num text-ink">{selected?.sku ?? product.sku}</span>
          </div>
        </div>
      </div>

      {similar.data && similar.data.length > 0 ? (
        <section className="pb-6">
          <SectionTitle>Похожие товары</SectionTitle>
          <ProductRail items={similar.data} />
        </section>
      ) : null}

      <div className="sticky z-30 border-t border-line bg-paper px-4 py-3" style={{ bottom: 'calc(var(--nav-h) + var(--safe-bottom))' }}>
        {soldOut ? (
          <Button block size="lg" variant="secondary" disabled>Нет в наличии</Button>
        ) : (
          <Button block size="lg" onClick={addToCart} className={selected ? 'justify-between' : undefined} aria-describedby={missingChoice ? 'choice-hint' : undefined}>
            {selected ? <><span>Добавить в корзину</span><Price kopecks={price * qty} /></> : missingChoice ?? 'Добавить в корзину'}
          </Button>
        )}
        {missingChoice ? <span id="choice-hint" className="sr-only">{missingChoice}</span> : null}
        {session.status === 'guest' && !session.insideTelegram ? (
          <p className="mt-2 text-center text-xs text-graphite">Оформить заказ можно в Telegram-приложении KEEP MARKET</p>
        ) : null}
      </div>
    </article>
  );
}
