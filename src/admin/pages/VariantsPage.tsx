import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check, errText, rpc } from '../api';
import { AdminPage, Table, Td } from '../ui';
import { Badge, Button, Chip, ErrorState, Input, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { formatDateTime } from '@/components/order';

interface Row { id: string; sku: string; size: string | null; color: string | null; stock_qty: number; stock_confirmed_at: string | null; is_active: boolean;
  products: { id: string; title: string; status: string } | null }

export default function VariantsPage() {
  const [sp, setSp] = useSearchParams();
  const stale = sp.get('stale') === '1';
  const qc = useQueryClient();
  const toast = useToast();
  const hours = useQuery({ queryKey: ['admin', 'freshness'], queryFn: async () => Number((check(await db().from('store_settings').select('value').eq('key', 'stock_freshness_hours').maybeSingle()) as { value: number } | null)?.value ?? 48) });
  const q = useQuery({
    queryKey: ['admin', 'variants', stale],
    queryFn: async () => check(await db().from('product_variants').select('id, sku, size, color, stock_qty, stock_confirmed_at, is_active, products!inner(id, title, status)')
      .neq('products.status', 'archived').order('stock_confirmed_at', { ascending: true, nullsFirst: true }).limit(300)) as unknown as Row[],
  });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const threshold = Date.now() - (hours.data ?? 48) * 3600_000;
  const isStale = (r: Row) => !r.stock_confirmed_at || new Date(r.stock_confirmed_at).getTime() < threshold;
  const rows = (q.data ?? []).filter((r) => !stale || (isStale(r) && r.stock_qty > 0 && r.is_active));

  const confirm = async (r: Row) => {
    const raw = edits[r.id] ?? String(r.stock_qty);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) { toast('Остаток — целое число ≥ 0', 'error'); return; }
    try {
      await rpc('staff_confirm_stock', { p_variant_id: r.id, p_stock_qty: n, p_note: 'Подтверждено в админке' });
      toast('Остаток подтверждён', 'success');
      await qc.invalidateQueries({ queryKey: ['admin', 'variants'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    } catch (e) { toast(errText(e), 'error'); }
  };

  return (
    <AdminPage title="Размеры и остатки">
      <p className="mb-3 max-w-2xl text-sm text-graphite">Подтверждайте остаток после ответа поставщика. Если остаток не подтверждался дольше {hours.data ?? 48} ч, покупатель видит «Наличие уточняется» — гарантию наличия магазин не даёт.</p>
      <div className="mb-4 flex gap-2">
        <Chip active={!stale} onClick={() => setSp({}, { replace: true })}>Все варианты</Chip>
        <Chip active={stale} onClick={() => setSp({ stale: '1' }, { replace: true })}>Требуют подтверждения</Chip>
      </div>
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-40" /> : null}
      {q.data ? (
        <Table head={['Товар', 'Вариант', 'Остаток', 'Подтверждён', '']}>
          {rows.map((r) => (
            <tr key={r.id}>
              <Td><Link to={`/admin/products/${r.products?.id}`} className="underline-offset-4 hover:underline">{r.products?.title}</Link><div className="num text-xs text-fog">{r.sku}</div></Td>
              <Td>{[r.color, r.size].filter(Boolean).join(', ') || '—'}</Td>
              <Td><Input className="h-9 w-20" inputMode="numeric" value={edits[r.id] ?? String(r.stock_qty)} onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })} aria-label={`Остаток ${r.sku}`} /></Td>
              <Td className="whitespace-nowrap">{r.stock_confirmed_at ? formatDateTime(r.stock_confirmed_at) : 'никогда'} {isStale(r) ? <Badge tone="warn">устарел</Badge> : null}</Td>
              <Td><Button size="sm" variant="secondary" onClick={() => confirm(r)}>Подтвердить</Button></Td>
            </tr>
          ))}
        </Table>
      ) : null}
    </AdminPage>
  );
}
