import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { variantsByIds } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { useSession } from '@/lib/session';
import { cartTotals, type CartLine } from '@shared/checkout';
import { PageHeader } from '@/components/layout';
import { ProductImage, StockLine } from '@/components/product';
import { Button, EmptyState, Notice, Price, Stepper } from '@/components/ui';
import { IconTrash } from '@/components/icons';

/** Сверяем корзину с актуальными данными витрины: цена, наличие, доступность варианта */
function useRevalidatedCart() {
  const cart = useCart();
  const ids = cart.lines.map((l) => l.variantId).sort();
  const fresh = useQuery({ queryKey: ['cart-variants', ids], queryFn: () => variantsByIds(ids), enabled: ids.length > 0, staleTime: 15_000 });
  const [changes, setChanges] = useState<string[]>([]);

  useEffect(() => {
    if (!fresh.data) return;
    const byId = new Map(fresh.data.map((v) => [v.id, v]));
    const notes: string[] = [];
    let changed = false;
    const next: CartLine[] = cart.lines.map((l) => {
      const v = byId.get(l.variantId);
      if (!v) {
        if (l.stockState !== 'out_of_stock') { notes.push(`«${l.title}» больше недоступен`); changed = true; }
        return { ...l, stockState: 'out_of_stock', stockQty: 0 };
      }
      const upd: CartLine = { ...l, unitPriceKopecks: v.price_kopecks, stockQty: v.stock_qty, stockState: v.stock_state, minQty: v.min_qty, maxQty: v.max_qty };
      if (v.price_kopecks !== l.unitPriceKopecks) { notes.push(`«${l.title}»: цена изменилась`); changed = true; }
      if (v.stock_state !== l.stockState || v.stock_qty !== l.stockQty) changed = true;
      if (v.stock_state !== 'out_of_stock' && l.quantity > v.stock_qty) {
        notes.push(`«${l.title}»: доступно ${v.stock_qty} шт.`);
        upd.quantity = Math.max(1, v.stock_qty);
        changed = true;
      }
      return upd;
    });
    if (changed) cart.replace(next);
    if (notes.length) setChanges((prev) => [...new Set([...prev, ...notes])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh.data]);

  return { cart, changes, dismiss: () => setChanges([]), checking: fresh.isFetching, failed: fresh.isError };
}

export default function CartPage() {
  const { cart, changes, dismiss, checking, failed } = useRevalidatedCart();
  const session = useSession();
  const navigate = useNavigate();
  const totals = cartTotals(cart.lines);
  const available = cart.lines.filter((l) => l.stockState !== 'out_of_stock');

  if (cart.lines.length === 0) {
    return (
      <div>
        <PageHeader title="Корзина" />
        <EmptyState title="В корзине пусто" text="Добавьте товары из каталога — оформление займёт пару минут."
          action={<Link to="/catalog"><Button>Перейти в каталог</Button></Link>} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Корзина" sub={`${totals.itemsCount} шт.`} />

      {changes.length ? (
        <Notice tone="warn" className="mx-4 mb-3">
          <p className="font-medium">Корзина обновлена</p>
          <ul className="mt-1 list-disc pl-5">{changes.map((c) => <li key={c}>{c}</li>)}</ul>
          <button className="mt-2 underline underline-offset-4" onClick={dismiss}>Понятно</button>
        </Notice>
      ) : null}
      {failed ? <Notice tone="bad" className="mx-4 mb-3">Не удалось проверить актуальные цены. Итог пересчитается при оформлении.</Notice> : null}

      <ul className="divide-y divide-line border-y border-line">
        {cart.lines.map((l) => {
          const out = l.stockState === 'out_of_stock';
          return (
            <li key={l.variantId} className="flex gap-3 px-4 py-4">
              <Link to={`/product/${l.slug}`} className="w-[84px] shrink-0">
                <ProductImage src={l.imageRef} alt={l.title} className={out ? 'aspect-[4/5] opacity-50' : 'aspect-[4/5]'} />
              </Link>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/product/${l.slug}`} className="line-clamp-2 text-sm leading-[18px]">{l.title}</Link>
                  <button onClick={() => cart.remove(l.variantId)} aria-label={`Удалить ${l.title}`} className="-mr-1 -mt-1 p-1 text-graphite"><IconTrash size={20} /></button>
                </div>
                <p className="mt-0.5 text-sm text-graphite">{[l.color, l.size && `размер ${l.size}`].filter(Boolean).join(', ')}</p>
                <StockLine state={l.stockState} className="mt-1 text-xs" />
                <div className="mt-auto flex items-end justify-between pt-2">
                  {out ? <span className="text-sm text-graphite">Не войдёт в заказ</span> : (
                    <Stepper value={l.quantity} min={l.minQty} max={Math.max(l.minQty, Math.min(l.maxQty, l.stockQty))} onChange={(v) => cart.setQty(l.variantId, v)} label={`Количество: ${l.title}`} />
                  )}
                  <div className="text-right">
                    <Price kopecks={l.unitPriceKopecks * l.quantity} className={out ? 'text-fog line-through' : 'font-semibold'} />
                    {l.quantity > 1 && !out ? <p className="text-xs text-graphite"><Price kopecks={l.unitPriceKopecks} /> за шт.</p> : null}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <dl className="space-y-2 px-4 pt-5 text-sm">
        <div className="flex justify-between"><dt className="text-graphite">Товары</dt><dd><Price kopecks={totals.itemsTotalKopecks} /></dd></div>
        <div className="flex justify-between"><dt className="text-graphite">Доставка</dt><dd className="text-graphite">согласует менеджер</dd></div>
        <div className="flex justify-between pt-2 text-md font-semibold"><dt>Итого без доставки</dt><dd><Price kopecks={totals.totalKopecks} /></dd></div>
      </dl>
      <p className="px-4 pt-3 text-sm text-graphite">Окончательную сумму, наличие и стоимость доставки подтвердит менеджер. Оплата при оформлении не производится.</p>

      <div className="px-4 pt-5">
        {session.status === 'authenticated' ? (
          <Button block size="lg" disabled={available.length === 0 || checking} loading={checking} onClick={() => navigate('/checkout')}>Оформить заказ</Button>
        ) : session.status === 'loading' ? (
          <Button block size="lg" loading disabled>Оформить заказ</Button>
        ) : (
          <Notice>Оформить заказ можно в Telegram: откройте магазин через бота KEEP MARKET — корзину нужно будет собрать там.</Notice>
        )}
      </div>
    </div>
  );
}
