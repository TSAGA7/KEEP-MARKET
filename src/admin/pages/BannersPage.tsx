import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db, imageUrl } from '@/lib/supabase';
import { check, errText, uploadProductImage } from '../api';
import { AdminPage, Section, Table, Td } from '../ui';
import { Button, DemoBadge, ErrorState, Field, Input, Select, Sheet, Skeleton, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { slugify } from './ProductEditPage';

interface Banner { id: string; title: string; subtitle: string | null; image_url: string | null; storage_path: string | null; link_type: string; link_value: string | null; sort_order: number; is_active: boolean; is_demo: boolean }
interface Collection { id: string; slug: string; title: string; description: string | null; sort_order: number; is_active: boolean; is_demo: boolean }

const LINK: Record<string, string> = { none: 'Без ссылки', catalog: 'Каталог', category: 'Категория (slug)', collection: 'Подборка (slug)', product: 'Товар (slug)', external: 'Внешняя ссылка https://' };

export default function BannersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const banners = useQuery({ queryKey: ['admin', 'banners'], queryFn: async () => check(await db().from('homepage_banners').select('*').order('sort_order')) as Banner[] });
  const cols = useQuery({ queryKey: ['admin', 'collections'], queryFn: async () => check(await db().from('collections').select('*').order('sort_order')) as Collection[] });
  const [b, setB] = useState<Partial<Banner> | null>(null);
  const [c, setC] = useState<Partial<Collection> | null>(null);
  const [colProducts, setColProducts] = useState<Collection | null>(null);
  const [uploading, setUploading] = useState(false);

  const inval = async () => {
    await qc.invalidateQueries({ queryKey: ['admin', 'banners'] });
    await qc.invalidateQueries({ queryKey: ['admin', 'collections'] });
    await qc.invalidateQueries({ queryKey: ['banners'] });
    await qc.invalidateQueries({ queryKey: ['collections'] });
  };

  const saveBanner = async () => {
    if (!b?.title) return;
    const row = { title: b.title, subtitle: b.subtitle || null, image_url: b.image_url || null, storage_path: b.storage_path || null, link_type: b.link_type ?? 'none',
      link_value: b.link_value || null, sort_order: Number(b.sort_order ?? 0), is_active: b.is_active ?? true };
    try {
      if (b.id) check(await db().from('homepage_banners').update(row).eq('id', b.id)); else check(await db().from('homepage_banners').insert(row));
      setB(null); await inval(); toast('Баннер сохранён', 'success');
    } catch (e) { toast(errText(e).includes('check') ? 'Проверьте ссылку: внешняя должна начинаться с https://' : errText(e), 'error'); }
  };
  const uploadBanner = async (f: File | undefined) => {
    if (!f || !b) return;
    setUploading(true);
    try { const path = await uploadProductImage('banners', f); setB({ ...b, storage_path: path, image_url: null }); }
    catch (e) { toast(errText(e), 'error'); } finally { setUploading(false); }
  };
  const saveCollection = async () => {
    if (!c?.title) return;
    const row = { title: c.title, slug: c.slug || slugify(c.title), description: c.description || null, sort_order: Number(c.sort_order ?? 0), is_active: c.is_active ?? true };
    try {
      if (c.id) check(await db().from('collections').update(row).eq('id', c.id)); else check(await db().from('collections').insert(row));
      setC(null); await inval(); toast('Подборка сохранена', 'success');
    } catch (e) { toast(errText(e), 'error'); }
  };
  const remove = async (table: 'homepage_banners' | 'collections', id: string) => {
    if (!window.confirm('Удалить?')) return;
    try { check(await db().from(table).delete().eq('id', id)); await inval(); } catch (e) { toast(errText(e), 'error'); }
  };

  return (
    <AdminPage title="Баннеры и подборки">
      <Section title="Баннеры главной" actions={<Button size="sm" onClick={() => setB({ link_type: 'catalog', is_active: true, sort_order: 0 })}>Добавить баннер</Button>}>
        {banners.isError ? <ErrorState onRetry={() => void banners.refetch()} /> : null}
        {banners.isLoading ? <Skeleton className="h-24" /> : null}
        {banners.data ? (
          <Table head={['', 'Заголовок', 'Ссылка', 'Порядок', 'Статус', '']}>
            {banners.data.map((x) => (
              <tr key={x.id}>
                <Td><div className="h-14 w-11 bg-concrete">{imageUrl(x.image_url ?? (x.storage_path ? `storage:${x.storage_path}` : null)) ? <img src={imageUrl(x.image_url ?? `storage:${x.storage_path}`)!} alt="" className="h-full w-full object-cover" /> : null}</div></Td>
                <Td>{x.title} {x.is_demo ? <DemoBadge /> : null}<div className="text-xs text-graphite">{x.subtitle}</div></Td>
                <Td>{LINK[x.link_type]}{x.link_value ? `: ${x.link_value}` : ''}</Td><Td>{x.sort_order}</Td><Td>{x.is_active ? 'показан' : 'скрыт'}</Td>
                <Td className="whitespace-nowrap"><Button size="sm" variant="ghost" onClick={() => setB(x)}>Изменить</Button><Button size="sm" variant="ghost" onClick={() => remove('homepage_banners', x.id)}>Удалить</Button></Td>
              </tr>
            ))}
          </Table>
        ) : null}
      </Section>

      <Section title="Подборки редакции" actions={<Button size="sm" onClick={() => setC({ is_active: true, sort_order: 0 })}>Добавить подборку</Button>}>
        {cols.data ? (
          <Table head={['Название', 'Slug', 'Порядок', 'Статус', '']}>
            {cols.data.map((x) => (
              <tr key={x.id}>
                <Td>{x.title} {x.is_demo ? <DemoBadge /> : null}</Td><Td className="num">{x.slug}</Td><Td>{x.sort_order}</Td><Td>{x.is_active ? 'показана' : 'скрыта'}</Td>
                <Td className="whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setColProducts(x)}>Товары</Button>
                  <Button size="sm" variant="ghost" onClick={() => setC(x)}>Изменить</Button>
                  <Button size="sm" variant="ghost" onClick={() => remove('collections', x.id)}>Удалить</Button>
                </Td>
              </tr>
            ))}
          </Table>
        ) : <Skeleton className="h-16" />}
      </Section>

      <Sheet open={!!b} onClose={() => setB(null)} title="Баннер" footer={<Button block onClick={saveBanner}>Сохранить</Button>}>
        {b ? (
          <div className="space-y-4">
            <Field label="Заголовок">{(id) => <Input id={id} value={b.title ?? ''} onChange={(e) => setB({ ...b, title: e.target.value })} />}</Field>
            <Field label="Подзаголовок" optional>{(id) => <Input id={id} value={b.subtitle ?? ''} onChange={(e) => setB({ ...b, subtitle: e.target.value })} />}</Field>
            <Field label="Изображение" hint="JPEG/PNG/WebP до 5 МБ, лучше вертикальное 4:5">
              {(id) => <input id={id} type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(e) => void uploadBanner(e.target.files?.[0])} className="text-sm" />}
            </Field>
            {b.storage_path || b.image_url ? <img src={imageUrl(b.image_url ?? `storage:${b.storage_path}`) ?? ''} alt="" className="h-40 object-cover" /> : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Куда ведёт">{(id) => <Select id={id} value={b.link_type ?? 'none'} onChange={(e) => setB({ ...b, link_type: e.target.value })}>{Object.entries(LINK).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
              <Field label="Значение ссылки" optional>{(id) => <Input id={id} value={b.link_value ?? ''} onChange={(e) => setB({ ...b, link_value: e.target.value })} />}</Field>
            </div>
            <Field label="Порядок">{(id) => <Input id={id} inputMode="numeric" value={String(b.sort_order ?? 0)} onChange={(e) => setB({ ...b, sort_order: Number(e.target.value) || 0 })} />}</Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={b.is_active ?? true} onChange={(e) => setB({ ...b, is_active: e.target.checked })} className="h-4 w-4" /> Показывать</label>
          </div>
        ) : null}
      </Sheet>

      <Sheet open={!!c} onClose={() => setC(null)} title="Подборка" footer={<Button block onClick={saveCollection}>Сохранить</Button>}>
        {c ? (
          <div className="space-y-4">
            <Field label="Название">{(id) => <Input id={id} value={c.title ?? ''} onChange={(e) => setC({ ...c, title: e.target.value })} />}</Field>
            <Field label="Slug" optional>{(id) => <Input id={id} value={c.slug ?? ''} onChange={(e) => setC({ ...c, slug: e.target.value })} />}</Field>
            <Field label="Описание" optional>{(id) => <Textarea id={id} value={c.description ?? ''} onChange={(e) => setC({ ...c, description: e.target.value })} />}</Field>
            <Field label="Порядок">{(id) => <Input id={id} inputMode="numeric" value={String(c.sort_order ?? 0)} onChange={(e) => setC({ ...c, sort_order: Number(e.target.value) || 0 })} />}</Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.is_active ?? true} onChange={(e) => setC({ ...c, is_active: e.target.checked })} className="h-4 w-4" /> Показывать</label>
          </div>
        ) : null}
      </Sheet>

      {colProducts ? <CollectionProducts col={colProducts} onClose={() => setColProducts(null)} /> : null}
    </AdminPage>
  );
}

