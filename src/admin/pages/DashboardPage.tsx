// «Бухгалтерия» — деньги магазина. Доступна только владельцу (сервер отдаёт суммы только ему).
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../api';
import { AdminPage } from '../ui';
import { useSession } from '@/lib/session';
import { ErrorState, Notice, Price, Skeleton } from '@/components/ui';

export interface Dash {
  orders_new: number; orders_checking: number; orders_awaiting_payment: number; orders_awaiting_shipment: number;
  orders_shipped: number; orders_issue: number; open_requests_amount_kopecks: number; products_published: number;
  paid_amount_kopecks?: number; refunded_amount_kopecks?: number; paid_orders_cost_kopecks?: number; paid_orders_items_kopecks?: number;
  paid_orders_logistics_kopecks?: number; paid_orders_without_cost?: number;
}

export function Stat({ label, value, to, tone }: { label: string; value: number | string; to?: string; tone?: 'warn' | 'bad' | 'good' }) {
  const body = (
    <div className="flex h-full flex-col justify-between gap-3 border border-line p-4">
      <span className="text-sm text-graphite">{label}</span>
      <span className={`num font-display text-2xl ${tone === 'bad' && (typeof value === 'string' || Number(value) > 0) ? 'text-rust' : tone === 'warn' && Number(value) > 0 ? 'text-amber' : tone === 'good' ? 'text-moss' : ''}`}>{value}</span>
    </div>
  );
  return to ? <Link to={to} className="block hover:bg-concrete">{body}</Link> : body;
}

function fmt(k: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(k / 100)) + ' ₽';
}

export default function AccountingPage() {
  const s = useSession();
  const q = useQuery({ queryKey: ['admin', 'dashboard'], queryFn: () => rpc<Dash>('staff_dashboard'), refetchInterval: 60_000, enabled: s.isOwner });
  const d = q.data;

  if (!s.isOwner) {
    return <AdminPage title="Бухгалтерия"><Notice>Раздел доступен только владельцу магазина.</Notice></AdminPage>;
  }

  const items = d?.paid_orders_items_kopecks ?? 0;
  const cost = d?.paid_orders_cost_kopecks ?? 0;
  const logistics = d?.paid_orders_logistics_kopecks ?? 0;
  const result = items - cost - logistics;

  return (
    <AdminPage title="Бухгалтерия">
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div> : null}
      {d ? (
        <div className="space-y-8">
          <section>
            <h2 className="mb-1 font-medium">Поступления</h2>
            <p className="mb-3 text-sm text-graphite">Только реально полученные деньги: онлайн-платежи и оплаты, зафиксированные вручную.</p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Поступило оплат" value={fmt(d.paid_amount_kopecks ?? 0)} to="/admin/payments" />
              <Stat label="Возвращено покупателям" value={fmt(d.refunded_amount_kopecks ?? 0)} />
            </div>
          </section>

          <section>
            <h2 className="mb-1 font-medium">Оплаченные заказы</h2>
            <p className="mb-3 text-sm text-graphite">Отменённые не учитываются.</p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Товары по цене продажи" value={fmt(items)} />
              <Stat label="Закупка" value={fmt(cost)} />
              <Stat label="Расходы на доставку (курьер)" value={fmt(logistics)} />
              <Stat label="Итог: продажи − закупка − доставка" value={fmt(result)} tone={result < 0 ? 'bad' : 'good'} />
            </div>
            {d.paid_orders_without_cost ? (
              <Notice tone="warn" className="mt-3">У {d.paid_orders_without_cost} оплаченных заказов не указана закупочная цена части товаров — итог завышен. Закупочная цена задаётся в карточке товара.</Notice>
            ) : null}
          </section>

          <section>
            <h2 className="mb-1 font-medium">Ещё не оплачено</h2>
            <p className="text-sm text-graphite">Открытые заявки на сумму <Price kopecks={d.open_requests_amount_kopecks} /> — это ещё не деньги: оплата не получена.</p>
          </section>
        </div>
      ) : null}
    </AdminPage>
  );
}
