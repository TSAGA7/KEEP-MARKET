import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import clsx from 'clsx';
import { createOrder, getPublicSettings } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { useSession } from '@/lib/session';
import { ApiError } from '@/lib/supabase';
import { haptic } from '@/lib/telegram';
import { addressSchemaFor, enabledProviders, DELIVERY_INTERVALS, type DeliveryMethod } from '@shared/delivery';
import { applyServerProblems, cartTotals, contactSchema } from '@shared/checkout';
import { humanizeError } from '@shared/orders';
import { PageHeader } from '@/components/layout';
import { ProductImage } from '@/components/product';
import { Button, EmptyState, Field, Input, Notice, Price, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';

const WARNING = 'После оформления менеджер подтвердит заказ и свяжется с вами, чтобы согласовать доставку и оплату. На этом этапе оплата не производится.';

type FormValues = {
  contact: { recipient_name: string; phone: string; email: string };
  address: Record<string, string>;
  comment: string;
  promo_code: string;
};

function newKey() {
  const raw = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9]/g, '');
  return `ord_${raw}`.slice(0, 60);
}

export default function CheckoutPage() {
  const cart = useCart();
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['settings'], queryFn: getPublicSettings });
  const providers = enabledProviders(settings.data?.delivery_methods as Partial<Record<DeliveryMethod, boolean>> | undefined);
  const [method, setMethod] = useState<DeliveryMethod | null>(null);
  const [serverChanges, setServerChanges] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const idemKey = useRef(newKey());
  const lines = cart.lines.filter((l) => l.stockState !== 'out_of_stock');
  const totals = cartTotals(lines);
  const provider = providers.find((p) => p.method === method) ?? null;

  const schema = useMemo(() => z.object({
    contact: contactSchema,
    address: method ? addressSchemaFor(method) : z.record(z.string()),
    comment: z.string().max(1000).optional().or(z.literal('')),
    promo_code: z.string().max(32).optional().or(z.literal('')),
  }), [method]);

  const { register, handleSubmit, formState: { errors }, reset, getValues } = useForm<FormValues>({
    resolver: zodResolver(schema) as unknown as Resolver<FormValues>,
    defaultValues: { contact: { recipient_name: '', phone: '', email: '' }, address: {}, comment: '', promo_code: '' },
  });

  // Предзаполняем имя из Telegram (пользователь может изменить)
  useEffect(() => {
    if (session.profile && !getValues('contact.recipient_name')) {
      const name = [session.profile.first_name, session.profile.last_name].filter(Boolean).join(' ');
      reset({ ...getValues(), contact: { ...getValues('contact'), recipient_name: name } });
    }
  }, [session.profile, getValues, reset]);

  useEffect(() => {
    if (method) reset({ ...getValues(), address: method.includes('pickup') ? { pickup_mode: 'manual' } : {} });
  }, [method, reset, getValues]);

  if (session.status !== 'authenticated') {
    return <EmptyState title="Нужен вход через Telegram" text="Оформить заказ можно только в приложении KEEP MARKET внутри Telegram." action={<Link to="/cart" className="underline underline-offset-4">Вернуться в корзину</Link>} />;
  }
  if (!lines.length) {
    return <EmptyState title="Нечего оформлять" text="В корзине нет доступных товаров." action={<Link to="/catalog" className="underline underline-offset-4">Перейти в каталог</Link>} />;
  }

  const addrErr = (k: string) => (errors.address as Record<string, { message?: string }> | undefined)?.[k]?.message;

  const onSubmit = handleSubmit(async (values) => {
    if (!method) return;
    setSubmitting(true);
    setServerChanges([]);
    try {
      const address = Object.fromEntries(Object.entries(values.address).filter(([, v]) => typeof v === 'string' && v.trim() !== ''));
      const res = await createOrder({
        idempotency_key: idemKey.current,
        items: lines.map((l) => ({ variant_id: l.variantId, quantity: l.quantity, expected_unit_price_kopecks: l.unitPriceKopecks })),
        delivery_method: method,
        contact: values.contact,
        address,
        comment: values.comment,
        promo_code: values.promo_code,
        consent_pd: true,
      });
      if (!res.ok) {
        const applied = applyServerProblems(cart.lines, res);
        cart.replace(applied.lines);
        setServerChanges(applied.changes.length ? applied.changes : ['Данные корзины изменились. Проверьте и подтвердите заказ ещё раз.']);
        haptic('error');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      cart.clear();
      haptic('success');
      navigate(`/checkout/done/${res.order_id}`, { replace: true, state: { number: res.number, botLink: res.bot_link, managerLink: res.manager_link } });
    } catch (e) {
      toast(humanizeError(e instanceof ApiError ? e.code : null), 'error');
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <PageHeader title="Оформление" />

      {serverChanges.length ? (
        <Notice tone="warn" className="mx-4 mb-4">
          <p className="font-medium">Мы пересчитали заявку по актуальным данным</p>
          <ul className="mt-1 list-disc pl-5">{serverChanges.map((c) => <li key={c}>{c}</li>)}</ul>
          <p className="mt-2">Проверьте состав и сумму ниже и нажмите «Заказать» ещё раз.</p>
        </Notice>
      ) : null}

      <section className="px-4 pt-2" aria-labelledby="h-delivery">
        <h2 id="h-delivery" className="font-display text-md">Доставка</h2>
        <div className="mt-3 flex flex-col gap-2" role="radiogroup" aria-label="Способ доставки">
          {providers.map((p) => (
            <label key={p.method} className={clsx('flex cursor-pointer gap-3 p-3.5 ring-1 ring-inset', method === p.method ? 'bg-concrete ring-ink' : 'ring-line')}>
              <input type="radio" name="delivery" className="mt-1 h-4 w-4 accent-current" checked={method === p.method} onChange={() => setMethod(p.method)} />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{p.title}</span>
                <span className="text-sm text-graphite">{p.description}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-sm text-graphite">Выбор способа — ваше пожелание. Доступность и стоимость для этого заказа подтвердит менеджер.</p>
      </section>

      {method ? (
        <>
          <section className="space-y-4 px-4 pt-8" aria-labelledby="h-recipient">
            <h2 id="h-recipient" className="font-display text-md">Получатель</h2>
            <Field label="ФИО получателя" error={errors.contact?.recipient_name?.message}>
              {(id) => <Input id={id} autoComplete="name" aria-invalid={!!errors.contact?.recipient_name} {...register('contact.recipient_name')} />}
            </Field>
            <Field label="Телефон" error={errors.contact?.phone?.message}>
              {(id) => <Input id={id} type="tel" inputMode="tel" autoComplete="tel" placeholder="+7 900 000-00-00" aria-invalid={!!errors.contact?.phone} {...register('contact.phone')} />}
            </Field>
            <Field label="E-mail" optional hint="Для электронного чека, если понадобится" error={errors.contact?.email?.message}>
              {(id) => <Input id={id} type="email" inputMode="email" autoComplete="email" aria-invalid={!!errors.contact?.email} {...register('contact.email')} />}
            </Field>
          </section>

          <section className="space-y-4 px-4 pt-8" aria-labelledby="h-address">
            <h2 id="h-address" className="font-display text-md">{provider?.kind === 'pickup' ? 'Пункт выдачи' : 'Адрес'}</h2>
            {provider?.kind === 'pickup' ? (
              <>
                <Notice>Справочник пунктов выдачи пока не подключён. Укажите адрес удобного пункта — менеджер проверит его и подтвердит.</Notice>
                <input type="hidden" value="manual" {...register('address.pickup_mode')} />
                <Field label="Город" error={addrErr('city')}>{(id) => <Input id={id} autoComplete="address-level2" {...register('address.city')} aria-invalid={!!addrErr('city')} />}</Field>
                <Field label="Адрес пункта выдачи" error={addrErr('pickup_point_address')}>{(id) => <Input id={id} placeholder="Улица, дом" {...register('address.pickup_point_address')} aria-invalid={!!addrErr('pickup_point_address')} />}</Field>
                <Field label="Название или код пункта" optional>{(id) => <Input id={id} {...register('address.pickup_point_name')} />}</Field>
              </>
            ) : provider?.kind === 'moscow_courier' ? (
              <>
                <Field label="Полный адрес в Москве" error={addrErr('full_address')}>{(id) => <Input id={id} autoComplete="street-address" placeholder="Улица, дом, корпус, квартира" {...register('address.full_address')} aria-invalid={!!addrErr('full_address')} />}</Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Подъезд" optional>{(id) => <Input id={id} {...register('address.entrance')} />}</Field>
                  <Field label="Этаж" optional>{(id) => <Input id={id} inputMode="numeric" {...register('address.floor')} />}</Field>
                  <Field label="Домофон" optional>{(id) => <Input id={id} {...register('address.intercom')} />}</Field>
                </div>
                <Field label="Удобный интервал" optional>
                  {(id) => (
                    <Select id={id} {...register('address.preferred_interval')}>
                      <option value="">Любой</option>
                      {DELIVERY_INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Комментарий курьеру" optional>{(id) => <Textarea id={id} rows={2} {...register('address.courier_comment')} />}</Field>
              </>
            ) : (
              <>
                <Field label="Город" error={addrErr('city')}>{(id) => <Input id={id} autoComplete="address-level2" {...register('address.city')} aria-invalid={!!addrErr('city')} />}</Field>
                <Field label="Улица" error={addrErr('street')}>{(id) => <Input id={id} autoComplete="address-line1" {...register('address.street')} aria-invalid={!!addrErr('street')} />}</Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Дом" error={addrErr('house')}>{(id) => <Input id={id} {...register('address.house')} aria-invalid={!!addrErr('house')} />}</Field>
                  <Field label="Корп./стр." optional>{(id) => <Input id={id} {...register('address.building')} />}</Field>
                  <Field label="Кв./офис" optional>{(id) => <Input id={id} {...register('address.apartment')} />}</Field>
                </div>
                <Field label="Индекс" optional={method !== 'russian_post'} error={addrErr('postal_code')}>
                  {(id) => <Input id={id} inputMode="numeric" autoComplete="postal-code" maxLength={6} {...register('address.postal_code')} aria-invalid={!!addrErr('postal_code')} />}
                </Field>
                <Field label="Дополнительные инструкции" optional>{(id) => <Textarea id={id} rows={2} {...register('address.instructions')} />}</Field>
              </>
            )}
            <p className="text-sm text-graphite">Паспортные данные не нужны.</p>
          </section>

          <section className="space-y-4 px-4 pt-8">
            <Field label="Комментарий к заказу" optional>{(id) => <Textarea id={id} rows={2} maxLength={1000} {...register('comment')} />}</Field>
            <Field label="Промокод" optional>{(id) => <Input id={id} autoCapitalize="characters" {...register('promo_code')} />}</Field>
          </section>
        </>
      ) : null}

      <section className="px-4 pt-8" aria-labelledby="h-review">
        <h2 id="h-review" className="font-display text-md">Состав заявки</h2>
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {lines.map((l) => (
            <li key={l.variantId} className="flex items-center gap-3 py-3">
              <ProductImage src={l.imageRef} alt="" className="aspect-[4/5] w-12 shrink-0" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate">{l.title}</p>
                <p className="text-graphite">{[l.color, l.size && `размер ${l.size}`, `${l.quantity} шт.`].filter(Boolean).join(', ')}</p>
              </div>
              <Price kopecks={l.unitPriceKopecks * l.quantity} className="text-sm" />
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-graphite">Товары</dt><dd><Price kopecks={totals.itemsTotalKopecks} /></dd></div>
          <div className="flex justify-between"><dt className="text-graphite">Доставка</dt><dd className="text-graphite">после согласования</dd></div>
        </dl>
      </section>

      <div className="space-y-4 px-4 pt-6">
        <Notice tone="warn">{WARNING}</Notice>
        <Button type="submit" block size="lg" loading={submitting} disabled={!method}>
          {method ? 'Заказать' : 'Выберите способ доставки'}
        </Button>
        <p className="text-center text-xs text-fog">
          Нажимая «Заказать», вы соглашаетесь с <Link to="/legal/privacy" className="underline underline-offset-2">политикой обработки данных</Link> и <Link to="/legal/offer" className="underline underline-offset-2">офертой</Link>.
        </p>
      </div>
    </form>
  );
}
