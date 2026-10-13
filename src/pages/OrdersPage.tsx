import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { myOrders } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/layout';
import { OrderStatusBadge, formatDateTime } from '@/components/order';
import { Button, EmptyState, ErrorState, Price, Skeleton } from '@/components/ui';
import { IconChevronRight } from '@/components/icons';
import { TelegramRequired } from './ProfilePage';

export default function OrdersPage() {
  const session = useSession();
  const q = useQuery({ queryKey: ['my-orders'], queryFn: myOrders, enabled: session.status === 'authenticated' });
  if (session.status !== 'authenticated' && session.status !== 'loading') return <><PageHeader title="Мои заказы" /><TelegramRequired /></>;

  return (
    <div>
      <PageHeader title="Мои заказы" />
      {q.isLoading || session.status === 'loading' ? (
        <div className="space-y-3 px-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : q.isError ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <EmptyState title="Заказов пока нет" text="Оформленные заявки появятся здесь, даже если вы не перешли в Telegram-диалог." action={<Link to="/catalog"><Button>Перейти в каталог</Button></Link>} />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {q.data.map((o) => (
            <li key={o.id}>
              <Link to={`/orders/${o.id}`} className="flex items-center gap-3 px-4 py-4">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2"><span className="num font-semibold">{o.number}</span><OrderStatusBadge status={o.status} /></div>
                  <span className="text-sm text-graphite">{formatDateTime(o.created_at)}</span>
                </div>
                <Price kopecks={o.total_kopecks} />
                <IconChevronRight className="text-fog" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
