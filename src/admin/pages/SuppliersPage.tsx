import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { check, errText, type Supplier } from '../api';
import { AdminPage, Table, Td } from '../ui';
import { Badge, Button, Checkbox, ErrorState, Field, Input, Select, Sheet, Skeleton, Textarea, Price } from '@/components/ui';
import { useToast } from '@/components/toast';
import { formatDateTime } from '@/components/order';

export const SUPPLIER_CHECKLIST: Array<[string, string]> = [
  ['legal_entity_verified', 'Юрлицо/ИП поставщика проверено (ИНН, ЕГРЮЛ/ЕГРИП)'],
  ['contract_signed', 'Подписан договор поставки'],
  ['brand_rights_confirmed', 'Подтверждены права на бренды/обозначения либо их отсутствие на товаре'],
  ['certificates_available', 'Есть декларации/сертификаты соответствия, где они обязательны'],
  ['marking_checked', 'Проверена обязательная маркировка («Честный знак»), если применимо'],
  ['returns_terms_agreed', 'Согласованы условия возврата и брака'],
];

/** «@channel», «https://t.me/channel» или «-100123…» → поля поставщика */
export function parseTelegramChannel(v: string): { telegram_username: string | null; telegram_chat_id: number | null } {
  const t = v.trim();
  if (!t) return { telegram_username: null, telegram_chat_id: null };
  if (/^-?\d{5,20}$/.test(t)) return { telegram_username: null, telegram_chat_id: Number(t) };
  const u = t.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').split(/[/?]/)[0] ?? '';
  return { telegram_username: /^[A-Za-z0-9_]{4,64}$/.test(u) ? u : null, telegram_chat_id: null };
}

interface Offer { id: string; supplier_sku: string; title: string | null; purchase_price_kopecks: number | null; stock_qty: number; confirmed_at: string | null; variant_id: string | null; product_id: string | null; manager_comment: string | null }

