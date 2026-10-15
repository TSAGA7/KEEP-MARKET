import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BLOCKER_LABEL, bulkDeleteProducts, bulkSetProductStatus, listProducts, PRODUCT_STATUS_LABEL,
  type AdminProduct, type BulkResult,
} from '../api';
import { AdminPage, Table, Td } from '../ui';
import { useSession } from '@/lib/session';
import { Badge, Button, Chip, DemoBadge, EmptyState, ErrorState, Input, Price, Skeleton } from '@/components/ui';
import { formatDateTime } from '@/components/order';
import { useToast } from '@/components/toast';

type BulkAction = 'published' | 'hidden' | 'draft' | 'archived' | 'delete';

const ACTION_DONE: Record<BulkAction, string> = {
  published: 'Опубликовано', hidden: 'Скрыто с витрины', draft: 'Переведено в черновики', archived: 'Отправлено в архив', delete: 'Удалено',
};

/** Понятное объяснение, почему не получилось (сгруппировано по причинам). */
function describeFailures(failed: BulkResult['failed']): string {
  const reasons = new Map<string, number>();
  for (const f of failed) {
    const codes = f.message.match(/PUBLISH_BLOCKED: ([A-Z_,]+)/)?.[1]?.split(',');
    const list = codes?.length ? codes.map((c) => BLOCKER_LABEL[c] ?? c)
      : f.message.includes('FORBIDDEN') ? ['нет прав']
      : f.message.includes('foreign key') || f.message.includes('violates') ? ['товар есть в заказах — удалить нельзя, отправьте в архив']
      : [f.message];
    for (const r of list) reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  return [...reasons].map(([r, n]) => `${r.toLowerCase()} (${n})`).join('; ');
}

function Checkbox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <label className="flex h-10 w-10 cursor-pointer items-center justify-center" onClick={(e) => e.stopPropagation()}>
      <input ref={ref} type="checkbox" aria-label={label} checked={checked} onChange={onChange}
        className="h-[18px] w-[18px] cursor-pointer accent-current" />
    </label>
  );
}

