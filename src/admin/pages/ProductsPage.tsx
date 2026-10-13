import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listProducts, PRODUCT_STATUS_LABEL, type AdminProduct } from '../api';
import { AdminPage, Table, Td } from '../ui';
import { useSession } from '@/lib/session';
import { Badge, Button, Chip, DemoBadge, EmptyState, ErrorState, Input, Price, Skeleton } from '@/components/ui';
import { formatDateTime } from '@/components/order';

export default function ProductsPage() {
  const [sp, setSp] = useSearchParams();
  const s = useSession();
  const status = sp.get('status') ?? '';
  const term = sp.get('q') ?? '';
  const q = useQuery({ queryKey: ['admin', 'products', status, term], queryFn: () => listProducts({ status, q: term }) });
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
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-40" /> : null}
      {q.data?.length === 0 ? <EmptyState title="Товаров нет" text="Создайте первый товар — он сохранится как черновик." /> : null}
      {q.data?.length ? (
        <Table head={['Товар', 'Артикул', 'Цена', 'Статус', 'Изменён']}>
          {q.data.map((p) => {
            return (
              <tr key={p.id} className="hover:bg-concrete/60">
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
