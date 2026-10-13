// Общие элементы отображения заказа (покупатель и админка)
import clsx from 'clsx';
import { ORDER_STATUS_LABEL, ORDER_STATUS_LABEL_STAFF, PAYMENT_STATUS_LABEL, ITEM_AVAILABILITY_LABEL, type OrderStatus, type PaymentStatus } from '@shared/orders';
import type { OrderHistory, OrderItem } from '@/lib/types';
import { Badge, Price } from './ui';
import { ProductImage } from './product';

export function statusTone(s: OrderStatus): 'neutral' | 'good' | 'warn' | 'bad' | 'ink' {
  if (s === 'cancelled') return 'neutral';
  if (s === 'issue') return 'bad';
  if (s === 'awaiting_customer_confirmation' || s === 'new' || s === 'checking_availability') return 'warn';
  if (s === 'delivered') return 'good';
  return 'ink';
}

export function OrderStatusBadge({ status, staff }: { status: OrderStatus; staff?: boolean }) {
  return <Badge tone={statusTone(status)}>{(staff ? ORDER_STATUS_LABEL_STAFF : ORDER_STATUS_LABEL)[status]}</Badge>;
}

export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return <Badge tone={status === 'paid' ? 'good' : status === 'awaiting_payment' ? 'warn' : status === 'unpaid' ? 'neutral' : 'bad'}>{PAYMENT_STATUS_LABEL[status]}</Badge>;
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function OrderItemsList({ items }: { items: OrderItem[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {items.map((it) => {
        const unavailable = it.availability === 'unavailable';
        const priceChanged = it.unit_price_kopecks !== it.original_unit_price_kopecks;
        return (
          <li key={it.id} className="flex gap-3 py-3">
            <ProductImage src={it.image_url_snapshot} alt="" className={clsx('aspect-[4/5] w-14 shrink-0', unavailable && 'opacity-50')} />
            <div className="min-w-0 flex-1 text-sm">
              <p className={clsx(unavailable && 'text-graphite line-through')}>{it.title_snapshot}</p>
              <p className="text-graphite">{[it.color, it.size && `размер ${it.size}`, `${it.quantity} шт.`].filter(Boolean).join(', ')}</p>
              <p className="text-xs text-fog">Арт. {it.variant_sku_snapshot}</p>
              {it.availability !== 'unknown' ? (
                <p className={clsx('mt-1 text-xs', unavailable ? 'text-rust' : it.availability === 'confirmed' ? 'text-moss' : 'text-amber')}>
                  {ITEM_AVAILABILITY_LABEL[it.availability]}{it.availability_note ? `: ${it.availability_note}` : ''}
                </p>
              ) : null}
              {priceChanged ? <p className="mt-1 text-xs text-amber">Цена изменена: {it.price_change_reason}</p> : null}
            </div>
            <div className="text-right text-sm">
              <Price kopecks={it.line_total_kopecks} className={unavailable ? 'text-fog line-through' : ''} />
              {priceChanged ? <p className="text-xs text-fog line-through"><Price kopecks={it.original_unit_price_kopecks * it.quantity} /></p> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function StatusTimeline({ history, staff }: { history: OrderHistory[]; staff?: boolean }) {
  return (
    <ol className="relative ml-1.5 border-l border-line">
      {history.map((h) => (
        <li key={h.id} className="relative pb-4 pl-5 last:pb-0">
          <span className={clsx('absolute -left-[5px] top-1.5 h-2.5 w-2.5', h.visible_to_customer ? 'bg-ink' : 'bg-fog')} aria-hidden />
          <p className="text-sm font-medium">
            {h.from_status === h.to_status ? 'Заметка' : (staff ? ORDER_STATUS_LABEL_STAFF : ORDER_STATUS_LABEL)[h.to_status as OrderStatus] ?? h.to_status}
            {!h.visible_to_customer ? <span className="ml-2 text-xs font-normal text-fog">видно только сотрудникам</span> : null}
          </p>
          {h.reason ? <p className="text-sm text-graphite">{h.reason}</p> : null}
          <p className="text-xs text-fog">{formatDateTime(h.created_at)}</p>
        </li>
      ))}
    </ol>
  );
}
