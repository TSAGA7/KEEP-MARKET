import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { check, errText, rpc, signedDocumentUrl, uploadPrivateDocument, REVIEW_STATUS_LABEL, PRODUCT_STATUS_LABEL, type AdminProduct } from '../api';
import { AdminPage, KV, Section, Table, Td } from '../ui';
import { Badge, Button, Checkbox, ErrorState, Field, Input, Notice, Select, Sheet, Skeleton, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { formatDateTime } from '@/components/order';
import { humanizeError } from '@shared/orders';
import { openExternalLink } from '@/lib/telegram';

// Чек-лист проверки товара. Отсутствие логотипа — не единственный критерий.
const PRODUCT_CHECKLIST: Array<[string, string]> = [
  ['no_foreign_trademarks', 'На товаре, бирках и в названии нет чужих товарных знаков и сходных до степени смешения обозначений'],
  ['packaging_checked', 'Проверены упаковка, ярлыки, фурнитура и вшивные бирки'],
  ['photos_checked', 'Фотографии собственные или с правом использования, без чужих брендов'],
  ['design_rights_checked', 'Дизайн не копирует охраняемые промышленные образцы и узнаваемые элементы чужих брендов'],
  ['description_checked', 'Описание, SEO и фильтры не создают впечатления связи с другими брендами'],
  ['supplier_documents_checked', 'Есть документы поставщика: происхождение, декларация/сертификат, если обязательны, маркировка'],
];

interface Doc { id: string; title: string; doc_type: string; storage_path: string; created_at: string }

export default function CompliancePage() {
  const s = useSession();
  const q = useQuery({ queryKey: ['admin', 'compliance-queue'], queryFn: async () => check(await db().from('products').select('*')
    .or('compliance_status.neq.approved,trademark_review_status.neq.approved').neq('status', 'archived').order('updated_at', { ascending: false })) as AdminProduct[] });
  const canReviewSetting = useQuery({ queryKey: ['admin', 'setting', 'admins_can_review_compliance'], queryFn: async () => (check(await db().from('store_settings').select('value').eq('key', 'admins_can_review_compliance').maybeSingle()) as { value: boolean } | null)?.value === true });
  const [review, setReview] = useState<AdminProduct | null>(null);
  const [lookup, setLookup] = useState('');
  const found = useQuery({ queryKey: ['admin', 'compliance-lookup', lookup], enabled: lookup.length > 1, queryFn: async () => check(await db().from('products').select('*').or(`title.ilike.%${lookup.replace(/[%,()]/g, '')}%,sku.ilike.%${lookup.replace(/[%,()]/g, '')}%`).limit(10)) as AdminProduct[] });
  const canReview = s.isOwner || (s.isAdmin && canReviewSetting.data === true);

  return (
    <AdminPage title="Проверка ассортимента">
      <Notice className="mb-6 max-w-3xl">
        Магазин продаёт независимые бренды и легальные аналоги. Товар без одобрения юридической проверки не публикуется и не оформляется в заказ.
        Проверка учитывает обозначения, упаковку, фото, дизайн, описание и права на промышленные образцы. Документы хранятся в закрытом хранилище, доступ — только владельцу и администраторам.
        {!canReview ? ' Одобрять товары может владелец (или администратор, если владелец разрешил это в настройках).' : ''}
      </Notice>

      <Section title="Ожидают проверки">
        {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
        {q.isLoading ? <Skeleton className="h-24" /> : null}
        {q.data?.length === 0 ? <p className="text-sm text-graphite">Все товары проверены.</p> : null}
        {q.data?.length ? (
          <Table head={['Товар', 'Статус товара', 'Товарные знаки', 'Соответствие', '']}>
            {q.data.map((p) => (
              <tr key={p.id}>
                <Td><Link to={`/admin/products/${p.id}`} className="underline-offset-4 hover:underline">{p.title}</Link><div className="num text-xs text-fog">{p.sku}</div></Td>
                <Td>{PRODUCT_STATUS_LABEL[p.status]}</Td>
                <Td><Badge tone={p.trademark_review_status === 'approved' ? 'good' : 'warn'}>{REVIEW_STATUS_LABEL[p.trademark_review_status]}</Badge></Td>
                <Td><Badge tone={p.compliance_status === 'approved' ? 'good' : p.compliance_status === 'rejected' ? 'bad' : 'warn'}>{REVIEW_STATUS_LABEL[p.compliance_status]}</Badge></Td>
                <Td><Button size="sm" variant="secondary" onClick={() => setReview(p)}>{canReview ? 'Проверить' : 'Документы'}</Button></Td>
              </tr>
            ))}
          </Table>
        ) : null}
      </Section>

      <Section title="Повторная проверка опубликованного товара">
        <Input className="max-w-sm" placeholder="Название или артикул" value={lookup} onChange={(e) => setLookup(e.target.value)} />
        <ul className="mt-3 divide-y divide-line">
          {found.data?.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>{p.title} <span className="text-fog">{p.sku}</span></span>
              <Button size="sm" variant="ghost" onClick={() => setReview(p)}>Открыть</Button>
            </li>
          ))}
        </ul>
      </Section>

      {review ? <ReviewSheet product={review} canReview={canReview} onClose={() => setReview(null)} /> : null}
    </AdminPage>
  );
}

