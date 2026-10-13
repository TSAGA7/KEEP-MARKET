import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { db, imageUrl } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { BLOCKER_LABEL, PRODUCT_STATUS_LABEL, REVIEW_STATUS_LABEL, check, errText, getAdminProduct, rpc, uploadProductImage, type AdminProduct, type AdminVariant } from '../api';
import { AdminPage, KV, Section, Table, Td } from '../ui';
import { Badge, Button, ErrorState, Field, Input, Notice, Price, Select, Sheet, Skeleton, Textarea } from '@/components/ui';
import { IconArrowDown, IconArrowUp, IconTrash, IconEye } from '@/components/icons';
import { useToast } from '@/components/toast';
import { formatDateTime } from '@/components/order';
import { parseRublesToKopecks, kopecksToRublesInput } from '@shared/money';
import { humanizeError } from '@shared/orders';

interface ProductForm {
  title: string; slug: string; description: string; category_id: string; brand_name: string; sku: string; price: string; cost: string;
  materials: string; care: string; origin_description: string; weight_grams: string; length_mm: string; width_mm: string; height_mm: string;
  supplier_id: string; supplier_documents_reference: string; internal_notes: string; is_featured: boolean;
}

const translit: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
export function slugify(s: string): string {
  return s.toLowerCase().split('').map((c) => translit[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

const intOrNull = (v: string) => (v.trim() === '' ? null : Math.max(1, Math.round(Number(v))) || null);

export default function ProductEditPage() {
  const { id = '' } = useParams();
  const isNew = id === 'new';
  const s = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'product', id], queryFn: () => getAdminProduct(id), enabled: !isNew });
  const cats = useQuery({ queryKey: ['admin', 'categories'], queryFn: async () => check(await db().from('categories').select('id, name, parent_id').order('sort_order')) as Array<{ id: string; name: string; parent_id: string | null }> });
  const sups = useQuery({ queryKey: ['admin', 'suppliers-min'], queryFn: async () => check(await db().from('suppliers').select('id, name').order('name')) as Array<{ id: string; name: string }> });
  const blockers = useQuery({ queryKey: ['admin', 'blockers', id], queryFn: () => rpc<string[]>('product_publish_blockers', { p_product_id: id }), enabled: !isNew });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const canEdit = s.isAdmin;

  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<ProductForm>({
    defaultValues: { title: '', slug: '', description: '', category_id: '', brand_name: '', sku: '', price: '', cost: '', materials: '', care: '',
      origin_description: '', weight_grams: '', length_mm: '', width_mm: '', height_mm: '', supplier_id: '', supplier_documents_reference: '', internal_notes: '', is_featured: false },
  });

  useEffect(() => {
    const p = q.data?.product;
    if (!p) return;
    reset({
      title: p.title, slug: p.slug, description: p.description ?? '', category_id: p.category_id ?? '', brand_name: p.brand_name ?? '', sku: p.sku,
      price: kopecksToRublesInput(p.price_kopecks), cost: kopecksToRublesInput(q.data?.cost ?? null), materials: p.materials ?? '', care: p.care ?? '',
      origin_description: p.origin_description ?? '', weight_grams: p.weight_grams?.toString() ?? '', length_mm: p.length_mm?.toString() ?? '',
      width_mm: p.width_mm?.toString() ?? '', height_mm: p.height_mm?.toString() ?? '', supplier_id: p.supplier_id ?? '',
      supplier_documents_reference: p.supplier_documents_reference ?? '', internal_notes: p.internal_notes ?? '', is_featured: p.is_featured,
    });
  }, [q.data, reset]);

  const title = watch('title');
  useEffect(() => {
    if (isNew && title) setValue('slug', slugify(title));
  }, [isNew, title, setValue]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['admin', 'product', id] });
    await qc.invalidateQueries({ queryKey: ['admin', 'blockers', id] });
    await qc.invalidateQueries({ queryKey: ['admin', 'products'] });
  };

  const save = handleSubmit(async (f) => {
    const price = parseRublesToKopecks(f.price);
    if (price === null) { toast('Укажите розничную цену', 'error'); return; }
    const cost = f.cost.trim() ? parseRublesToKopecks(f.cost) : null;
    if (f.cost.trim() && cost === null) { toast('Некорректная закупочная цена', 'error'); return; }
    const row = {
      title: f.title.trim(), slug: f.slug.trim(), description: f.description.trim() || null, category_id: f.category_id || null,
      brand_name: f.brand_name.trim() || null, sku: f.sku.trim(), price_kopecks: price, materials: f.materials.trim() || null, care: f.care.trim() || null,
      origin_description: f.origin_description.trim() || null, weight_grams: intOrNull(f.weight_grams), length_mm: intOrNull(f.length_mm),
      width_mm: intOrNull(f.width_mm), height_mm: intOrNull(f.height_mm), supplier_id: f.supplier_id || null,
      supplier_documents_reference: f.supplier_documents_reference.trim() || null, internal_notes: f.internal_notes.trim() || null, is_featured: f.is_featured,
    };
    setSaving(true);
    try {
      let pid = id;
      if (isNew) {
        const r = check(await db().from('products').insert({ ...row, status: 'draft', created_by: s.profile?.id }).select('id').single()) as { id: string };
        pid = r.id;
      } else {
        check(await db().from('products').update(row).eq('id', id));
      }
      if (cost !== null && s.isAdmin) {
        check(await db().from('product_costs').upsert({ product_id: pid, purchase_price_kopecks: cost, updated_by: s.profile?.id }));
      }
      toast(isNew ? 'Черновик создан' : 'Сохранено', 'success');
      if (isNew) navigate(`/admin/products/${pid}`, { replace: true });
      else await refresh();
    } catch (e) {
      const m = errText(e);
      toast(m.includes('duplicate key') ? 'Slug или артикул уже заняты' : humanizeError(m), 'error');
    } finally {
      setSaving(false);
    }
  });

  const setStatus = async (status: AdminProduct['status']) => {
    try {
      check(await db().from('products').update({ status }).eq('id', id));
      toast(status === 'published' ? 'Опубликовано' : `Статус: ${PRODUCT_STATUS_LABEL[status]}`, 'success');
      await refresh();
    } catch (e) {
      const m = errText(e);
      const codes = m.match(/PUBLISH_BLOCKED: ([A-Z_,]+)/)?.[1]?.split(',') ?? [];
      toast(codes.length ? `Публикация невозможна: ${codes.map((c) => BLOCKER_LABEL[c] ?? c).join('; ')}` : humanizeError(m), 'error');
    }
  };

  if (!isNew && q.isLoading) return <AdminPage title="Товар" back="/admin/products"><Skeleton className="h-96" /></AdminPage>;
  if (!isNew && (q.isError || !q.data?.product)) return <AdminPage title="Товар" back="/admin/products"><ErrorState text="Товар не найден или нет доступа." /></AdminPage>;
  const p = q.data?.product;
  const approved = p?.compliance_status === 'approved' && p?.trademark_review_status === 'approved';

  return (
    <AdminPage title={isNew ? 'Новый товар' : p!.title} back="/admin/products" actions={!isNew && p ? (
      <>
        <Badge tone={p.status === 'published' ? 'good' : 'warn'}>{PRODUCT_STATUS_LABEL[p.status]}</Badge>
        <Button size="sm" variant="secondary" onClick={() => setPreview(true)}><IconEye size={18} />Предпросмотр</Button>
      </>
    ) : null}>
      {!canEdit ? <Notice className="mb-4">Редактирование товаров доступно владельцу и администраторам. Остатки подтверждайте в разделе «Размеры и остатки».</Notice> : null}
      {p?.is_demo ? <Notice tone="warn" className="mb-4">Демонстрационный товар. Удалите демо-данные перед запуском магазина.</Notice> : null}

      {!isNew && p ? (
        <Section title="Публикация">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={approved ? 'good' : 'warn'}>Юр. проверка: {REVIEW_STATUS_LABEL[p.compliance_status]}</Badge>
            <Badge tone={p.trademark_review_status === 'approved' ? 'good' : 'warn'}>Товарные знаки: {REVIEW_STATUS_LABEL[p.trademark_review_status]}</Badge>
            {p.reviewed_at ? <span className="text-sm text-graphite">проверено {formatDateTime(p.reviewed_at)}</span> : null}
          </div>
          {blockers.data && blockers.data.length > 0 ? (
            <Notice tone="warn" className="mt-3">
              <p className="font-medium">Опубликовать пока нельзя:</p>
              <ul className="mt-1 list-disc pl-5">{blockers.data.map((b) => <li key={b}>{BLOCKER_LABEL[b] ?? b}</li>)}</ul>
            </Notice>
          ) : null}
          {canEdit ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {p.status !== 'published' ? <Button size="sm" disabled={!!blockers.data?.length} onClick={() => setStatus('published')}>Опубликовать</Button> : null}
              {p.status === 'draft' ? <Button size="sm" variant="secondary" onClick={() => setStatus('pending_review')}>Отправить на проверку</Button> : null}
              {p.status === 'published' ? <Button size="sm" variant="secondary" onClick={() => setStatus('hidden')}>Скрыть с витрины</Button> : null}
              {p.status !== 'archived' ? <Button size="sm" variant="ghost" onClick={() => setStatus('archived')}>В архив</Button> : <Button size="sm" variant="secondary" onClick={() => setStatus('draft')}>Вернуть в черновики</Button>}
            </div>
          ) : null}
        </Section>
      ) : null}

      <form onSubmit={save}>
        <Section title="Основное">
          <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-2">
            <Field label="Название" error={errors.title?.message}>{(fid) => <Input id={fid} {...register('title', { required: 'Укажите название', maxLength: 200 })} />}</Field>
            <Field label="Slug (адрес страницы)" hint="Латиница, цифры и дефисы" error={errors.slug?.message}>
              {(fid) => <Input id={fid} {...register('slug', { required: 'Укажите slug', pattern: { value: /^[a-z0-9]+(-[a-z0-9]+)*$/, message: 'Только a-z, 0-9 и дефисы' } })} />}
            </Field>
            <Field label="Артикул" error={errors.sku?.message}>{(fid) => <Input id={fid} {...register('sku', { required: 'Укажите артикул', maxLength: 64 })} />}</Field>
            <Field label="Бренд" optional hint="Только собственный или независимый бренд поставщика. Не используйте чужие товарные знаки">
              {(fid) => <Input id={fid} {...register('brand_name')} />}
            </Field>
            <Field label="Категория">
              {(fid) => (
                <Select id={fid} {...register('category_id')}>
                  <option value="">Не выбрана</option>
                  {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.parent_id ? '— ' : ''}{c.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Поставщик" optional>
              {(fid) => (
                <Select id={fid} {...register('supplier_id')}>
                  <option value="">Не выбран</option>
                  {sups.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Розничная цена, ₽" error={errors.price?.message}>{(fid) => <Input id={fid} inputMode="decimal" {...register('price', { required: 'Укажите цену' })} />}</Field>
            {s.isAdmin ? (
              <Field label="Закупочная цена, ₽" optional hint="Видна только владельцу и администраторам">{(fid) => <Input id={fid} inputMode="decimal" {...register('cost')} />}</Field>
            ) : null}
            <div className="md:col-span-2">
              <Field label="Описание" hint="Не указывайте характеристики, которых нет в документах поставщика">{(fid) => <Textarea id={fid} rows={5} {...register('description', { maxLength: 8000 })} />}</Field>
            </div>
            <Field label="Состав и материалы" optional>{(fid) => <Textarea id={fid} rows={2} {...register('materials')} />}</Field>
            <Field label="Уход" optional>{(fid) => <Textarea id={fid} rows={2} {...register('care')} />}</Field>
            <div className="md:col-span-2">
              <Field label="Происхождение товара (для покупателя)" optional hint="Только подтверждённые сведения">{(fid) => <Textarea id={fid} rows={2} {...register('origin_description')} />}</Field>
            </div>
            <div className="grid grid-cols-4 gap-2 md:col-span-2">
              <Field label="Вес, г" optional>{(fid) => <Input id={fid} inputMode="numeric" {...register('weight_grams')} />}</Field>
              <Field label="Длина, мм" optional>{(fid) => <Input id={fid} inputMode="numeric" {...register('length_mm')} />}</Field>
              <Field label="Ширина, мм" optional>{(fid) => <Input id={fid} inputMode="numeric" {...register('width_mm')} />}</Field>
              <Field label="Высота, мм" optional>{(fid) => <Input id={fid} inputMode="numeric" {...register('height_mm')} />}</Field>
            </div>
            <Field label="Ссылка на документы поставщика" optional hint="Номер договора/декларации; файлы — в разделе «Проверка ассортимента»">{(fid) => <Input id={fid} {...register('supplier_documents_reference')} />}</Field>
            <Field label="Внутренние заметки" optional hint="Не показываются покупателям">{(fid) => <Textarea id={fid} rows={2} {...register('internal_notes')} />}</Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...register('is_featured')} className="h-4 w-4" /> Показывать в подборке «Выбор редакции»</label>
          </fieldset>
          {canEdit ? <Button type="submit" className="mt-5" loading={saving}>{isNew ? 'Сохранить черновик' : 'Сохранить изменения'}</Button> : null}
        </Section>
      </form>

      {!isNew && p ? (
        <>
          <ImagesSection productId={p.id} images={q.data!.images} canEdit={canEdit} onChange={refresh} />
          <VariantsSection productId={p.id} sku={p.sku} variants={q.data!.variants} canEdit={canEdit} onChange={refresh} />
          {q.data!.offers.length ? (
            <Section title="Предложения поставщиков">
              <Table head={['Поставщик', 'Артикул поставщика', 'Остаток', 'Подтверждено']}>
                {q.data!.offers.map((o) => (
                  <tr key={o.offer_id}><Td>{o.supplier_name}</Td><Td className="num">{o.supplier_sku}</Td><Td className="num">{o.stock_qty}</Td><Td>{o.confirmed_at ? formatDateTime(o.confirmed_at) : '—'}</Td></tr>
                ))}
              </Table>
            </Section>
          ) : null}
          <PreviewSheet open={preview} onClose={() => setPreview(false)} product={p} variants={q.data!.variants} image={q.data!.images[0] ?? null} />
        </>
      ) : null}
    </AdminPage>
  );
}

function ImagesSection({ productId, images, canEdit, onChange }: { productId: string; images: Array<{ id: string; storage_path: string | null; url: string | null; alt: string | null; sort_order: number }>; canEdit: boolean; onChange: () => Promise<void> }) {
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      let order = images.length ? Math.max(...images.map((i) => i.sort_order)) + 1 : 0;
      for (const f of Array.from(files).slice(0, 10)) {
        const path = await uploadProductImage(productId, f);
        check(await db().from('product_images').insert({ product_id: productId, storage_path: path, sort_order: order++ }));
      }
      toast('Фото загружены', 'success');
      await onChange();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setUploading(false);
    }
  };
  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...images];
    const [item] = next.splice(idx, 1);
    if (!item || idx + dir < 0 || idx + dir > images.length - 1) return;
    next.splice(idx + dir, 0, item);
    try {
      // Перенумеровываем все фото по новому порядку
      for (const [i, img] of next.entries()) {
        if (img.sort_order !== i) check(await db().from('product_images').update({ sort_order: i }).eq('id', img.id));
      }
      await onChange();
    } catch (e) { toast(errText(e), 'error'); }
  };
  const remove = async (img: { id: string; storage_path: string | null }) => {
    if (!window.confirm('Удалить фото?')) return;
    try {
      check(await db().from('product_images').delete().eq('id', img.id));
      if (img.storage_path) await db().storage.from('product-images').remove([img.storage_path]);
      await onChange();
    } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <Section title="Фотографии" actions={canEdit ? (
      <label className="inline-flex h-9 cursor-pointer items-center bg-ink px-3 text-sm text-paper">
        {uploading ? 'Загрузка…' : 'Загрузить фото'}
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" disabled={uploading} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
      </label>
    ) : null}>
      {images.length === 0 ? <p className="text-sm text-graphite">Фото нет. JPEG, PNG или WebP до 5 МБ; первое фото — обложка.</p> : null}
      <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
        {images.map((img, idx) => (
          <div key={img.id} className="space-y-1">
            <div className="aspect-[4/5] bg-concrete">
              {imageUrl(img.url ?? (img.storage_path ? `storage:${img.storage_path}` : null)) ? (
                <img src={imageUrl(img.url ?? `storage:${img.storage_path}`)!} alt={img.alt ?? ''} className="h-full w-full object-cover" />
              ) : null}
            </div>
            {canEdit ? (
              <div className="flex justify-between text-graphite">
                <button aria-label="Раньше" disabled={idx === 0} onClick={() => move(idx, -1)} className="p-1 disabled:opacity-30"><IconArrowUp size={18} /></button>
                <button aria-label="Позже" disabled={idx === images.length - 1} onClick={() => move(idx, 1)} className="p-1 disabled:opacity-30"><IconArrowDown size={18} /></button>
                <button aria-label="Удалить" onClick={() => remove(img)} className="p-1 text-rust"><IconTrash size={18} /></button>
              </div>
            ) : null}
            {idx === 0 ? <p className="text-xs text-graphite">Обложка</p> : null}
          </div>
        ))}
      </div>
    </Section>
  );
}

