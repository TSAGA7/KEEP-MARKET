import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminOrderDetail, orderAction, rpc, refund, errText } from '../api';
import { AdminPage, KV, Section, Table, Td } from '../ui';
import { ApiError } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { openTelegramLink } from '@/lib/telegram';
import type { Order, OrderHistory, OrderItem, Payment, Shipment } from '@/lib/types';
import { OrderItemsList, OrderStatusBadge, PaymentBadge, StatusTimeline, formatDateTime } from '@/components/order';
import { Button, Checkbox, ErrorState, Field, Input, Notice, Price, Select, Sheet, Skeleton, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { availableStaffActions, humanizeError, PAYMENT_METHOD_LABEL, ORDER_STATUS_LABEL_STAFF, ITEM_AVAILABILITY_LABEL, type ItemAvailability, type OrderStatus, type StaffAction } from '@shared/orders';
import { SHIPPING_PROVIDERS, formatAddress } from '@shared/delivery';
import { parseRublesToKopecks, kopecksToRublesInput } from '@shared/money';
import { maskPhone } from '@shared/log';

const ACTION_LABEL: Partial<Record<StaffAction, string>> = {
  start_check: 'Начать проверку наличия',
  record_availability: 'В наличии → ожидает оплату',
  set_payment_method: 'Способ оплаты',
  await_shipment: 'Оплачено → ожидает отправку',
  ship: 'Отправить',
  set_tracking: 'Изменить трек-номер',
  deliver: 'Отметить доставку',
  cancel: 'Отменить заявку',
  issue: 'Отметить проблему',
  resolve_issue: 'Решить проблему',
  add_note: 'Внутренняя заметка',
};

type Contact = { recipient_name: string; phone: string; email: string | null; address: Record<string, unknown>; purged: boolean };

export default function OrderPage() {
  const { id = '' } = useParams();
  const s = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'order', id], queryFn: () => adminOrderDetail(id) });
  const [dialog, setDialog] = useState<StaffAction | 'refund' | 'offline' | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [busy, setBusy] = useState(false);

  if (q.isLoading) return <AdminPage title="Заявка" back="/admin/orders"><Skeleton className="h-60" /></AdminPage>;
  if (q.isError || !q.data) return <AdminPage title="Заявка" back="/admin/orders"><ErrorState text="Заявка не найдена или нет доступа." onRetry={() => void q.refetch()} /></AdminPage>;

  const order = q.data.order as unknown as Order;
  const items = q.data.items as OrderItem[];
  const history = q.data.history as OrderHistory[];
  const shipments = q.data.shipments as Shipment[];
  const payments = q.data.payments as Payment[];
  const costs = new Map((q.data.costs as Array<{ order_item_id: string; purchase_price_kopecks: number }>).map((c) => [c.order_item_id, Number(c.purchase_price_kopecks)]));
  const customer = q.data.customer as { telegram_id: number; username: string | null; first_name: string | null; bot_chat_id: number | null } | null;
  const actions = availableStaffActions(order.status).filter((a) => a !== 'assign_to_me');

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['admin', 'order', id] });
    await qc.invalidateQueries({ queryKey: ['admin', 'orders'] });
    await qc.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  };

  const act = async (action: StaffAction, payload: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const r = await orderAction(order.id, action, payload);
      toast(`Готово: ${ORDER_STATUS_LABEL_STAFF[r.status as OrderStatus] ?? r.status}${r.customer_notified ? ', покупатель уведомлён' : ''}`, 'success');
      setDialog(null);
      await refresh();
    } catch (e) {
      toast(humanizeError(e instanceof ApiError ? e.code : errText(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const showContact = async () => {
    try {
      setContact(await rpc<Contact>('staff_get_order_contact', { p_order_id: order.id }));
    } catch (e) {
      toast(humanizeError(errText(e)), 'error');
    }
  };

  const costTotal = items.reduce((a, it) => (it.availability === 'unavailable' ? a : a + (costs.get(it.id) ?? 0) * it.quantity), 0);
  const hasCosts = costs.size > 0;

  return (
    <AdminPage title={<span className="num">{order.number}</span>} back="/admin/orders"
      actions={<><OrderStatusBadge status={order.status} staff /><PaymentBadge status={order.payment_status} /></>}>
      <div className="grid gap-8 xl:grid-cols-[1fr_380px]">
        <div>
          {order.status === 'issue' && order.issue_reason ? <Notice tone="bad" className="mb-4">Проблема: {order.issue_reason}</Notice> : null}
          {order.status === 'cancelled' ? <Notice className="mb-4">Отменена: {order.cancel_reason}</Notice> : null}

          <Section title="Действия">
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => {
                const instant = a === 'start_check' || a === 'deliver' || a === 'await_shipment';
                return (
                  <Button key={a} size="sm" variant={a === 'cancel' ? 'danger' : a === actions[0] ? 'primary' : 'secondary'} loading={busy && instant}
                    onClick={() => (instant ? act(a) : setDialog(a))}>{ACTION_LABEL[a] ?? a}</Button>
                );
              })}
            </div>
            {order.status === 'awaiting_payment' ? (
              <p className="mt-2 text-sm text-graphite">Когда деньги придут, нажмите «Оплачено → ожидает отправку» или зафиксируйте оплату в разделе «Платежи» — статус сменится сам.</p>
            ) : null}
          </Section>

          <Section title="Состав заявки">
            <OrderItemsList items={items} />
            {hasCosts ? (
              <p className="mt-2 text-sm text-graphite">Закупка по снимку на момент заявки: <Price kopecks={costTotal} />, разница с ценой товаров: <Price kopecks={order.items_total_kopecks - order.discount_kopecks - costTotal} /></p>
            ) : null}
            <dl className="mt-3 max-w-sm">
              <KV k="Товары"><Price kopecks={order.items_total_kopecks} /></KV>
              {order.discount_kopecks ? <KV k="Скидка">−<Price kopecks={order.discount_kopecks} /></KV> : null}
              <KV k="Доставка">{order.delivery_kopecks === null ? 'не согласована' : <Price kopecks={order.delivery_kopecks} />}</KV>
              <KV k="Итого"><b><Price kopecks={order.total_kopecks} /></b></KV>
            </dl>
            {s.isAdmin ? <LogisticsCost order={order} current={q.data.logisticsCost} busy={busy} act={act} costTotal={hasCosts ? costTotal : null} /> : null}
          </Section>

          {['awaiting_payment', 'awaiting_shipment'].includes(order.status) ? (
            <SupplierHandoff order={order} items={items} />
          ) : null}

          <Section title="Платежи">
            {payments.length === 0 ? <p className="text-sm text-graphite">Платежей не было.</p> : (
              <Table head={['Провайдер', 'Статус', 'Сумма', 'Возвращено', 'Создан', '']}>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <Td>{p.provider}{p.is_test ? ' (тест)' : ''}</Td><Td>{p.status}</Td><Td><Price kopecks={p.amount_kopecks} /></Td>
                    <Td><Price kopecks={p.refunded_kopecks} /></Td><Td>{formatDateTime(p.created_at)}</Td>
                    <Td>{s.isAdmin && ['succeeded', 'partially_refunded'].includes(p.status) ? <Button size="sm" variant="secondary" onClick={() => setDialog('refund')}>Возврат</Button> : null}</Td>
                  </tr>
                ))}
              </Table>
            )}
            {s.isAdmin && order.payment_method && order.payment_method !== 'online' && order.payment_status !== 'paid' && !['new', 'cancelled'].includes(order.status) ? (
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => setDialog('offline')}>Зафиксировать полученную оплату</Button>
            ) : null}
          </Section>

          <Section title="История">
            <StatusTimeline history={history} staff />
          </Section>
        </div>

        <aside className="space-y-6">
          <div className="border border-line p-4">
            <h2 className="mb-2 font-medium">Покупатель и доставка</h2>
            <dl>
              <KV k="Telegram">{customer?.username ? `@${customer.username}` : customer?.first_name ?? '—'}</KV>
              <KV k="Бот подключён">{customer?.bot_chat_id ? 'да, уведомления доставляются' : 'нет'}</KV>
              <KV k="Доставка">{SHIPPING_PROVIDERS[order.delivery_method]?.title}</KV>
              <KV k="Оплата">{order.payment_method ? PAYMENT_METHOD_LABEL[order.payment_method] : 'не согласована'}</KV>
              {order.agreed_terms?.eta_text ? <KV k="Срок">{order.agreed_terms.eta_text}</KV> : null}
              {order.customer_comment ? <KV k="Комментарий">{order.customer_comment}</KV> : null}
              {order.manager_notes ? <KV k="Заметки">{order.manager_notes}</KV> : null}
            </dl>
            {contact ? (
              <div className="mt-3 bg-concrete p-3 text-sm">
                {contact.purged ? <p>Контактные данные обезличены по сроку хранения.</p> : (
                  <>
                    <p className="font-medium">{contact.recipient_name}</p>
                    <p className="num select-all">{contact.phone}</p>
                    {contact.email ? <p className="select-all">{contact.email}</p> : null}
                    <p className="mt-1">{formatAddress(order.delivery_method, contact.address)}</p>
                    {typeof contact.address.instructions === 'string' ? <p className="text-graphite">{contact.address.instructions}</p> : null}
                    {typeof contact.address.courier_comment === 'string' ? <p className="text-graphite">{contact.address.courier_comment}</p> : null}
                  </>
                )}
                <p className="mt-2 text-xs text-graphite">Просмотр записан в журнал действий.</p>
              </div>
            ) : (
              <Button size="sm" variant="secondary" className="mt-3" onClick={showContact}>Показать контакты получателя</Button>
            )}
            {customer?.username ? (
              <Button size="sm" variant="ghost" className="mt-2 px-0" onClick={() => openTelegramLink(`https://t.me/${customer.username}`)}>Написать в Telegram</Button>
            ) : null}
            {contact && !contact.purged ? <p className="mt-1 text-xs text-fog">Для общих чатов используйте маску: {maskPhone(contact.phone)}</p> : null}
          </div>
          {shipments.length ? (
            <div className="border border-line p-4">
              <h2 className="mb-2 font-medium">Отправления</h2>
              {shipments.map((sh) => (
                <dl key={sh.id}><KV k="Перевозчик">{sh.carrier}</KV><KV k="Трек-номер">{sh.tracking_number ?? '—'}</KV><KV k="Статус">{sh.status}</KV></dl>
              ))}
            </div>
          ) : null}
        </aside>
      </div>

      <ActionDialogs dialog={dialog} close={() => setDialog(null)} busy={busy} act={act} order={order} items={items} payments={payments}
        onRefunded={refresh} isAdmin={s.isAdmin} />
    </AdminPage>
  );
}

