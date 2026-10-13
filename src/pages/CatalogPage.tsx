import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { catalogFilters, getCategories, getCollections, searchCatalog, type CatalogQuery } from '@/lib/api';
import { ProductGrid, sortSizes } from '@/components/product';
import { Button, Chip, EmptyState, ErrorState, Input, Sheet, Checkbox } from '@/components/ui';
import { IconFilter, IconSearch, IconClose } from '@/components/icons';
import { PageHeader } from '@/components/layout';
import { parseRublesToKopecks, kopecksToRublesInput } from '@shared/money';

const PAGE = 20;
const SORTS = [
  { value: 'new', label: 'Сначала новые' },
  { value: 'price_asc', label: 'Сначала дешевле' },
  { value: 'price_desc', label: 'Сначала дороже' },
] as const;

// Фильтры живут в URL — сохраняются при переходе в карточку и обратно
function useCatalogParams() {
  const [sp, setSp] = useSearchParams();
  const query: CatalogQuery = useMemo(() => ({
    q: sp.get('q') ?? undefined,
    category: sp.get('category') ?? undefined,
    collection: sp.get('collection') ?? undefined,
    priceMin: sp.get('min') ? Number(sp.get('min')) : undefined,
    priceMax: sp.get('max') ? Number(sp.get('max')) : undefined,
    sizes: sp.getAll('size'),
    colors: sp.getAll('color'),
    sort: (SORTS.find((s) => s.value === sp.get('sort'))?.value ?? 'new'),
    inStock: sp.get('instock') === '1',
  }), [sp]);
  const update = (patch: Partial<Record<'q' | 'category' | 'collection' | 'min' | 'max' | 'sort' | 'instock', string | null>> & { size?: string[]; color?: string[] }) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'size' || k === 'color') {
        next.delete(k);
        (v as string[]).forEach((x) => next.append(k, x));
      } else if (v === null || v === '' || v === undefined) next.delete(k);
      else next.set(k, v as string);
    }
    setSp(next, { replace: true });
  };
  return { query, update };
}

export default function CatalogPage() {
  const { query, update } = useCatalogParams();
  const [qInput, setQInput] = useState(query.q ?? '');
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => setQInput(query.q ?? ''), [query.q]);

  const categories = useQuery({ queryKey: ['categories'], queryFn: getCategories });
  const collections = useQuery({ queryKey: ['collections'], queryFn: getCollections });
  const facets = useQuery({ queryKey: ['filters', query.category], queryFn: () => catalogFilters(query.category) });
  const results = useInfiniteQuery({
    queryKey: ['catalog', 'search', query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => searchCatalog({ ...query, limit: PAGE + 1, offset: pageParam }),
    getNextPageParam: (last, pages) => (last.length > PAGE ? pages.length * PAGE : undefined),
  });
  const items = results.data?.pages.flatMap((p) => p.slice(0, PAGE));
  const activeFilters = (query.sizes?.length ?? 0) + (query.colors?.length ?? 0) + (query.priceMin ? 1 : 0) + (query.priceMax ? 1 : 0) + (query.inStock ? 1 : 0);
  const top = (categories.data ?? []).filter((c) => !c.parent_id);
  const subs = (categories.data ?? []).filter((c) => c.parent_id && top.find((t) => t.slug === query.category)?.id === c.parent_id);
  const collection = collections.data?.find((c) => c.slug === query.collection);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    update({ q: qInput.trim() || null });
  };

  return (
    <div>
      <PageHeader title={collection ? collection.title : 'Каталог'} sub={collection?.description ?? undefined} />
      <form onSubmit={onSearch} role="search" className="flex gap-2 px-4 pb-3">
        <label className="flex h-11 flex-1 items-center gap-2 bg-concrete px-3.5">
          <IconSearch size={20} className="text-graphite" />
          <span className="sr-only">Поиск</span>
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Название или артикул" enterKeyHint="search" maxLength={80}
            className="h-full w-full bg-transparent outline-none placeholder:text-fog" />
          {qInput ? <button type="button" aria-label="Очистить" onClick={() => { setQInput(''); update({ q: null }); }}><IconClose size={18} /></button> : null}
        </label>
        <button type="button" onClick={() => setFiltersOpen(true)} className="relative flex h-11 w-11 items-center justify-center bg-concrete" aria-label="Фильтры">
          <IconFilter />
          {activeFilters ? <span className="num absolute -right-1 -top-1 h-5 min-w-5 bg-ink px-1 text-center text-xs leading-5 text-paper">{activeFilters}</span> : null}
        </button>
      </form>

      <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-2">
        <Chip active={!query.category} onClick={() => update({ category: null })}>Всё</Chip>
        {top.map((c) => <Chip key={c.id} active={query.category === c.slug} onClick={() => update({ category: c.slug, size: [], color: [] })}>{c.name}</Chip>)}
      </div>
      {subs.length ? (
        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-2">
          {subs.map((c) => <Chip key={c.id} active={query.category === c.slug} onClick={() => update({ category: c.slug })}>{c.name}</Chip>)}
        </div>
      ) : null}
      {collection ? (
        <div className="px-4 pb-2"><button className="text-sm underline underline-offset-4" onClick={() => update({ collection: null })}>Показать весь каталог</button></div>
      ) : null}

      <div className="flex items-center justify-between px-4 pb-4 pt-2 text-sm text-graphite">
        <span aria-live="polite">{facets.data ? `Найдено: ${items?.length ?? 0}${results.hasNextPage ? '+' : ''}` : ''}</span>
        <label className="flex items-center gap-1">
          <span className="sr-only">Сортировка</span>
          <select value={query.sort} onChange={(e) => update({ sort: e.target.value === 'new' ? null : e.target.value })}
            className="bg-transparent text-right text-ink outline-none">
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>

      {results.isError ? <ErrorState onRetry={() => void results.refetch()} /> : null}
      <ProductGrid items={items} loading={results.isLoading} />
      {!results.isLoading && items?.length === 0 ? (
        <EmptyState title="Ничего не нашлось" text="Измените запрос или сбросьте фильтры."
          action={<Button variant="secondary" onClick={() => update({ q: null, size: [], color: [], min: null, max: null, instock: null })}>Сбросить фильтры</Button>} />
      ) : null}
      {results.hasNextPage ? (
        <div className="px-4 pt-6">
          <Button variant="secondary" block loading={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>Показать ещё</Button>
        </div>
      ) : null}

      <FiltersSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} query={query} facets={facets.data} onApply={(p) => { update(p); setFiltersOpen(false); }} />
    </div>
  );
}