function CollectionProducts({ col, onClose }: { col: Collection; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const items = useQuery({ queryKey: ['admin', 'col-products', col.id], queryFn: async () => check(await db().from('collection_products').select('product_id, sort_order').eq('collection_id', col.id)) as Array<{ product_id: string }> });
  const products = useQuery({ queryKey: ['admin', 'products-min'], queryFn: async () => check(await db().from('products').select('id, title, status').neq('status', 'archived').order('title')) as Array<{ id: string; title: string; status: string }> });
  const ids = new Set(items.data?.map((i) => i.product_id));
  const toggle = async (pid: string) => {
    try {
      if (ids.has(pid)) check(await db().from('collection_products').delete().eq('collection_id', col.id).eq('product_id', pid));
      else check(await db().from('collection_products').insert({ collection_id: col.id, product_id: pid, sort_order: ids.size }));
      await qc.invalidateQueries({ queryKey: ['admin', 'col-products', col.id] });
    } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <Sheet open onClose={onClose} title={`Товары подборки «${col.title}»`}>
      <p className="mb-3 text-sm text-graphite">На витрине показываются только опубликованные и проверенные товары.</p>
      <ul className="divide-y divide-line">
        {products.data?.map((p) => (
          <li key={p.id}><label className="flex items-center gap-3 py-2.5 text-sm"><input type="checkbox" checked={ids.has(p.id)} onChange={() => toggle(p.id)} className="h-4 w-4" />{p.title}<span className="text-xs text-fog">{p.status}</span></label></li>
        ))}
      </ul>
    </Sheet>
  );
}