/** Текст для сборки/отправки: только то, что нужно для сборки и отправки (без истории покупок и прочих данных клиента) */
function SupplierHandoff({ order, items }: { order: Order; items: OrderItem[] }) {
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const build = async () => {
    try {
      const c = await rpc<Contact>('staff_get_order_contact', { p_order_id: order.id });
      const lines = items.filter((i) => i.availability !== 'unavailable')
        .map((i) => `• ${i.title_snapshot}, арт. ${i.variant_sku_snapshot}${i.size ? `, размер ${i.size}` : ''}${i.color ? `, ${i.color}` : ''} — ${i.quantity} шт.`);
      setText([
        `Заказ ${order.number}`, ...lines, '',
        `Доставка: ${SHIPPING_PROVIDERS[order.delivery_method]?.title}`,
        `Получатель: ${c.recipient_name}, ${c.phone}`,
        `Адрес: ${formatAddress(order.delivery_method, c.address)}`,
      ].join('\n'));
    } catch (e) {
      toast(humanizeError(errText(e)), 'error');
    }
  };
  const copy = async () => {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast('Скопировано', 'success'); } catch { toast('Скопируйте текст вручную', 'info'); }
  };
  return (
    <Section title="Текст для сборки и отправки">
      <p className="mb-3 text-sm text-graphite">Только состав заказа и данные для отправки — без истории покупок. Покупатель этот блок не видит.</p>
      {text ? (
        <>
          <Textarea readOnly value={text} rows={8} className="font-sans" />
          <Button size="sm" className="mt-2" onClick={copy}>Скопировать</Button>
        </>
      ) : <Button size="sm" variant="secondary" onClick={build}>Сформировать текст</Button>}
    </Section>
  );
}

