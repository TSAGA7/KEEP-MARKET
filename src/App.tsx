import { lazy, Suspense, useEffect, useRef } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { ShopLayout } from '@/components/layout';
import { Spinner } from '@/components/ui';
import { useSession } from '@/lib/session';
import { getStartParam } from '@/lib/telegram';
import { isConfigured } from '@/lib/config';
import { parseStartParam, startTargetPath } from '@shared/telegram';
import HomePage from '@/pages/HomePage';
import CatalogPage from '@/pages/CatalogPage';
import ProductPage from '@/pages/ProductPage';
import CartPage from '@/pages/CartPage';
import ProfilePage from '@/pages/ProfilePage';
import { FavoritesPage, LegalPage, MockPaymentPage, NotFoundPage } from '@/pages/MiscPages';

const CheckoutPage = lazy(() => import('@/pages/CheckoutPage'));
const CheckoutDonePage = lazy(() => import('@/pages/CheckoutDonePage'));
const OrdersPage = lazy(() => import('@/pages/OrdersPage'));
const OrderDetailPage = lazy(() => import('@/pages/OrderDetailPage'));
const AdminApp = lazy(() => import('@/admin/AdminApp'));

function Loading() {
  return <div className="flex min-h-[50vh] items-center justify-center text-graphite"><Spinner /></div>;
}

/** Deep link из Telegram (startapp / start_param): товар, заказ, карточка заявки, категория */
function useStartParamNavigation() {
  const navigate = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const path = startTargetPath(parseStartParam(getStartParam()));
    if (path) navigate(path, { replace: true });
  }, [navigate]);
}

export default function App() {
  useStartParamNavigation();
  const session = useSession();
  if (!isConfigured) {
    return (
      <div className="mx-auto max-w-shop p-6">
        <p className="font-display text-lg">Магазин не настроен</p>
        <p className="mt-2 text-graphite">Не заданы VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY. См. README → «Локальный запуск».</p>
      </div>
    );
  }
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
        <Route element={<ShopLayout />}>
          <Route index element={<HomePage />} />
          <Route path="catalog" element={<CatalogPage />} />
          <Route path="product/:slug" element={<ProductPage />} />
          <Route path="favorites" element={<FavoritesPage />} />
          <Route path="cart" element={<CartPage />} />
          <Route path="checkout" element={<CheckoutPage />} />
          <Route path="checkout/done/:id" element={<CheckoutDonePage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="orders/:id" element={<OrderDetailPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="legal/:doc" element={<LegalPage />} />
          <Route path="dev/mock-payment" element={<MockPaymentPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
      {session.status === 'loading' ? <span className="sr-only" role="status">Вход через Telegram</span> : null}
    </Suspense>
  );
}
