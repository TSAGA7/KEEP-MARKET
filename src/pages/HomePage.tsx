import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getBanners, getCategories, getCollections, getPublicSettings, popularProducts, searchCatalog } from '@/lib/api';
import { imageUrl } from '@/lib/supabase';
import { openTelegramLink } from '@/lib/telegram';
import type { Banner } from '@/lib/types';
import { Wordmark } from '@/components/layout';
import { ProductGrid, ProductRail } from '@/components/product';
import { DemoBadge, ErrorState, SectionTitle, Skeleton } from '@/components/ui';
import { IconChevronRight, IconSearch, IconSend } from '@/components/icons';

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

export default function HomePage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const banners = useQuery({ queryKey: ['banners'], queryFn: getBanners });
  const categories = useQuery({ queryKey: ['categories'], queryFn: getCategories });
  const fresh = useQuery({ queryKey: ['catalog', 'new-home'], queryFn: () => searchCatalog({ sort: 'new', limit: 6, inStock: true }) });
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
  const topCategories = (categories.data ?? []).filter((c) => !c.parent_id);

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

      {banners.isLoading ? <Skeleton className="aspect-square w-full" /> : <Hero banners={banners.data ?? []} />}

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

      <SectionTitle action={<Link to="/catalog" className="text-sm text-graphite underline underline-offset-4">Весь каталог</Link>}>Новые поступления</SectionTitle>
      {fresh.isError ? <ErrorState onRetry={() => void fresh.refetch()} /> : <ProductGrid items={fresh.data} loading={fresh.isLoading} />}
      {fresh.data && fresh.data.length === 0 ? <p className="px-4 text-graphite">Скоро здесь появятся новые товары.</p> : null}

      {popular.data && popular.data.length > 0 ? (
        <>
          <SectionTitle>Популярное</SectionTitle>
          <ProductRail items={popular.data} />
        </>
      ) : null}

      {firstCollection && editorial.data && editorial.data.length > 0 ? (
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