export default function SuppliersPage() {
  const s = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'suppliers'], queryFn: async () => check(await db().from('suppliers').select('*').order('name')) as Supplier[] });
  const [edit, setEdit] = useState<Partial<Supplier> | null>(null);
  const [offersFor, setOffersFor] = useState<Supplier | null>(null);
  const [tgChannel, setTgChannel] = useState('');
  const openEdit = (sup: Partial<Supplier>) => {
    setEdit(sup);
    setTgChannel(sup.telegram_username ? `@${sup.telegram_username}` : sup.telegram_chat_id ? String(sup.telegram_chat_id) : '');
  };

  const save = async () => {
    if (!edit?.name || !edit.internal_code) { toast('Укажите название и код', 'error'); return; }
    const row = {
      name: edit.name.trim(), internal_code: edit.internal_code.trim().toUpperCase(), contacts: edit.contacts ?? {}, notes: edit.notes ?? null, terms: edit.terms ?? null,
      processing_days_min: edit.processing_days_min ?? null, processing_days_max: edit.processing_days_max ?? null, is_active: edit.is_active ?? true, checklist: edit.checklist ?? {},
      ...parseTelegramChannel(tgChannel),
    };
    try {
      if (edit.id) check(await db().from('suppliers').update(row).eq('id', edit.id));
      else check(await db().from('suppliers').insert(row));
      toast('Поставщик сохранён', 'success');
      setEdit(null);
      await qc.invalidateQueries({ queryKey: ['admin', 'suppliers'] });
    } catch (e) { toast(errText(e).includes('duplicate') ? 'Такой код уже есть' : errText(e).includes('check') ? 'Код: 2–32 символа A-Z, 0-9, _ и -' : errText(e), 'error'); }
  };

  return (
    <AdminPage title="Поставщики" actions={s.isAdmin ? <Button size="sm" onClick={() => openEdit({ is_active: true, contacts: {}, checklist: {} })}>Добавить поставщика</Button> : null}>
      <p className="mb-4 max-w-2xl text-sm text-graphite">Поставщик не получает доступа к базе: менеджер передаёт ему только подтверждённый заказ с минимально необходимыми данными.</p>
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-40" /> : null}
      {q.data ? (
        <Table head={['Код', 'Название', 'Сроки обработки', 'Проверка', 'Статус', '']}>
          {q.data.map((sup) => {
            const done = SUPPLIER_CHECKLIST.filter(([k]) => sup.checklist?.[k]).length;
            return (
              <tr key={sup.id}>
                <Td className="num">{sup.internal_code}</Td><Td>{sup.name}</Td>
                <Td>{sup.processing_days_min ?? '—'}–{sup.processing_days_max ?? '—'} дн.</Td>
                <Td><Badge tone={done === SUPPLIER_CHECKLIST.length ? 'good' : 'warn'}>{done}/{SUPPLIER_CHECKLIST.length}</Badge></Td>
                <Td>{sup.is_active ? 'активен' : 'неактивен'}</Td>
                <Td className="whitespace-nowrap">
                  {s.isAdmin ? <Button size="sm" variant="ghost" onClick={() => openEdit(sup)}>Изменить</Button> : null}
                  {s.isAdmin ? <Button size="sm" variant="ghost" onClick={() => setOffersFor(sup)}>Предложения</Button> : null}
                </Td>
              </tr>
            );
          })}
        </Table>
      ) : null}

      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Поставщик' : 'Новый поставщик'} footer={<Button block onClick={save}>Сохранить</Button>}>
        {edit ? (
          <div className="space-y-4">
            <Field label="Название">{(id) => <Input id={id} value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            <Field label="Внутренний код" hint="Например SUP-01">{(id) => <Input id={id} value={edit.internal_code ?? ''} onChange={(e) => setEdit({ ...edit, internal_code: e.target.value })} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Контактное лицо" optional>{(id) => <Input id={id} value={edit.contacts?.contact ?? ''} onChange={(e) => setEdit({ ...edit, contacts: { ...edit.contacts, contact: e.target.value } })} />}</Field>
              <Field label="Телефон / Telegram" optional>{(id) => <Input id={id} value={edit.contacts?.phone ?? ''} onChange={(e) => setEdit({ ...edit, contacts: { ...edit.contacts, phone: e.target.value } })} />}</Field>
            </div>
            <Field label="Telegram-канал поставщика" optional hint="@username или ID канала. По нему бот узнаёт поставщика, когда вы пересылаете пост">
              {(id) => <Input id={id} placeholder="@supplier_channel" value={tgChannel} onChange={(e) => setTgChannel(e.target.value)} />}
            </Field>
            <Field label="E-mail" optional>{(id) => <Input id={id} value={edit.contacts?.email ?? ''} onChange={(e) => setEdit({ ...edit, contacts: { ...edit.contacts, email: e.target.value } })} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Обработка от, дней" optional>{(id) => <Input id={id} inputMode="numeric" value={edit.processing_days_min?.toString() ?? ''} onChange={(e) => setEdit({ ...edit, processing_days_min: e.target.value ? Number(e.target.value) : null })} />}</Field>
              <Field label="до, дней" optional>{(id) => <Input id={id} inputMode="numeric" value={edit.processing_days_max?.toString() ?? ''} onChange={(e) => setEdit({ ...edit, processing_days_max: e.target.value ? Number(e.target.value) : null })} />}</Field>
            </div>
            <Field label="Условия работы" optional>{(id) => <Textarea id={id} value={edit.terms ?? ''} onChange={(e) => setEdit({ ...edit, terms: e.target.value })} />}</Field>
            <Field label="Примечания" optional>{(id) => <Textarea id={id} value={edit.notes ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />}</Field>
            <fieldset className="space-y-2">
              <legend className="mb-2 font-medium">Чек-лист проверки поставщика</legend>
              {SUPPLIER_CHECKLIST.map(([k, label]) => (
                <Checkbox key={k} checked={!!edit.checklist?.[k]} onChange={(v) => setEdit({ ...edit, checklist: { ...edit.checklist, [k]: v } })}>{label}</Checkbox>
              ))}
            </fieldset>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.is_active ?? true} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} className="h-4 w-4" /> Активен</label>
          </div>
        ) : null}
      </Sheet>

      {offersFor ? <OffersSheet supplier={offersFor} onClose={() => setOffersFor(null)} /> : null}
    </AdminPage>
  );
}

function OffersSheet({ supplier, onClose }: { supplier: Supplier; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const offers = useQuery({ queryKey: ['admin', 'offers', supplier.id], queryFn: async () => check(await db().from('supplier_offers').select('*').eq('supplier_id', supplier.id).order('supplier_sku')) as Offer[] });
  const variants = useQuery({ queryKey: ['admin', 'variants-min'], queryFn: async () => check(await db().from('product_variants').select('id, sku, size, color, product_id, products(title)').order('sku').limit(1000)) as unknown as Array<{ id: string; sku: string; size: string | null; color: string | null; product_id: string; products: { title: string } | null }> });
  const link = async (o: Offer, variantId: string) => {
    const v = variants.data?.find((x) => x.id === variantId);
    try {
      check(await db().from('supplier_offers').update({ variant_id: v?.id ?? null, product_id: v?.product_id ?? null }).eq('id', o.id));
      await qc.invalidateQueries({ queryKey: ['admin', 'offers', supplier.id] });
      toast('Привязка сохранена', 'success');
    } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <Sheet open onClose={onClose} title={`Предложения: ${supplier.name}`}>
      {offers.isLoading ? <Skeleton className="h-24" /> : null}
      {offers.data?.length === 0 ? <p className="text-sm text-graphite">Предложений нет — загрузите прайс в разделе «Прайсы».</p> : null}
      <div className="space-y-4">
        {offers.data?.map((o) => (
          <div key={o.id} className="space-y-1 border-b border-line pb-3 text-sm">
            <p><span className="num font-medium">{o.supplier_sku}</span> {o.title}</p>
            <p className="text-graphite">Закупка: <Price kopecks={o.purchase_price_kopecks} />, остаток {o.stock_qty}, подтверждено {o.confirmed_at ? formatDateTime(o.confirmed_at) : '—'}</p>
            <Select value={o.variant_id ?? ''} onChange={(e) => void link(o, e.target.value)} aria-label="Вариант товара">
              <option value="">Не привязано к варианту</option>
              {variants.data?.map((v) => <option key={v.id} value={v.id}>{v.products?.title} — {[v.color, v.size].filter(Boolean).join(', ')} ({v.sku})</option>)}
            </Select>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