function FiltersSheet({ open, onClose, query, facets, onApply }: {
  open: boolean; onClose: () => void; query: CatalogQuery;
  facets?: { sizes: string[]; colors: string[]; price_min: number | null; price_max: number | null };
  onApply: (p: { size: string[]; color: string[]; min: string | null; max: string | null; instock: string | null }) => void;
}) {
  const [sizes, setSizes] = useState<string[]>([]);
  const [colors, setColors] = useState<string[]>([]);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [inStock, setInStock] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSizes(query.sizes ?? []);
    setColors(query.colors ?? []);
    setMin(kopecksToRublesInput(query.priceMin));
    setMax(kopecksToRublesInput(query.priceMax));
    setInStock(!!query.inStock);
  }, [open, query]);
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const minK = min ? parseRublesToKopecks(min) : null;
  const maxK = max ? parseRublesToKopecks(max) : null;
  const priceError = (min && minK === null) || (max && maxK === null) ? 'Введите число' : minK !== null && maxK !== null && minK > maxK ? 'Минимум больше максимума' : null;

  return (
    <Sheet open={open} onClose={onClose} title="Фильтры"
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={() => onApply({ size: [], color: [], min: null, max: null, instock: null })}>Сбросить</Button>
          <Button className="flex-[2]" disabled={!!priceError}
            onClick={() => onApply({ size: sizes, color: colors, min: minK !== null ? String(minK) : null, max: maxK !== null ? String(maxK) : null, instock: inStock ? '1' : null })}>
            Показать
          </Button>
        </div>
      }>
      <div className="flex flex-col gap-6">
        <fieldset>
          <legend className="mb-2 font-medium">Цена, ₽</legend>
          <div className="flex items-center gap-2">
            <Input inputMode="decimal" placeholder={facets?.price_min ? `от ${Math.floor(facets.price_min / 100)}` : 'от'} value={min} onChange={(e) => setMin(e.target.value)} aria-label="Цена от" />
            <span className="text-fog">—</span>
            <Input inputMode="decimal" placeholder={facets?.price_max ? `до ${Math.ceil(facets.price_max / 100)}` : 'до'} value={max} onChange={(e) => setMax(e.target.value)} aria-label="Цена до" />
          </div>
          {priceError ? <p className="mt-1 text-sm text-rust">{priceError}</p> : null}
        </fieldset>
        {facets?.sizes.length ? (
          <fieldset>
            <legend className="mb-2 font-medium">Размер</legend>
            <div className="flex flex-wrap gap-2">{sortSizes(facets.sizes).map((s) => <Chip key={s} active={sizes.includes(s)} onClick={() => setSizes(toggle(sizes, s))}>{s}</Chip>)}</div>
          </fieldset>
        ) : null}
        {facets?.colors.length ? (
          <fieldset>
            <legend className="mb-2 font-medium">Цвет</legend>
            <div className="flex flex-wrap gap-2">{facets.colors.map((c) => <Chip key={c} active={colors.includes(c)} onClick={() => setColors(toggle(colors, c))}>{c}</Chip>)}</div>
          </fieldset>
        ) : null}
        <Checkbox checked={inStock} onChange={setInStock}>Только в наличии</Checkbox>
      </div>
    </Sheet>
  );
}

