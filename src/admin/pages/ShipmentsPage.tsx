import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check } from '../api';
import { AdminPage, Table, Td } from '../ui';
import { ErrorState, Skeleton } from '@/components/ui';
import { formatDateTime } from '@/components/order';

const CARRIER: Record<string, string> = { cdek: 'СДЭК', ozon: 'Ozon', russian_post: 'Почта России', yandex: 'Яндекс Доставка', keep_courier: 'Курьер KEEP MARKET', other: 'Другое' };
const STATUS: Record<string, string> = { created: 'Создано', handed_over: 'Передано перевозчику', in_transit: 'В пути', delivered: 'Доставлено', returned: 'Возврат', lost: 'Утеряно' };
interface Row { id: string; carrier: string; tracking_number: string | null; status: string; shipped_at: string | null; delivered_at: string | null; orders: { id: string; number: string } | null }

export default function ShipmentsPage() {
  const q = useQuery({ queryKey: ['admin', 'shipments'], queryFn: async () => check(await db().from('shipments').select('id, carrier, tracking_number, status, shipped_at, delivered_at, orders(id, number)').order('created_at', { ascending: false }).limit(200)) as unknown as Row[] });
  return (
    <AdminPage title="Отправления">
      <p className="mb-4 max-w-2xl text-sm text-graphite">Отправления создаются из карточки заказа действием «Отправить и внести трек-номер». Автоматической передачи заказов перевозчикам на первом этапе нет — отслеживайте посылки на сайте перевозчика.</p>
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-32" /> : null}
      {q.data?.length === 0 ? <p className="text-sm text-graphite">Отправлений пока нет.</p> : null}
      {q.data?.length ? (
        <Table head={['Заказ', 'Перевозчик', 'Трек-номер', 'Статус', 'Отправлено', 'Доставлено']}>
          {q.data.map((r) => (
            <tr key={r.id}>
              <Td>{r.orders ? <Link to={`/admin/orders/${r.orders.id}`} className="num underline-offset-4 hover:underline">{r.orders.number}</Link> : '—'}</Td>
              <Td>{CARRIER[r.carrier] ?? r.carrier}</Td><Td className="num select-all">{r.tracking_number ?? '—'}</Td><Td>{STATUS[r.status] ?? r.status}</Td>
              <Td className="whitespace-nowrap">{r.shipped_at ? formatDateTime(r.shipped_at) : '—'}</Td><Td className="whitespace-nowrap">{r.delivered_at ? formatDateTime(r.delivered_at) : '—'}</Td>
            </tr>
          ))}
        </Table>
      ) : null}
    </AdminPage>
  );
}