function ActionDialogs({ dialog, close, busy, act, order, items, payments, onRefunded, isAdmin }: {
  dialog: StaffAction | 'refund' | 'offline' | null; close: () => void; busy: boolean; act: (a: StaffAction, p?: Record<string, unknown>) => Promise<void>;
  order: Order; items: OrderItem[]; payments: Payment[]; onRefunded: () => Promise<void>; isAdmin: boolean;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [avail, setAvail] = useState<Record<string, { availability: ItemAvailability; note: string; price: string; priceReason: string }>>({});
  const [delivery, setDelivery] = useState('');
  const [eta, setEta] = useState('');
  const [shipCost, setShipCost] = useState('');
  const [method, setMethod] = useState('manual_transfer');
  const [carrier, setCarrier] = useState('cdek');
  const [tracking, setTracking] = useState('');
  const [target, setTarget] = useState('checking_availability');
  const [amount, setAmount] = useState('');
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);

  const itemState = (it: OrderItem) => avail[it.id] ?? { availability: it.availability === 'unknown' ? 'confirmed' : it.availability, note: it.availability_note ?? '', price: '', priceReason: '' };
  const setItem = (it: OrderItem, patch: Partial<ReturnType<typeof itemState>>) => setAvail((a) => ({ ...a, [it.id]: { ...itemState(it), ...patch } }));

  const paidPayment = payments.find((p) => ['succeeded', 'partially_refunded'].includes(p.status));

  const footer = (label: string, onClick: () => void, danger?: boolean) => (
    <Button block variant={danger ? 'danger' : 'primary'} loading={busy || localBusy} onClick={onClick}>{label}</Button>
  );

  switch (dialog) {
    case 'record_availability': {
      const payload = () => {
        const out = items.map((it) => {
          const st = itemState(it);
          const p = st.price ? parseRublesToKopecks(st.price) : null;
          return { item_id: it.id, availability: st.availability, note: st.note || undefined,
            ...(p !== null && p !== it.original_unit_price_kopecks ? { new_unit_price_kopecks: p, price_change_reason: st.priceReason } : {}) };
        });
        const d = delivery ? parseRublesToKopecks(delivery) : null;
        return { items: out, ...(d !== null ? { delivery_kopecks: d } : {}), eta_text: eta || undefined };
      };
      return (
        <Sheet open onClose={close} title="Результат проверки наличия" footer={footer('Товар в наличии → ожидает оплату', () => act('record_availability', payload()))}>
          <div className="space-y-5">
            {items.map((it) => {
              const st = itemState(it);
              return (
                <div key={it.id} className="space-y-2 border-b border-line pb-4">
                  <p className="text-sm font-medium">{it.title_snapshot} <span className="font-normal text-graphite">({[it.color, it.size, `${it.quantity} шт.`].filter(Boolean).join(', ')})</span></p>
                  <Select value={st.availability} onChange={(e) => setItem(it, { availability: e.target.value as ItemAvailability })} aria-label="Наличие">
                    {(['confirmed', 'unavailable', 'replacement_offered', 'waiting'] as const).map((a) => <option key={a} value={a}>{ITEM_AVAILABILITY_LABEL[a]}</option>)}
                  </Select>
                  <Input placeholder="Комментарий (замена, срок ожидания)" value={st.note} onChange={(e) => setItem(it, { note: e.target.value })} />
                  <div className="grid grid-cols-2 gap-2">
                    <Input inputMode="decimal" placeholder={`Новая цена, сейчас ${kopecksToRublesInput(it.unit_price_kopecks)}`} value={st.price} onChange={(e) => setItem(it, { price: e.target.value })} aria-label="Новая цена за единицу, ₽" />
                    <Input placeholder="Причина изменения цены" value={st.priceReason} onChange={(e) => setItem(it, { priceReason: e.target.value })} disabled={!st.price} />
                  </div>
                </div>
              );
            })}
            <Field label="Стоимость доставки для покупателя, ₽" optional hint="Прибавится к сумме заказа">
              {(fid) => <Input id={fid} inputMode="decimal" value={delivery} onChange={(e) => setDelivery(e.target.value)} />}
            </Field>
            <Field label="Срок доставки" optional>{(fid) => <Input id={fid} placeholder="Например, 3–5 рабочих дней" value={eta} onChange={(e) => setEta(e.target.value)} />}</Field>
            <p className="text-sm text-graphite">Если позиции нет, а другие есть — заказ пересчитается без неё. Если нет ничего — отмените заявку.</p>
          </div>
        </Sheet>
      );
    }
    case 'set_payment_method':
      return (
        <Sheet open onClose={close} title="Способ оплаты" footer={footer('Сохранить', () => act('set_payment_method', { payment_method: method }))}>
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {Object.entries(PAYMENT_METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <p className="mt-2 text-sm text-graphite">Онлайн-оплата доступна, только если она включена в настройках после подключения провайдера.</p>
        </Sheet>
      );
    case 'ship':
    case 'set_tracking':
      return (
        <Sheet open onClose={close} title={dialog === 'ship' ? 'Отправка' : 'Трек-номер'}
          footer={footer('Сохранить', () => {
            if (dialog !== 'ship') { void act(dialog, { tracking_number: tracking }); return; }
            const cost = shipCost.trim() ? parseRublesToKopecks(shipCost) : null;
            if (shipCost.trim() && cost === null) { toast('Некорректная сумма расходов', 'error'); return; }
            void act('ship', { carrier, ...(tracking ? { tracking_number: tracking } : {}), ...(cost !== null ? { cost_kopecks: cost } : {}) });
          })}>
          <div className="space-y-3">
            {dialog === 'ship' ? (
              <Select value={carrier} onChange={(e) => setCarrier(e.target.value)} aria-label="Перевозчик">
                <option value="cdek">СДЭК</option><option value="ozon">Ozon</option><option value="russian_post">Почта России</option>
                <option value="yandex">Яндекс Доставка</option><option value="keep_courier">Курьер KEEP MARKET</option><option value="other">Другое</option>
              </Select>
            ) : null}
            <Input placeholder={dialog === 'ship' ? 'Трек-номер — необязательно' : 'Трек-номер (латиница, цифры, дефис)'} value={tracking} onChange={(e) => setTracking(e.target.value.trim())} />
            {dialog === 'ship' && isAdmin ? (
              <Field label="Наши расходы на доставку (курьер), ₽" optional hint="Покупатель не видит. Учитывается в панели управления">
                {(fid) => <Input id={fid} inputMode="decimal" placeholder="Например, 300" value={shipCost} onChange={(e) => setShipCost(e.target.value)} />}
              </Field>
            ) : null}
            <p className="text-sm text-graphite">Покупатель получит уведомление в боте, если он его подключил.</p>
          </div>
        </Sheet>
      );
    case 'cancel':
    case 'issue':
    case 'add_note':
      return (
        <Sheet open onClose={close} title={dialog === 'cancel' ? 'Отмена заявки' : dialog === 'issue' ? 'Проблема с заказом' : 'Внутренняя заметка'}
          footer={footer(dialog === 'cancel' ? 'Отменить заявку' : 'Сохранить', () => act(dialog, { reason }), dialog === 'cancel')}>
          <Textarea placeholder={dialog === 'cancel' ? 'Причина отмены — её увидит покупатель' : dialog === 'issue' ? 'Что случилось' : 'Текст заметки (покупатель не увидит)'}
            value={reason} onChange={(e) => setReason(e.target.value)} />
        </Sheet>
      );
    case 'resolve_issue':
      return (
        <Sheet open onClose={close} title="Решение проблемы" footer={footer('Вернуть в работу', () => act('resolve_issue', { target_status: target, reason }))}>
          <div className="space-y-3">
            <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Вернуть в статус">
              {(['checking_availability', 'awaiting_payment', 'awaiting_shipment', 'shipped', 'delivered'] as const).map((st) =>
                <option key={st} value={st}>{ORDER_STATUS_LABEL_STAFF[st]}</option>)}
            </Select>
            <Textarea placeholder="Как решили" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </Sheet>
      );
    case 'refund':
      if (!paidPayment || !isAdmin) return null;
      return (
        <Sheet open onClose={close} title="Возврат"
          footer={footer('Оформить возврат', async () => {
            const k = parseRublesToKopecks(amount);
            if (!k) { toast('Укажите сумму', 'error'); return; }
            setLocalBusy(true);
            try {
              const r = await refund(paidPayment.id, k, reason, paidPayment.provider === 'manual' ? manualConfirmed : undefined);
              toast(r.status === 'succeeded' ? 'Возврат проведён' : 'Возврат отправлен провайдеру, ждём подтверждения', 'success');
              close();
              await onRefunded();
            } catch (e) {
              toast(humanizeError(e instanceof ApiError ? e.code : errText(e)), 'error');
            } finally { setLocalBusy(false); }
          }, true)}>
          <div className="space-y-3">
            <p className="text-sm">Доступно к возврату: <Price kopecks={paidPayment.amount_kopecks - paidPayment.refunded_kopecks} /></p>
            <Input inputMode="decimal" placeholder="Сумма, ₽" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <Textarea placeholder="Причина возврата" value={reason} onChange={(e) => setReason(e.target.value)} />
            {paidPayment.provider === 'manual' ? (
              <Checkbox checked={manualConfirmed} onChange={setManualConfirmed}>Деньги уже возвращены покупателю вне системы (переводом) — фиксирую факт возврата</Checkbox>
            ) : null}
          </div>
        </Sheet>
      );
    case 'offline':
      return (
        <Sheet open onClose={close} title="Полученная оплата"
          footer={footer('Зафиксировать', async () => {
            const k = parseRublesToKopecks(amount);
            if (!k) { toast('Укажите сумму', 'error'); return; }
            setLocalBusy(true);
            try {
              await rpc('staff_register_offline_payment', { p_order_id: order.id, p_amount_kopecks: k, p_note: reason });
              toast('Оплата зафиксирована', 'success');
              close();
              await onRefunded();
            } catch (e) { toast(humanizeError(errText(e)), 'error'); } finally { setLocalBusy(false); }
          })}>
          <div className="space-y-3">
            <Notice>Фиксируйте только фактически поступившие деньги (перевод на счёт, оплата курьеру). Запись попадёт в журнал.</Notice>
            <Input inputMode="decimal" placeholder={`Сумма, ₽ (к оплате ${kopecksToRublesInput(order.total_kopecks)})`} value={amount} onChange={(e) => setAmount(e.target.value)} />
            <Textarea placeholder="Основание: номер платёжки, дата" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </Sheet>
      );
    default:
      return null;
  }
}

/** Расходы магазина на доставку (курьер и т.п.) — необязательное поле, только для владельца/админа */
function LogisticsCost({ order, current, busy, act, costTotal }: { order: Order; current: number | null; busy: boolean; act: (a: StaffAction, p?: Record<string, unknown>) => Promise<void>; costTotal: number | null }) {
  const toast = useToast();
  const [val, setVal] = useState(kopecksToRublesInput(current));
  const save = () => {
    const raw = val.trim();
    const k = raw ? parseRublesToKopecks(raw) : null;
    if (raw && k === null) { toast('Некорректная сумма', 'error'); return; }
    if (k === current) return;
    void act('set_logistics_cost', { cost_kopecks: k });
  };
  const margin = costTotal !== null ? order.items_total_kopecks - order.discount_kopecks - costTotal - (current ?? 0) : null;
  return (
    <div className="mt-4 max-w-sm border-t border-line pt-3">
      <Field label="Расходы на доставку (курьер), ₽" optional hint="Покупатель не видит. Вычитается из разницы с закупкой">
        {(fid) => (
          <div className="flex gap-2">
            <Input id={fid} inputMode="decimal" placeholder="Например, 250" value={val} onChange={(e) => setVal(e.target.value)} />
            <Button size="sm" variant="secondary" loading={busy} onClick={save}>Сохранить</Button>
          </div>
        )}
      </Field>
      {margin !== null ? <p className="mt-2 text-sm text-graphite">Итог по заказу после закупки и доставки: <Price kopecks={margin} /></p> : null}
    </div>
  );
}
