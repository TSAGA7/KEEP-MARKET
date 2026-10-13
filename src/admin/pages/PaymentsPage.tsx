import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check } from '../api';
import { AdminPage, Section, Table, Td } from '../ui';
import { Badge, ErrorState, Price, Skeleton } from '@/components/ui';
import { formatDateTime } from '@/components/order';

interface Pay { id: string; provider: string; status: string; amount_kopecks: number; refunded_kopecks: number; created_at: string; paid_at: string | null; is_test: boolean; failure_reason: string | null; orders: { id: string; number: string } | null }
interface Ev { id: number; provider: string; event_type: string; result: string | null; received_at: string; payment_id: string | null }

const STATUS: Record<string, string> = { created: 'Создан', pending: 'Ожидает', succeeded: 'Оплачен', failed: 'Отказ', cancelled: 'Отменён', refunded: 'Возвращён', partially_refunded: 'Частичный возврат' };

export default function PaymentsPage() {
  const pays = useQuery({ queryKey: ['admin', 'payments'], queryFn: async () => check(await db().from('payments').select('id, provider, status, amount_kopecks, refunded_kopecks, created_at, paid_at, is_test, failure_reason, orders(id, number)').order('created_at', { ascending: false }).limit(200)) as unknown as Pay[] });
  const events = useQuery({ queryKey: ['admin', 'payment-events'], queryFn: async () => check(await db().from('payment_events').select('id, provider, event_type, result, received_at, payment_id').order('received_at', { ascending: false }).limit(100)) as Ev[] });
  return (
    <AdminPage title="Платежи">
      <p className="mb-4 max-w-2xl text-sm text-graphite">Платёж создаётся только для подтверждённого заказа. Статус «Оплачен» выставляется по проверенному уведомлению провайдера или фиксацией офлайн-оплаты. Возвраты оформляются из карточки заказа.</p>
      <Section title="Операции">
        {pays.isError ? <ErrorState onRetry={() => void pays.refetch()} /> : null}
        {pays.isLoading ? <Skeleton className="h-32" /> : null}
        {pays.data?.length === 0 ? <p className="text-sm text-graphite">Платежей пока не было.</p> : null}
        {pays.data?.length ? (
          <Table head={['Заказ', 'Провайдер', 'Статус', 'Сумма', 'Возвращено', 'Создан', 'Оплачен']}>
            {pays.data.map((p) => (
              <tr key={p.id}>
                <Td>{p.orders ? <Link to={`/admin/orders/${p.orders.id}`} className="num underline-offset-4 hover:underline">{p.orders.number}</Link> : '—'}</Td>
                <Td>{p.provider}{p.is_test ? <Badge tone="warn">тест</Badge> : null}</Td>
                <Td><Badge tone={p.status === 'succeeded' ? 'good' : p.status === 'failed' ? 'bad' : 'neutral'}>{STATUS[p.status] ?? p.status}</Badge>{p.failure_reason ? <div className="text-xs text-fog">{p.failure_reason}</div> : null}</Td>
                <Td><Price kopecks={p.amount_kopecks} /></Td><Td><Price kopecks={p.refunded_kopecks} /></Td>
                <Td className="whitespace-nowrap">{formatDateTime(p.created_at)}</Td><Td className="whitespace-nowrap">{p.paid_at ? formatDateTime(p.paid_at) : '—'}</Td>
              </tr>
            ))}
          </Table>
        ) : null}
      </Section>
      <Section title="Журнал уведомлений провайдера">
        {events.data?.length ? (
          <Table head={['Получено', 'Провайдер', 'Событие', 'Результат обработки']}>
            {events.data.map((e) => <tr key={e.id}><Td className="whitespace-nowrap">{formatDateTime(e.received_at)}</Td><Td>{e.provider}</Td><Td>{e.event_type}</Td><Td>{e.result ?? '—'}</Td></tr>)}
          </Table>
        ) : <p className="text-sm text-graphite">Уведомлений не было.</p>}
      </Section>
    </AdminPage>
  );
}