function ReviewSheet({ product, canReview, onClose }: { product: AdminProduct; canReview: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [tm, setTm] = useState(product.trademark_review_status === 'pending_review' ? 'approved' : product.trademark_review_status);
  const [cs, setCs] = useState(product.compliance_status === 'pending_review' ? 'approved' : product.compliance_status);
  const [notes, setNotes] = useState(product.compliance_notes ?? '');
  const [busy, setBusy] = useState(false);
  const docs = useQuery({ queryKey: ['admin', 'docs', product.id], queryFn: async () => check(await db().from('private_documents').select('id, title, doc_type, storage_path, created_at').eq('owner_type', 'product').eq('owner_id', product.id).order('created_at')) as Doc[] });
  const reviews = useQuery({ queryKey: ['admin', 'reviews', product.id], queryFn: async () => check(await db().from('compliance_reviews').select('id, compliance_status, trademark_review_status, notes, created_at').eq('product_id', product.id).order('created_at', { ascending: false })) as Array<{ id: string; compliance_status: string; trademark_review_status: string; notes: string | null; created_at: string }> });
  const [docTitle, setDocTitle] = useState('');
  const [docType, setDocType] = useState('declaration');

  const submit = async () => {
    setBusy(true);
    try {
      const r = await rpc<{ publish_blockers: string[] }>('staff_review_product', { p_product_id: product.id, p_trademark_status: tm, p_compliance_status: cs, p_checklist: checklist, p_notes: notes || null });
      toast(r.publish_blockers.length ? 'Проверка сохранена. Для публикации заполните карточку товара' : 'Проверка сохранена, товар можно публиковать', 'success');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    } catch (e) { toast(humanizeError(errText(e)), 'error'); } finally { setBusy(false); }
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (!docTitle.trim()) { toast('Укажите название документа', 'error'); return; }
    try {
      const { path, mime } = await uploadPrivateDocument('product', product.id, f);
      check(await db().from('private_documents').insert({ owner_type: 'product', owner_id: product.id, title: docTitle.trim(), doc_type: docType, storage_path: path, mime_type: mime, size_bytes: f.size }));
      setDocTitle('');
      await qc.invalidateQueries({ queryKey: ['admin', 'docs', product.id] });
      toast('Документ загружен', 'success');
    } catch (e) { toast(errText(e), 'error'); }
  };

  const open = async (d: Doc) => {
    try { openExternalLink(await signedDocumentUrl(d.storage_path)); } catch (e) { toast(errText(e), 'error'); }
  };

  const approving = cs === 'approved' || tm === 'approved';
  const complete = PRODUCT_CHECKLIST.every(([k]) => checklist[k]);

  return (
    <Sheet open onClose={onClose} title={product.title} footer={canReview ? <Button block loading={busy} disabled={cs === 'approved' && !complete} onClick={submit}>Сохранить решение</Button> : undefined}>
      <div className="space-y-6">
        <dl>
          <KV k="Бренд">{product.brand_name ?? '—'}</KV>
          <KV k="Происхождение">{product.origin_description ?? '—'}</KV>
          <KV k="Документы поставщика">{product.supplier_documents_reference ?? '—'}</KV>
        </dl>

        <div>
          <p className="mb-2 font-medium">Документы</p>
          {docs.data?.length ? (
            <ul className="mb-3 divide-y divide-line text-sm">
              {docs.data.map((d) => <li key={d.id} className="flex items-center justify-between py-2"><span>{d.title} <span className="text-fog">{formatDateTime(d.created_at)}</span></span><Button size="sm" variant="ghost" onClick={() => open(d)}>Открыть</Button></li>)}
            </ul>
          ) : <p className="mb-3 text-sm text-graphite">Документов нет.</p>}
          <div className="grid gap-2 md:grid-cols-[1fr_160px]">
            <Input placeholder="Название документа" value={docTitle} onChange={(e) => setDocTitle(e.target.value)} />
            <Select value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Тип документа">
              <option value="declaration">Декларация</option><option value="certificate">Сертификат</option><option value="contract">Договор</option>
              <option value="invoice">Накладная</option><option value="trademark">Права на обозначение</option><option value="photo">Фото</option><option value="other">Другое</option>
            </Select>
          </div>
          <input type="file" accept="application/pdf,image/jpeg,image/png" className="mt-2 text-sm" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
        </div>

        {canReview ? (
          <>
            <fieldset className="space-y-2.5">
              <legend className="mb-2 font-medium">Чек-лист</legend>
              {PRODUCT_CHECKLIST.map(([k, label]) => <Checkbox key={k} checked={!!checklist[k]} onChange={(v) => setChecklist({ ...checklist, [k]: v })}>{label}</Checkbox>)}
            </fieldset>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Товарные знаки и обозначения">{(id) => <Select id={id} value={tm} onChange={(e) => setTm(e.target.value)}>{Object.entries(REVIEW_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
              <Field label="Общее соответствие">{(id) => <Select id={id} value={cs} onChange={(e) => setCs(e.target.value)}>{Object.entries(REVIEW_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            </div>
            <Field label="Заметки проверяющего" optional>{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
            {approving && !complete ? <p className="text-sm text-amber">Для одобрения отметьте все пункты чек-листа.</p> : null}
          </>
        ) : null}

        {reviews.data?.length ? (
          <div>
            <p className="mb-2 font-medium">История проверок</p>
            <ul className="space-y-2 text-sm">
              {reviews.data.map((r) => <li key={r.id}>{formatDateTime(r.created_at)}: {REVIEW_STATUS_LABEL[r.compliance_status]} / знаки: {REVIEW_STATUS_LABEL[r.trademark_review_status]}{r.notes ? ` — ${r.notes}` : ''}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
