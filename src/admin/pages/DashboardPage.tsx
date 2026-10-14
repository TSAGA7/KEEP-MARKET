import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { countProductsByStatus, rpc } from '../api';
import { AdminPage } from '../ui';
import { useSession } from '@/lib/session';
import { Button, ErrorState, Notice, Price, Skeleton } from '@/components/ui';

interface Dash {
  orders_new: number; orders_checking: number; orders_awaiting_customer: number; orders_confirmed: number; orders_supplier: number;
  orders_ready: number; orders_shipped: number; orders_issue: number; open_requests_amount_kopecks: number;
  products_published: number; products_pending_review: number; variants_stale_stock: number; stock_freshness_hours: number;
  paid_amount_kopecks?: number; refunded_amount_kopecks?: number; paid_orders_cost_kopecks?: number; paid_orders_items_kopecks?: number; paid_orders_without_cost?: number;
}

function Stat({ label, value, to, tone }: { label: string; value: number | string; to?: string; tone?: 'warn' | 'bad' }) {
  const body = (
    <div className="flex h-full flex-col justify-between gap-3 border border-line p-4">
      <span className="text-sm text-graphite">{label}</span>
      <span className={`num font-display text-2xl ${tone === 'bad' && Number(value) > 0 ? 'text-rust' : tone === 'warn' && Number(value) > 0 ? 'text-amber' : ''}`}>{value}</span>
    </div>
  );
  return to ? <Link to={to} className="block hover:bg-concrete">{body}</Link> : body;
}

export default function DashboardPage() {
  const s = useSession();
  const q = useQuery({ queryKey: ['admin', 'dashboard'], queryFn: () => rpc<Dash>('staff_dashboard'), refetchInterval: 60_000 });
  const counts = useQuery({ queryKey: ['admin', 'dashboard', 'product-counts'], queryFn: () => countProductsByStatus(['draft', 'archived']), refetchInterval: 60_000 });
  const d = q.data;

  return (
    <AdminPage title="Обзор" actions={
      <>
        {s.isAdmin ? <Link to="/admin/products/new"><Button size="sm">Добавить товар</Button></Link> : null}
        {s.isAdmin ? <Link to="/admin/pricing"><Button size="sm" variant="secondary">Импортировать прайс</Button></Link> : null}
      </>
    }>
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div> : null}
      {d ? (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 font-medium">Заявки и заказы</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Новые заявки" value={d.orders_new} to="/admin/orders?status=new" tone="warn" />
              <Stat label="Требуют подтверждения наличия" value={d.orders_checking} to="/admin/orders?status=checking_availability" tone="warn" />
              <Stat label="Ждут ответа покупателя" value={d.orders_awaiting_customer} to="/admin/orders?status=awaiting_customer_confirmation" />
              <Stat label="Подтверждены — передать поставщику" value={d.orders_confirmed} to="/admin/orders?status=confirmed" />
              <Stat label="У поставщика" value={d.orders_supplier} to="/admin/orders?status=supplier_processing" />
              <Stat label="Готовы к отправке" value={d.orders_ready} to="/admin/orders?status=ready_to_ship" />
              <Stat label="Отправлены" value={d.orders_shipped} to="/admin/orders?status=shipped" />
              <Stat label="С проблемами" value={d.orders_issue} to="/admin/orders?status=issue" tone="bad" />
            </div>
            <p className="mt-3 text-sm text-graphite">
              Сумма открытых заявок по ценам на момент оформления: <Price kopecks={d.open_requests_amount_kopecks} />. Это не выручка: оплата и наличие ещё не подтверждены.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-medium">Каталог</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Опубликовано товаров" value={d.products_published} to="/admin/products?status=published" />
              <Stat label="Черновики" value={counts.data?.draft ?? '—'} to="/admin/products?status=draft" />
              <Stat label="В архиве" value={counts.data?.archived ?? '—'} to="/admin/products?status=archived" />
              <Stat label={`Остаток не подтверждён > ${d.stock_freshness_hours} ч`} value={d.variants_stale_stock} to="/admin/variants?stale=1" tone="warn" />
            </div>
          </section>

          {d.paid_amount_kopecks !== undefined ? (
            <section>
              <h2 className="mb-1 font-medium">Деньги по подтверждённым данным</h2>
              <p className="mb-3 text-sm text-graphite">Учитываются только платежи, подтверждённые провайдером или зафиксированные вручную владельцем/администратором.</p>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Поступило оплат" value={fmt(d.paid_amount_kopecks)} to="/admin/payments" />
                <Stat label="Возвращено" value={fmt(d.refunded_amount_kopecks ?? 0)} />
                <Stat label="Закупочная стоимость оплаченных заказов" value={fmt(d.paid_orders_cost_kopecks ?? 0)} />
                <Stat label="Товары в оплаченных заказах минус закупка" value={fmt((d.paid_orders_items_kopecks ?? 0) - (d.paid_orders_cost_kopecks ?? 0))} />
              </div>
              {d.paid_orders_without_cost ? (
                <Notice tone="warn" className="mt-3">У {d.paid_orders_without_cost} оплаченных заказов нет закупочной цены по части позиций — разница с закупкой занижена или неполна.</Notice>
              ) : null}
            </section>
          ) : null}

          <section>
            <h2 className="mb-3 font-medium">Быстрые действия</h2>
            <div className="flex flex-wrap gap-2">
              <Link to="/admin/orders?status=new"><Button size="sm" variant="secondary">Новые заявки</Button></Link>
              <Link to="/admin/orders?status=checking_availability"><Button size="sm" variant="secondary">Требуют подтверждения наличия</Button></Link>
              <Link to="/admin/orders?status=confirmed"><Button size="sm" variant="secondary">Передать поставщику</Button></Link>
              <Link to="/admin/products"><Button size="sm" variant="secondary">Управление каталогом</Button></Link>
            </div>
          </section>
        </div>
      ) : null}
    </AdminPage>
  );
}

function fmt(k: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(k / 100)) + ' ₽';
}