export default function ProductsPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const s = useSession();
  const status = sp.get('status') ?? '';
  const term = sp.get('q') ?? '';
  const q = useQuery({ queryKey: ['admin', 'products', status, term], queryFn: () => listProducts({ status, q: term }) });
  const qc = useQueryClient();
  const toast = useToast();
  const canBulk = s.isAdmin;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<{ action: BulkAction; done: number; total: number } | null>(null);

  // Выбор сбрасывается при смене фильтра или поиска
  useEffect(() => { setSelected(new Set()); }, [status, term]);

  const rows = useMemo(() => q.data ?? [], [q.data]);
  // Оставляем в выборе только то, что есть в текущем списке
  const selectedIds = rows.filter((p) => selected.has(p.id)).map((p) => p.id);
  const allChecked = rows.length > 0 && selectedIds.length === rows.length;
  const someChecked = selectedIds.length > 0 && !allChecked;

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((p) => p.id)));

  const run = async (action: BulkAction) => {
    const ids = selectedIds;
    if (!ids.length || busy) return;
    if (action === 'delete' && !window.confirm(`Удалить навсегда ${ids.length} ${plural(ids.length)}? Фото и размеры тоже удалятся. Вернуть будет нельзя.`)) return;
    if (action === 'archived' && !window.confirm(`Отправить в архив ${ids.length} ${plural(ids.length)}? Они пропадут с витрины.`)) return;
    setBusy({ action, done: 0, total: ids.length });
    const onProgress = (done: number) => setBusy((b) => (b ? { ...b, done } : b));
    try {
      const statusById = Object.fromEntries(rows.map((p) => [p.id, p.status])) as Record<string, AdminProduct['status']>;
      const res = action === 'delete' ? await bulkDeleteProducts(ids, statusById, onProgress) : await bulkSetProductStatus(ids, action, onProgress);
      if (res.ok.length) toast(`${ACTION_DONE[action]}: ${res.ok.length} ${plural(res.ok.length)}`, 'success');
      if (res.failed.length) {
        const m = res.failed[0]?.message ?? '';
        toast(m.includes('schema cache')
          ? 'Удаление ещё не включено на сервере: примените миграции базы'
          : `Не получилось для ${res.failed.length} ${plural(res.failed.length)}: ${describeFailures(res.failed)}`, 'error');
      }
      // В выборе остаются только товары, с которыми не получилось — их удобно поправить
      setSelected(new Set(res.failed.map((f) => f.id)));
      await qc.invalidateQueries({ queryKey: ['admin', 'products'] });
    } finally { setBusy(null); }
  };

  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };

  return (
    <AdminPage title="Товары" actions={s.isAdmin ? <Link to="/admin/products/new"><Button size="sm">Добавить товар</Button></Link> : null}>
      <div className="mb-4 flex flex-col gap-3">
        <Input placeholder="Название или артикул" value={term} onChange={(e) => set('q', e.target.value)} className="max-w-sm" />
        <div className="no-scrollbar flex gap-2 overflow-x-auto">
          <Chip active={!status} onClick={() => set('status', '')}>Все</Chip>
          {(Object.keys(PRODUCT_STATUS_LABEL) as AdminProduct['status'][]).filter((k) => k !== 'pending_review').map((k) => <Chip key={k} active={status === k} onClick={() => set('status', k)}>{PRODUCT_STATUS_LABEL[k]}</Chip>)}
        </div>
      </div>

      {canBulk && selectedIds.length > 0 ? (
        <div className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 border border-line bg-paper p-3">
          <span className="mr-2 text-sm font-medium">
            {busy ? `${ACTION_DONE[busy.action]}… ${busy.done} из ${busy.total}` : `Выбрано: ${selectedIds.length}`}
          </span>
          <Button size="sm" disabled={!!busy} onClick={() => void run('published')}>Опубликовать</Button>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('hidden')}>Скрыть</Button>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('draft')}>В черновики</Button>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('archived')}>В архив</Button>
          <Button size="sm" variant="danger" disabled={!!busy} onClick={() => void run('delete')}>Удалить</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setSelected(new Set())}>Снять выбор</Button>
        </div>
      ) : null}

      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-40" /> : null}
      {q.data?.length === 0 ? <EmptyState title="Товаров нет" text="Создайте первый товар — он сохранится как черновик." /> : null}
      {rows.length ? (
        <Table head={[
          ...(canBulk ? [<Checkbox key="all" checked={allChecked} indeterminate={someChecked} onChange={toggleAll} label="Выбрать все товары" />] : []),
          'Товар', 'Артикул', 'Цена', 'Статус', 'Изменён',
        ]}>
          {rows.map((p) => {
            const isSel = selected.has(p.id);
            return (
              <tr key={p.id} className={`cursor-pointer hover:bg-concrete/60 active:bg-concrete ${isSel ? 'bg-concrete/60' : ''}`}
                onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a, label, input')) navigate(`/admin/products/${p.id}`); }}>
                {canBulk ? (
                  <Td className="w-12 py-1">
                    <Checkbox checked={isSel} onChange={() => toggle(p.id)} label={`Выбрать ${p.title}`} />
                  </Td>
                ) : null}
                <Td><Link to={`/admin/products/${p.id}`} className="font-medium underline-offset-4 hover:underline">{p.title}</Link> {p.is_demo ? <DemoBadge /> : null}</Td>
                <Td className="num text-graphite">{p.sku}</Td>
                <Td><Price kopecks={p.price_kopecks} /></Td>
                <Td><Badge tone={p.status === 'published' ? 'good' : p.status === 'archived' ? 'neutral' : 'warn'}>{PRODUCT_STATUS_LABEL[p.status]}</Badge></Td>
                <Td className="whitespace-nowrap text-graphite">{formatDateTime(p.updated_at)}</Td>
              </tr>
            );
          })}
        </Table>
      ) : null}
    </AdminPage>
  );
}

function plural(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'товар';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'товара';
  return 'товаров';
}
