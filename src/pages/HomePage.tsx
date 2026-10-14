import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getBanners, getCategories, getCollections, getPublicSettings, popularProducts, searchCatalog } from '@/lib/api';
import { imageUrl } from '@/lib/supabase';
import { openTelegramLink } from '@/lib/telegram';
import { useSession } from '@/lib/session';
import type { Banner, CatalogProduct } from '@/lib/types';
import { Wordmark } from '@/components/layout';
import { ProductGrid, ProductRail } from '@/components/product';
import { DemoBadge, DiscountBadge, ErrorState, SalePrice, SectionTitle, Skeleton } from '@/components/ui';
import { IconChevronRight, IconEdit, IconSearch, IconSend } from '@/components/icons';

function bannerHref(b: Banner): string | null {
  switch (b.link_type) {
    case 'product': return b.link_value ? `/product/${b.link_value}` : null;
    case 'category': return b.link_value ? `/catalog?category=${encodeURIComponent(b.link_value)}` : '/catalog';
    case 'collection': return b.link_value ? `/catalog?collection=${encodeURIComponent(b.link_value)}` : '/catalog';
    case 'catalog': return '/catalog';
    default: return null;
  }
}

function Hero({ banners }: { banners: Banner[] }) {
  const [i, setI] = useState(0);
  const b = banners[i];
  if (!b) return null;
  const href = bannerHref(b);
  const img = imageUrl(b.image_ref);
  const body = (
    <div className="relative aspect-square w-full overflow-hidden bg-concrete">
      {img ? <img src={img} alt="" className="h-full w-full object-cover" /> : null}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-5 pt-24 text-white">
        {b.is_demo ? <div className="mb-2"><DemoBadge /></div> : null}
        <p className="font-display text-2xl font-bold leading-[1.05]">{b.title}</p>
        {b.subtitle ? <p className="mt-2 max-w-[30ch] text-sm text-white/85">{b.subtitle}</p> : null}
      </div>
    </div>
  );
  return (
    <section aria-label="Главное" className="relative">
      {href ? <Link to={href} className="block">{body}</Link> : body}
      {banners.length > 1 ? (
        <div className="absolute right-4 top-4 flex gap-1.5" role="tablist" aria-label="Баннеры">
          {banners.map((x, idx) => (
            <button key={x.id} role="tab" aria-selected={idx === i} aria-label={`Баннер ${idx + 1}`} onClick={() => setI(idx)}
              className={idx === i ? 'h-1.5 w-6 bg-white' : 'h-1.5 w-1.5 bg-white/60'} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

type HomeSections = { in_stock: boolean; new: boolean; popular: boolean; collections: boolean };
const DEFAULT_SECTIONS: HomeSections = { in_stock: true, new: true, popular: true, collections: true };

/** Случайный порядок (Фишер — Йейтс) */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** Верхний блок главной: листаемая подборка случайных товаров из наличия (и настоящие баннеры, если они есть) */
function Showcase({ products, banners }: { products: CatalogProduct[]; banners: Banner[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const touched = useRef(false);
  const count = banners.length + products.length;

  useEffect(() => {
    // Автопрокрутка каждые 5 с, пока человек сам не начал листать
    if (count < 2) return;
    const t = window.setInterval(() => {
      const el = ref.current;
      if (!el || touched.current) return;
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % count;
      el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
    }, 5000);
    return () => window.clearInterval(t);
  }, [count]);

  if (!count) return null;
  const go = (idx: number) => { const el = ref.current; if (el) el.scrollTo({ left: idx * el.clientWidth, behavior: 'smooth' }); };

  return (
    <section aria-label="Подборка" className="relative">
      <div ref={ref} className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto"
        onScroll={(e) => { const el = e.currentTarget; setI(Math.round(el.scrollLeft / el.clientWidth)); }}
        onTouchStart={() => { touched.current = true; }} onPointerDown={() => { touched.current = true; }}>
        {banners.map((b) => {
          const href = bannerHref(b);
          const img = imageUrl(b.image_ref);
          const body = (
            <div className="relative aspect-square w-full overflow-hidden bg-concrete">
              {img ? <img src={img} alt="" className="h-full w-full object-cover" /> : null}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-5 pt-24 text-white">
                <p className="font-display text-2xl font-bold leading-[1.05]">{b.title}</p>
                {b.subtitle ? <p className="mt-2 max-w-[30ch] text-sm text-white/85">{b.subtitle}</p> : null}
              </div>
            </div>
          );
          return <div key={b.id} className="w-full shrink-0 snap-center">{href ? <Link to={href} className="block">{body}</Link> : body}</div>;
        })}
        {products.map((p, idx) => {
          const img = imageUrl(p.cover_ref);
          return (
            <Link key={p.id} to={`/product/${p.slug}`} className="block w-full shrink-0 snap-center">
              <div className="relative aspect-square w-full overflow-hidden bg-concrete">
                {img ? <img src={img} alt={p.title} loading={idx === 0 ? 'eager' : 'lazy'} className="h-full w-full object-cover" /> : null}
                {p.discount_percent > 0 ? <div className="absolute left-4 top-4"><DiscountBadge percent={p.discount_percent} /></div> : null}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-4 pb-5 pt-28 text-white">
                  {p.brand_name ? <p className="text-sm text-white/80">{p.brand_name}</p> : null}
                  <p className="line-clamp-2 font-display text-xl font-bold leading-[1.1]">{p.title}</p>
                  <p className="mt-2 text-md font-semibold [&_s]:text-white/70 [&_.text-rust]:text-white">
                    <SalePrice kopecks={p.min_price_kopecks} oldKopecks={p.old_min_price_kopecks} />
                  </p>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
      {count > 1 ? (
        <div className="absolute right-4 top-4 flex gap-1.5" role="tablist" aria-label="Слайды">
          {Array.from({ length: count }).map((_, idx) => (
            <button key={idx} role="tab" aria-selected={idx === i} aria-label={`Слайд ${idx + 1}`} onClick={() => { touched.current = true; go(idx); }}
              className={idx === i ? 'h-1.5 w-6 bg-white' : 'h-1.5 w-1.5 bg-white/60'} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default function HomePage() {
  const session = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const banners = useQuery({ queryKey: ['banners'], queryFn: getBanners });
  const categories = useQuery({ queryKey: ['categories'], queryFn: getCategories });
  const fresh = useQuery({ queryKey: ['catalog', 'new-home'], queryFn: () => searchCatalog({ sort: 'new', limit: 6, inStock: true }) });
  // Случайные товары из наличия: берём до 60 и перемешиваем при каждом открытии главной
  const inStock = useQuery({ queryKey: ['catalog', 'in-stock-home'], queryFn: () => searchCatalog({ sort: 'new', limit: 60, inStock: true }), staleTime: 0 });
  const randomPicks = useMemo(() => shuffle((inStock.data ?? []).filter((p) => p.stock_state !== 'out_of_stock' && p.cover_ref)).slice(0, 8), [inStock.data]);
  const popular = useQuery({ queryKey: ['catalog', 'popular'], queryFn: popularProducts });
  const collections = useQuery({ queryKey: ['collections'], queryFn: getCollections });
  const settings = useQuery({ queryKey: ['settings'], queryFn: getPublicSettings });
  const firstCollection = collections.data?.[0];
  const editorial = useQuery({
    queryKey: ['catalog', 'collection', firstCollection?.slug],
    queryFn: () => searchCatalog({ collection: firstCollection?.slug, limit: 10 }),
    enabled: !!firstCollection,
  });
  const channel = typeof settings.data?.telegram_channel_url === 'string' ? (settings.data.telegram_channel_url as string) : null;
  const topCategories = (categories.data ?? []).filter((c) => !c.parent_id && c.show_on_home !== false);
  const rawSections = settings.data?.home_sections;
  const sections: HomeSections = { ...DEFAULT_SECTIONS, ...(rawSections && typeof rawSections === 'object' ? rawSections as Partial<HomeSections> : {}) };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    navigate(q.trim() ? `/catalog?q=${encodeURIComponent(q.trim())}` : '/catalog');
  };

  if (fresh.isError && banners.isError) return <ErrorState onRetry={() => { void fresh.refetch(); void banners.refetch(); }} />;

  return (
    <div>
      <header className="flex items-center justify-between px-4 pb-3 pt-4">
        <Wordmark className="text-[22px]" />
        {channel ? (
          <button onClick={() => openTelegramLink(channel)} className="inline-flex items-center gap-1.5 text-sm text-graphite">
            <IconSend size={18} /> Канал
          </button>
        ) : null}
      </header>

      <form onSubmit={onSearch} role="search" className="px-4 pb-4">
        <label className="flex h-11 items-center gap-2 bg-concrete px-3.5">
          <IconSearch size={20} className="text-graphite" />
          <span className="sr-only">Поиск по каталогу</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название или артикул" enterKeyHint="search"
            className="h-full w-full bg-transparent outline-none placeholder:text-fog" maxLength={80} />
        </label>
      </form>

      {banners.isLoading || (sections.in_stock && inStock.isLoading) ? <Skeleton className="aspect-square w-full" /> : (
        sections.in_stock && randomPicks.length > 0
          // Подборка из наличия; демо-баннеры в этом случае не показываем, настоящие — первыми слайдами
          ? <Showcase products={randomPicks} banners={(banners.data ?? []).filter((b) => !b.is_demo)} />
          : <Hero banners={banners.data ?? []} />
      )}

      {session.isAdmin ? (
        <div className="px-4 pt-4">
          <Link to="/admin/home" className="flex h-11 w-full items-center justify-center gap-2 border border-ink text-sm font-medium">
            <IconEdit size={18} /> Настроить главную
          </Link>
        </div>
      ) : null}

      <nav aria-label="Категории" className="px-4 pt-6">
        <ul className="divide-y divide-line border-y border-line">
          {topCategories.map((c) => (
            <li key={c.id}>
              <Link to={`/catalog?category=${c.slug}`} className="flex h-14 items-center justify-between font-display text-md">
                {c.name}<IconChevronRight className="text-fog" />
              </Link>
            </li>
          ))}
          {categories.isLoading ? <li className="py-3"><Skeleton className="h-6 w-1/2" /></li> : null}
        </ul>
      </nav>

      {sections.new ? (
        <>
          <SectionTitle action={<Link to="/catalog" className="text-sm text-graphite underline underline-offset-4">Весь каталог</Link>}>Новые поступления</SectionTitle>
          {fresh.isError ? <ErrorState onRetry={() => void fresh.refetch()} /> : <ProductGrid items={fresh.data} loading={fresh.isLoading} />}
          {fresh.data && fresh.data.length === 0 ? <p className="px-4 text-graphite">Скоро здесь появятся новые товары.</p> : null}
        </>
      ) : null}

      {sections.popular && popular.data && popular.data.length > 0 ? (
        <>
          <SectionTitle>Популярное</SectionTitle>
          <ProductRail items={popular.data} />
        </>
      ) : null}

      {sections.collections && firstCollection && editorial.data && editorial.data.length > 0 ? (
        <section>
          <SectionTitle action={<Link to={`/catalog?collection=${firstCollection.slug}`} className="text-sm text-graphite underline underline-offset-4">Смотреть</Link>}>
            <span className="inline-flex items-center gap-2">{firstCollection.title}{firstCollection.is_demo ? <DemoBadge /> : null}</span>
          </SectionTitle>
          {firstCollection.description ? <p className="-mt-1 px-4 pb-3 text-sm text-graphite">{firstCollection.description}</p> : null}
          <ProductRail items={editorial.data} />
        </section>
      ) : null}

      {channel ? (
        <section className="mx-4 mt-10 bg-ink p-5 text-paper">
          <p className="font-display text-lg leading-tight">Новинки и поставки — в канале KEEP MARKET</p>
          <button onClick={() => openTelegramLink(channel)} className="mt-4 inline-flex h-10 items-center gap-2 bg-paper px-4 text-sm font-medium text-ink">
            <IconSend size={18} /> Открыть канал
          </button>
        </section>
      ) : null}
    </div>
  );
}
