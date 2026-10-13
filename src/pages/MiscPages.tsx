import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getPublicSettings, productsByIds } from '@/lib/api';
import { callFunction, ApiError } from '@/lib/supabase';
import { config } from '@/lib/config';
import { useFavorites } from '@/lib/favorites';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/layout';
import { ProductGrid } from '@/components/product';
import { Button, EmptyState, ErrorState, Notice, Price, Skeleton } from '@/components/ui';
import { TelegramRequired } from './ProfilePage';

export function FavoritesPage() {
  const fav = useFavorites();
  const s = useSession();
  const products = useQuery({ queryKey: ['fav-products', fav.ids], queryFn: () => productsByIds(fav.ids), enabled: fav.ids.length > 0 });
  if (!fav.enabled && s.status !== 'loading') return <><PageHeader title="Избранное" /><TelegramRequired /></>;
  const ordered = fav.ids.map((id) => products.data?.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  return (
    <div>
      <PageHeader title="Избранное" />
      {fav.isError || products.isError ? <ErrorState onRetry={() => { void fav.refetch(); void products.refetch(); }} /> : null}
      {fav.isLoading || products.isLoading ? <ProductGrid items={[]} loading /> : null}
      {!fav.isLoading && fav.ids.length === 0 ? (
        <EmptyState title="Здесь пока пусто" text="Отмечайте понравившиеся вещи сердцем на карточке товара." action={<Link to="/catalog"><Button>Перейти в каталог</Button></Link>} />
      ) : null}
      {ordered.length ? <ProductGrid items={ordered} /> : null}
      {fav.ids.length > 0 && products.data && ordered.length < fav.ids.length ? (
        <p className="px-4 pt-4 text-sm text-graphite">Некоторые товары сняты с продажи и скрыты.</p>
      ) : null}
    </div>
  );
}

const LEGAL: Record<string, { title: string; key: string }> = {
  offer: { title: 'Публичная оферта', key: 'offer_text' },
  privacy: { title: 'Обработка персональных данных', key: 'privacy_policy_text' },
  returns: { title: 'Доставка и возврат', key: 'return_policy' },
  seller: { title: 'О продавце', key: 'seller_info' },
};

export function LegalPage() {
  const { doc = '' } = useParams();
  const meta = LEGAL[doc];
  const q = useQuery({ queryKey: ['settings'], queryFn: getPublicSettings });
  if (!meta) return <EmptyState title="Документ не найден" />;
  const raw = q.data?.[meta.key];
  let body: string | null = null;
  if (doc === 'seller' && raw && typeof raw === 'object') {
    const s = raw as Record<string, string | null>;
    const rows = [['Наименование', s.legal_name], ['ИНН', s.inn], ['ОГРН/ОГРНИП', s.ogrn], ['Адрес', s.address], ['E-mail', s.email], ['Телефон', s.phone]]
      .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    body = rows.length ? rows.join('\n') : null;
  } else if (doc === 'returns') {
    body = [q.data?.delivery_info, q.data?.return_policy].filter((x) => typeof x === 'string').join('\n\n') || null;
  } else if (typeof raw === 'string') body = raw;
  return (
    <div>
      <PageHeader title={meta.title} />
      {q.isLoading ? <div className="px-4"><Skeleton className="h-40" /></div> : body ? (
        // Текст выводится как обычный текст (без HTML) — защита от XSS
        <div className="whitespace-pre-line px-4 text-graphite">{body}</div>
      ) : (
        <Notice className="mx-4">Документ готовится. Если у вас вопрос по этой теме — напишите менеджеру.</Notice>
      )}
    </div>
  );
}

export function NotFoundPage() {
  return <EmptyState title="Страница не найдена" text="Ссылка устарела или содержит ошибку." action={<Link to="/" className="underline underline-offset-4">На главную</Link>} />;
}

/** ТОЛЬКО для разработки: эмуляция страницы оплаты mock-провайдера. Подтверждение идёт через подписанное уведомление на сервере. */
export function MockPaymentPage() {
  const [sp] = useSearchParams();
  const s = useSession();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const paymentId = sp.get('payment') ?? '';
  const amount = Number(sp.get('amount') ?? 0);
  useEffect(() => { document.title = 'Тестовая оплата'; }, []);
  if (!config.enableMockPayment) return <NotFoundPage />;
  const send = async (outcome: 'succeeded' | 'failed' | 'cancelled') => {
    setState('busy');
    try {
      const r = await callFunction<{ result: string }>('payment-mock-simulate', { provider_payment_id: paymentId, outcome });
      setMsg(`Уведомление обработано сервером: ${r.result}`);
      setState('done');
    } catch (e) {
      setMsg(e instanceof ApiError ? e.code : 'Ошибка');
      setState('error');
    }
  };
  return (
    <div className="px-4 pt-6">
      <Notice tone="warn"><b>Тестовый режим.</b> Это не настоящая оплата: деньги не списываются. Страница доступна только в development.</Notice>
      <h1 className="mt-5 font-display text-xl">Заказ {sp.get('order')}</h1>
      <p className="mt-1 text-lg"><Price kopecks={amount} /></p>
      {s.status !== 'authenticated' ? <TelegramRequired /> : (
        <div className="mt-6 flex flex-col gap-2">
          <Button loading={state === 'busy'} onClick={() => send('succeeded')}>Сымитировать успешную оплату</Button>
          <Button variant="secondary" disabled={state === 'busy'} onClick={() => send('failed')}>Сымитировать отказ</Button>
          <Button variant="ghost" disabled={state === 'busy'} onClick={() => send('cancelled')}>Сымитировать отмену</Button>
        </div>
      )}
      {msg ? <p className="mt-4 text-sm">{msg}</p> : null}
    </div>
  );
}
