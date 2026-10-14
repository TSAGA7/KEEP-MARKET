import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPublicSettings, orderAction, orderDetail, startPayment } from '@/lib/api';
import { ApiError } from '@/lib/supabase';
import { openExternalLink, openTelegramLink } from '@/lib/telegram';
import { useSession } from '@/lib/session';
import { formatAddress, SHIPPING_PROVIDERS } from '@shared/delivery';
import { PAYMENT_METHOD_LABEL, humanizeError } from '@shared/orders';
import { PageHeader } from '@/components/layout';
import { OrderItemsList, OrderStatusBadge, PaymentBadge, StatusTimeline, formatDateTime } from '@/components/order';
import { Button, EmptyState, ErrorState, Notice, Price, Sheet, Skeleton, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { TelegramRequired } from './ProfilePage';

export default function OrderDetailPage() {
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const returnedFromPayment = sp.get('payment') === 'return';
  const q = useQuery({
    queryKey: ['order', id],
    queryFn: () => orderDetail(id),
    enabled: session.status === 'authenticated',
    // После возврата со страницы оплаты ждём подтверждения от сервера (возврат ≠ оплата)
    refetchInterval: (query) => (returnedFromPayment && query.state.data?.order.payment_status !== 'paid' ? 4000 : false),
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: getPublicSettings });
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (returnedFromPayment && q.data?.order.payment_status === 'paid') {
      toast('Оплата подтверждена', 'success');
      sp.delete('payment');
      setSp(sp, { replace: true });
    }
  }, [returnedFromPayment, q.data?.order.payment_status, sp, setSp, toast]);

  if (session.status !== 'authenticated' && session.status !== 'loading') return <TelegramRequired />;
  if (q.isLoading || session.status === 'loading') return <div className="space-y-3 p-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-40" /></div>;
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  if (!q.data) return <EmptyState title="Заказ не найден" action={<Link to="/orders" className="underline underline-offset-4">Мои заказы</Link>} />;

  const { order, items, history, shipments, payments, contact } = q.data;
  const onlineEnabled = settings.data?.online_payment_enabled === true;
  const canPay = order.payment_method === 'online' && ['awaiting_payment', 'awaiting_shipment'].includes(order.status)
    && ['unpaid', 'awaiting_payment'].includes(order.payment_status) && order.delivery_kopecks !== null;
  const canCancel = ['new', 'checking_availability', 'awaiting_payment'].includes(order.status) && order.payment_status === 'unpaid';
  const testPayment = payments.some((p) => p.is_test);
  const manager = typeof settings.data?.manager_contact_url === 'string' ? settings.data.manager_contact_url : null;
  const bot = typeof settings.data?.telegram_bot_username === 'string' ? settings.data.telegram_bot_username : null;
  const supportLink = bot ? `https://t.me/${bot}` : manager;

  const run = async (name: string, fn: () => Promise<unknown>, okText: string) => {
    setBusy(name);
    try {
      await fn();
      toast(okText, 'success');
      await qc.invalidateQueries({ queryKey: ['order', id] });
      await qc.invalidateQueries({ queryKey: ['my-orders'] });
    } catch (e) {
      toast(humanizeError(e instanceof ApiError ? e.code : null), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pay = async () => {
    setBusy('pay');
    try {
      const r = await startPayment(order.id);
      openExternalLink(r.confirmation_url);
    } catch (e) {
      toast(humanizeError(e instanceof ApiError ? e.code : null), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pb-6">
      <PageHeader title={<span className="num">{order.number}</span>} sub={`от ${formatDateTime(order.created_at)}`}
        right={<OrderStatusBadge status={order.status} />} />

      <div className="space-y-3 px-4">
        {order.status === 'awaiting_payment' && order.payment_method !== 'online' ? (
          <Notice>Заказ подтверждён и ожидает оплату. Менеджер напишет вам в Telegram, как оплатить.{order.agreed_terms?.eta_text ? ` Срок: ${order.agreed_terms.eta_text}.` : ''}</Notice>
        ) : null}
        {order.status === 'new' || order.status === 'checking_availability' ? (
          <Notice>Заказ ожидает подтверждения менеджера. Оплата на этом этапе не производится.</Notice>
        ) : null}
        {returnedFromPayment && order.payment_status !== 'paid' ? (
          <Notice tone="warn">Проверяем оплату. Статус обновится, когда платёжная система подтвердит платёж — обычно это занимает до минуты.</Notice>
        ) : null}
        {order.status === 'cancelled' && order.cancel_reason ? <Notice>Причина отмены: {order.cancel_reason}</Notice> : null}
        {canPay && (onlineEnabled || testPayment || order.payment_status === 'awaiting_payment') ? (
          <Button block size="lg" loading={busy === 'pay'} onClick={pay}>Оплатить онлайн <Price kopecks={order.total_kopecks} /></Button>
        ) : null}
      </div>

      <section className="px-4 pt-6">
        <h2 className="mb-2 font-display text-md">Состав</h2>
        <OrderItemsList items={items} />
        <dl className="mt-3 space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-graphite">Товары</dt><dd><Price kopecks={order.items_total_kopecks} /></dd></div>
          {order.discount_kopecks > 0 ? <div className="flex justify-between"><dt className="text-graphite">Скидка</dt><dd>−<Price kopecks={order.discount_kopecks} /></dd></div> : null}
          <div className="flex justify-between"><dt className="text-graphite">Доставка</dt><dd>{order.delivery_kopecks === null ? <span className="text-graphite">согласуется</span> : <Price kopecks={order.delivery_kopecks} />}</dd></div>
          <div className="flex justify-between pt-1 text-md font-semibold"><dt>Итого</dt><dd><Price kopecks={order.total_kopecks} /></dd></div>
        </dl>
      </section>

      <section className="space-y-2 px-4 pt-6 text-sm">
        <h2 className="mb-2 font-display text-md">Доставка и оплата</h2>
        <p><span className="text-graphite">Способ: </span>{SHIPPING_PROVIDERS[order.delivery_method]?.title}</p>
        {contact ? <p><span className="text-graphite">Адрес: </span>{formatAddress(order.delivery_method, contact.address) || '—'}</p> : null}
        {contact ? <p><span className="text-graphite">Получатель: </span>{contact.recipient_name}, {contact.phone}</p> : null}
        {order.agreed_terms?.eta_text ? <p><span className="text-graphite">Срок: </span>{order.agreed_terms.eta_text}</p> : null}
        <p className="flex items-center gap-2"><span className="text-graphite">Оплата:</span>
          {order.payment_method ? PAYMENT_METHOD_LABEL[order.payment_method] : 'согласует менеджер'} <PaymentBadge status={order.payment_status} />
        </p>
        {shipments.map((s) => (
          <p key={s.id}><span className="text-graphite">Трек-номер: </span>{s.tracking_number ? <span className="num select-all">{s.tracking_number}</span> : 'будет добавлен'}</p>
        ))}
      </section>

      <section className="px-4 pt-6">
        <h2 className="mb-3 font-display text-md">История</h2>
        <StatusTimeline history={history} />
      </section>

      <div className="flex flex-col gap-2 px-4 pt-8">
        {supportLink ? <Button variant="secondary" block onClick={() => openTelegramLink(supportLink)}>Написать менеджеру</Button> : null}
        {canCancel ? <Button variant="danger" block onClick={() => setCancelOpen(true)}>Отменить заявку</Button> : null}
        <p className="pt-2 text-sm text-graphite">Вопрос по заказу или возврату? Напишите менеджеру и укажите номер {order.number}.</p>
      </div>

      <Sheet open={cancelOpen} onClose={() => setCancelOpen(false)} title="Отменить заявку?"
        footer={<Button block variant="danger" loading={busy === 'cancel'}
          onClick={() => run('cancel', () => orderAction(order.id, 'customer_cancel', { reason }), 'Заявка отменена').then(() => setCancelOpen(false))}>Отменить заявку</Button>}>
        <p className="text-sm text-graphite">Деньги не списывались. Можно указать причину — это поможет нам стать лучше.</p>
        <Textarea className="mt-3" placeholder="Причина (необязательно)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Sheet>
    </div>
  );
}