function VariantsSection({ productId, sku, variants, canEdit, onChange }: { productId: string; sku: string; variants: AdminVariant[]; canEdit: boolean; onChange: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [sizes, setSizes] = useState('');
  const [colors, setColors] = useState('');
  const [stock, setStock] = useState('0');
  const add = async () => {
    const sz = sizes.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    const cl = colors.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    const combos: Array<{ size: string | null; color: string | null }> = [];
    for (const c of cl.length ? cl : [null]) for (const s of sz.length ? sz : [null]) combos.push({ size: s, color: c });
    try {
      const rows = combos.map((c, i) => ({
        product_id: productId, size: c.size, color: c.color, stock_qty: Math.max(0, Number(stock) || 0), stock_confirmed_at: new Date().toISOString(),
        sku: `${sku}-${slugifySku(c.color)}-${slugifySku(c.size)}`.replace(/-+$/, '').replace(/--+/g, '-').slice(0, 64), sort_order: variants.length + i,
      }));
      check(await db().from('product_variants').insert(rows));
      toast(`Добавлено вариантов: ${rows.length}`, 'success');
      setOpen(false);
      await onChange();
    } catch (e) {
      toast(errText(e).includes('duplicate') ? 'Такой вариант или артикул уже есть' : errText(e), 'error');
    }
  };
  const update = async (v: AdminVariant, patch: Partial<AdminVariant>) => {
    try {
      check(await db().from('product_variants').update(patch).eq('id', v.id));
      await onChange();
    } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <Section title="Размеры и варианты" actions={canEdit ? <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Добавить варианты</Button> : null}>
      {variants.length === 0 ? <p className="text-sm text-graphite">Нет вариантов. Без них товар нельзя опубликовать и заказать.</p> : (
        <Table head={['Артикул', 'Цвет', 'Размер', 'Цена', 'Остаток', 'Подтверждён', 'Активен']}>
          {variants.map((v) => (
            <tr key={v.id}>
              <Td className="num">{v.sku}</Td><Td>{v.color ?? '—'}</Td><Td>{v.size ?? '—'}</Td>
              <Td>{canEdit ? (
                <Input className="h-9 w-28" inputMode="decimal" placeholder="как у товара" defaultValue={kopecksToRublesInput(v.price_override_kopecks)}
                  onBlur={(e) => { const val = e.target.value.trim(); const k = val ? parseRublesToKopecks(val) : null; if (val && k === null) return; if (k !== v.price_override_kopecks) void update(v, { price_override_kopecks: k }); }} />
              ) : v.price_override_kopecks ? <Price kopecks={v.price_override_kopecks} /> : 'как у товара'}</Td>
              <Td className="num">{v.stock_qty}</Td>
              <Td className="whitespace-nowrap text-graphite">{v.stock_confirmed_at ? formatDateTime(v.stock_confirmed_at) : 'никогда'}</Td>
              <Td><input type="checkbox" checked={v.is_active} disabled={!canEdit} onChange={(e) => update(v, { is_active: e.target.checked })} aria-label="Активен" className="h-4 w-4" /></Td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-2 text-sm text-graphite">Остаток подтверждается в разделе «Размеры и остатки» или импортом прайса.</p>
      <Sheet open={open} onClose={() => setOpen(false)} title="Новые варианты" footer={<Button block onClick={add}>Добавить</Button>}>
        <div className="space-y-4">
          <Field label="Размеры через запятую" optional hint="Например: S, M, L или 40, 41, 42">{(fid) => <Input id={fid} value={sizes} onChange={(e) => setSizes(e.target.value)} />}</Field>
          <Field label="Цвета через запятую" optional>{(fid) => <Input id={fid} value={colors} onChange={(e) => setColors(e.target.value)} />}</Field>
          <Field label="Начальный остаток для каждого">{(fid) => <Input id={fid} inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value)} />}</Field>
          <p className="text-sm text-graphite">Будут созданы все сочетания цвета и размера.</p>
        </div>
      </Sheet>
    </Section>
  );
}

function slugifySku(s: string | null): string {
  if (!s) return '';
  return slugify(s).toUpperCase().slice(0, 12);
}

function PreviewSheet({ open, onClose, product, variants, image }: { open: boolean; onClose: () => void; product: AdminProduct; variants: AdminVariant[]; image: { url: string | null; storage_path: string | null } | null }) {
  const src = image ? imageUrl(image.url ?? `storage:${image.storage_path}`) : null;
  const sizes = [...new Set(variants.filter((v) => v.is_active && v.size).map((v) => v.size))];
  return (
    <Sheet open={open} onClose={onClose} title="Так увидит покупатель">
      <div className="bg-concrete">{src ? <img src={src} alt="" className="aspect-[4/5] w-full object-cover" /> : <div className="aspect-[4/5]" />}</div>
      {product.brand_name ? <p className="mt-3 text-sm text-graphite">{product.brand_name}</p> : null}
      <p className="mt-1 font-display text-lg">{product.title}</p>
      <span className="hang-tag mt-3 text-md font-semibold"><Price kopecks={product.price_kopecks} /></span>
      {sizes.length ? <p className="mt-3 text-sm">Размеры: {sizes.join(', ')}</p> : null}
      <p className="mt-3 whitespace-pre-line text-sm text-graphite">{product.description}</p>
      <dl className="mt-3"><KV k="Артикул">{product.sku}</KV>{product.materials ? <KV k="Состав">{product.materials}</KV> : null}</dl>
      <p className="mt-4 text-xs text-fog">Закупочная цена, поставщик и внутренние заметки покупателю не передаются.</p>
    </Sheet>
  );
}
