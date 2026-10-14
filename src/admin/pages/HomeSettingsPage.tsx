// Настройка главной страницы: какие категории показывать (и в каком порядке), какие блоки товаров выводить.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check, errText } from '../api';
import { AdminPage, Section } from '../ui';
import { Button, ErrorState, Input, Skeleton } from '@/components/ui';
import { IconArrowDown, IconArrowUp } from '@/components/icons';
import { useToast } from '@/components/toast';
import { slugify } from './ProductEditPage';

interface Cat { id: string; parent_id: string | null; name: string; slug: string; sort_order: number; is_active: boolean; show_on_home: boolean }
type Sections = { in_stock: boolean; new: boolean; popular: boolean; collections: boolean };

const SECTION_LABEL: Record<keyof Sections, string> = {
  in_stock: 'Сейчас в наличии — случайные товары из наличия',
  new: 'Новые поступления',
  popular: 'Популярное',
  collections: 'Подборка (первая из «Баннеры и подборки»)',
};
const DEFAULT_SECTIONS: Sections = { in_stock: true, new: true, popular: true, collections: true };

export default function HomeSettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const cats = useQuery({ queryKey: ['admin', 'categories-full'], queryFn: async () => check(await db().from('categories').select('*').order('sort_order')) as Cat[] });
  const setting = useQuery({
    queryKey: ['admin', 'home-sections'],
    queryFn: async () => {
      const r = check(await db().from('store_settings').select('value').eq('key', 'home_sections').maybeSingle()) as { value: Partial<Sections> } | null;
      return { ...DEFAULT_SECTIONS, ...(r?.value ?? {}) } as Sections;
    },
  });
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const top = (cats.data ?? []).filter((c) => !c.parent_id);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['admin', 'categories-full'] });
    await qc.invalidateQueries({ queryKey: ['categories'] });
  };

  const toggleCat = async (c: Cat, patch: Partial<Cat>) => {
    try {
      check(await db().from('categories').update(patch).eq('id', c.id));
      await refresh();
    } catch (e) { toast(errText(e), 'error'); }
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...top];
    const [item] = next.splice(idx, 1);
    if (!item || idx + dir < 0 || idx + dir > top.length - 1) return;
    next.splice(idx + dir, 0, item);
    try {
      for (const [i, c] of next.entries()) {
        const order = (i + 1) * 10;
        if (c.sort_order !== order) check(await db().from('categories').update({ sort_order: order }).eq('id', c.id));
      }
      await refresh();
    } catch (e) { toast(errText(e), 'error'); }
  };

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const maxOrder = Math.max(0, ...top.map((c) => c.sort_order));
      check(await db().from('categories').insert({ name, slug: slugify(name), parent_id: null, sort_order: maxOrder + 10, is_active: true, show_on_home: true }));
      setNewName('');
      toast('Категория добавлена на главную', 'success');
      await refresh();
    } catch (e) {
      toast(errText(e).includes('duplicate') ? 'Категория с таким названием уже есть' : errText(e), 'error');
    } finally { setBusy(false); }
  };

  const setSection = async (key: keyof Sections, value: boolean) => {
    const next = { ...(setting.data ?? DEFAULT_SECTIONS), [key]: value };
    try {
      const r = await db().from('store_settings').update({ value: next }).eq('key', 'home_sections').select('key');
      check(r);
      if (!r.data?.length) throw new Error('Нет прав на изменение настройки');
      await qc.invalidateQueries({ queryKey: ['admin', 'home-sections'] });
      await qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) { toast(errText(e), 'error'); }
  };

  return (
    <AdminPage title="Главная страница" back="/admin" actions={<Link to="/" className="inline-flex h-9 items-center border border-line px-3 text-sm">Открыть магазин</Link>}>
      <Section title="Категории на главной">
        {cats.isError ? <ErrorState onRetry={() => void cats.refetch()} /> : null}
        {cats.isLoading ? <Skeleton className="h-40" /> : null}
        <ul className="divide-y divide-line border-y border-line">
          {top.map((c, idx) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <label className="flex flex-1 items-center gap-3 text-sm">
                <input type="checkbox" className="h-5 w-5" checked={c.show_on_home && c.is_active}
                  onChange={(e) => void toggleCat(c, e.target.checked ? { show_on_home: true, is_active: true } : { show_on_home: false })} />
                <span className={c.show_on_home && c.is_active ? 'font-medium' : 'text-graphite'}>{c.name}</span>
                {!c.is_active ? <span className="text-xs text-fog">скрыта в магазине</span> : null}
              </label>
              <button aria-label="Выше" disabled={idx === 0} onClick={() => void move(idx, -1)} className="p-2 disabled:opacity-30"><IconArrowUp size={18} /></button>
              <button aria-label="Ниже" disabled={idx === top.length - 1} onClick={() => void move(idx, 1)} className="p-2 disabled:opacity-30"><IconArrowDown size={18} /></button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-graphite">Галочка — категория видна на главной. Снятая галочка убирает её только с главной: в каталоге она останется.</p>
        <div className="mt-4 flex gap-2">
          <Input placeholder="Новая категория, например «Аксессуары»" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
          <Button size="sm" loading={busy} onClick={() => void add()} disabled={!newName.trim()}>Добавить</Button>
        </div>
        <p className="mt-2 text-sm text-graphite">Подкатегории, переименование и удаление — в разделе <Link to="/admin/categories" className="underline underline-offset-2">Категории</Link>.</p>
      </Section>

      <Section title="Блоки товаров">
        {setting.isLoading ? <Skeleton className="h-24" /> : (
          <div className="space-y-3">
            {(Object.keys(SECTION_LABEL) as Array<keyof Sections>).map((k) => (
              <label key={k} className="flex items-center gap-3 text-sm">
                <input type="checkbox" className="h-5 w-5" checked={setting.data?.[k] ?? true} onChange={(e) => void setSection(k, e.target.checked)} />
                {SECTION_LABEL[k]}
              </label>
            ))}
          </div>
        )}
      </Section>

      <Section title="Баннер вверху">
        <p className="text-sm text-graphite">Картинки и тексты баннеров (сейчас там «Демо — Новый сезон») меняются в разделе <Link to="/admin/banners" className="underline underline-offset-2">Баннеры и подборки</Link>. Если выключить все баннеры, блок исчезнет.</p>
      </Section>
    </AdminPage>
  );
}
