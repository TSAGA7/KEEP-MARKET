import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check } from '../api';
import { AdminPage, Table, Td } from '../ui';
import { Chip, EmptyState, ErrorState, Input, Price, Skeleton } from '@/components/ui';
import { OrderStatusBadge, PaymentBadge, formatDateTime } from '@/components/order';
import { ORDER_STATUSES, ORDER_STATUS_LABEL_STAFF, type OrderStatus, type PaymentStatus } from '@shared/orders';
import { SHIPPING_PROVIDERS, type DeliveryMethod } from '@shared/delivery';

interface Row { id: string; number: string; status: OrderStatus; payment_status: PaymentStatus; total_kopecks: number; delivery_method: DeliveryMethod; created_at: string; assigned_manager_id: string | null }

export default function OrdersPage() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const term = sp.get('q') ?? '';
  const q = useQuery({
    queryKey: ['admin', 'orders', status, term],
    queryFn: async () => {
      let query = db().from('orders').select('id, number, status, payment_status, total_kopecks, delivery_method, created_at, assigned_manager_id')
        .order('created_at', { ascending: false }).limit(200);
      if (status) query = query.eq('status', status);
      if (term) query = query.ilike('number', `%${term.replace(/[%_]/g, '')}%`);
      return check(await query) as Row[];
    },
    refetchInterval: 30_000,
  });
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };

  return (
    <AdminPage title="Заказы">
      <div className="mb-4 flex flex-col gap-3">
        <Input placeholder="Номер заявки, например KM-261013" value={term} onChange={(e) => set('q', e.target.value)} className="max-w-sm" />
        <div className="no-scrollbar flex gap-2 overflow-x-auto">
          <Chip active={!status} onClick={() => set('status', '')}>Все</Chip>
          {ORDER_STATUSES.map((s) => <Chip key={s} active={status === s} onClick={() => set('status', s)}>{ORDER_STATUS_LABEL_STAFF[s]}</Chip>)}
        </div>
      </div>
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-40" /> : null}
      {q.data && q.data.length === 0 ? <EmptyState title="Заказов нет" text={status ? 'В этом статусе пока пусто.' : 'Новые заявки появятся здесь сразу после оформления.'} /> : null}
      {q.data && q.data.length > 0 ? (
        <Table head={['Номер', 'Статус', 'Оплата', 'Доставка', 'Сумма', 'Создан']}>
          {q.data.map((o) => (
            <tr key={o.id} className="hover:bg-concrete/60">
              <Td><Link to={`/admin/orders/${o.id}`} className="num font-semibold underline-offset-4 hover:underline">{o.number}</Link></Td>
              <Td><OrderStatusBadge status={o.status} staff /></Td>
              <Td><PaymentBadge status={o.payment_status} /></Td>
              <Td className="text-graphite">{SHIPPING_PROVIDERS[o.delivery_method]?.title}</Td>
              <Td><Price kopecks={o.total_kopecks} /></Td>
              <Td className="whitespace-nowrap text-graphite">{formatDateTime(o.created_at)}</Td>
            </tr>
          ))}
        </Table>
      ) : null}
    </AdminPage>
  );
}
