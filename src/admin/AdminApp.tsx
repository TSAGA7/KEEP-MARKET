import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useSession } from '@/lib/session';
import { tg } from '@/lib/telegram';
import { Wordmark } from '@/components/layout';
import { Spinner } from '@/components/ui';
import {
  IconBox, IconCard, IconDoc, IconGrid, IconHome, IconList, IconMenu, IconRuler, IconSettings, IconTag,
  IconTruck, IconUpload, IconUsers, IconImage, IconClose,
} from '@/components/icons';
import { TelegramRequired } from '@/pages/ProfilePage';
import DashboardPage from './pages/DashboardPage';
import { AdminPage } from './ui';

const ProductsPage = lazy(() => import('./pages/ProductsPage'));
const ProductEditPage = lazy(() => import('./pages/ProductEditPage'));
const CategoriesPage = lazy(() => import('./pages/CategoriesPage'));
const VariantsPage = lazy(() => import('./pages/VariantsPage'));
const PricingPage = lazy(() => import('./pages/PricingPage'));
const SuppliersPage = lazy(() => import('./pages/SuppliersPage'));
const OrdersPage = lazy(() => import('./pages/OrdersPage'));
const OrderPage = lazy(() => import('./pages/OrderPage'));
const PaymentsPage = lazy(() => import('./pages/PaymentsPage'));
const ShipmentsPage = lazy(() => import('./pages/ShipmentsPage'));
const CustomersPage = lazy(() => import('./pages/CustomersPage'));
const PromosPage = lazy(() => import('./pages/PromosPage'));
const BannersPage = lazy(() => import('./pages/BannersPage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

type Role = 'owner' | 'admin' | 'manager';
const NAV: Array<{ to: string; label: string; icon: (p: { size?: number }) => JSX.Element; roles: Role[] }> = [
  { to: '', label: 'Обзор', icon: IconHome, roles: ['owner', 'admin', 'manager'] },
  { to: 'orders', label: 'Заказы', icon: IconBox, roles: ['owner', 'admin', 'manager'] },
  { to: 'products', label: 'Товары', icon: IconGrid, roles: ['owner', 'admin', 'manager'] },
  { to: 'categories', label: 'Категории', icon: IconList, roles: ['owner', 'admin'] },
  { to: 'variants', label: 'Размеры и остатки', icon: IconRuler, roles: ['owner', 'admin', 'manager'] },
  { to: 'pricing', label: 'Прайсы', icon: IconUpload, roles: ['owner', 'admin'] },
  { to: 'suppliers', label: 'Поставщики', icon: IconUsers, roles: ['owner', 'admin', 'manager'] },
  { to: 'payments', label: 'Платежи', icon: IconCard, roles: ['owner', 'admin'] },
  { to: 'shipments', label: 'Отправления', icon: IconTruck, roles: ['owner', 'admin', 'manager'] },
  { to: 'customers', label: 'Покупатели', icon: IconUsers, roles: ['owner', 'admin', 'manager'] },
  { to: 'promos', label: 'Промокоды', icon: IconTag, roles: ['owner', 'admin'] },
  { to: 'banners', label: 'Баннеры и подборки', icon: IconImage, roles: ['owner', 'admin'] },
  { to: 'audit', label: 'Журнал действий', icon: IconDoc, roles: ['owner', 'admin'] },
  { to: 'settings', label: 'Настройки', icon: IconSettings, roles: ['owner', 'admin'] },
];

export default function AdminApp() {
  const s = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [location.pathname]);

  // В админке кнопка Telegram «Назад» ведёт на шаг назад
  useEffect(() => {
    const w = tg();
    if (!w?.BackButton) return;
    const onBack = () => navigate(-1);
    w.BackButton.show();
    w.BackButton.onClick(onBack);
    return () => { w.BackButton.offClick(onBack); };
  }, [navigate]);

  if (s.status === 'loading') return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (s.status !== 'authenticated') return <div className="mx-auto max-w-shop pt-10"><TelegramRequired /></div>;
  if (!s.isStaff) {
    return (
      <div className="mx-auto max-w-shop px-4 pt-10">
        <p className="font-display text-lg">Нет доступа</p>
        <p className="mt-2 text-graphite">Панель управления доступна только сотрудникам магазина.</p>
        <Link to="/" className="mt-4 inline-block underline underline-offset-4">В магазин</Link>
      </div>
    );
  }

  const nav = NAV.filter((n) => n.roles.some((r) => s.roles.includes(r)));
  const roleLabel = s.isOwner ? 'Владелец' : s.isAdmin ? 'Администратор' : 'Менеджер';

  const navList = (
    <ul className="flex flex-col gap-0.5">
      {nav.map(({ to, label, icon: Icon }) => (
        <li key={to}>
          <NavLink to={to ? `/admin/${to}` : '/admin'} end={!to}
            className={({ isActive }) => clsx('flex h-10 items-center gap-3 px-3 text-sm', isActive ? 'bg-ink text-paper' : 'text-graphite hover:bg-concrete hover:text-ink')}>
            <Icon size={19} />{label}
          </NavLink>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="min-h-screen pt-safet lg:flex">
      <aside className="hidden w-60 shrink-0 border-r border-line lg:block">
        <div className="sticky top-0 flex h-screen flex-col gap-6 overflow-y-auto p-4">
          <Link to="/admin"><Wordmark className="text-lg" /></Link>
          <p className="-mt-4 text-xs text-graphite">{roleLabel}</p>
          {navList}
          <Link to="/" className="mt-auto text-sm text-graphite underline underline-offset-4">Открыть магазин</Link>
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-paper px-4 lg:hidden">
        <Link to="/admin"><Wordmark className="text-base" /></Link>
        <button className="flex items-center gap-2 text-sm" onClick={() => setMenu(true)} aria-label="Разделы"><span className="text-graphite">{roleLabel}</span><IconMenu /></button>
      </header>
      {menu ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Разделы">
          <button className="absolute inset-0 bg-black/40" aria-label="Закрыть" onClick={() => setMenu(false)} />
          <div className="absolute inset-y-0 right-0 flex w-72 flex-col gap-4 overflow-y-auto bg-paper p-4 pt-[calc(var(--safe-top)+16px)]">
            <div className="flex items-center justify-between"><span className="font-display">Разделы</span><button onClick={() => setMenu(false)} aria-label="Закрыть"><IconClose /></button></div>
            {navList}
            <Link to="/" className="text-sm text-graphite underline underline-offset-4">Открыть магазин</Link>
          </div>
        </div>
      ) : null}

      <main className="min-w-0 flex-1">
        <Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}>
          <Routes>
            <Route index element={<DashboardPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="orders/:id" element={<OrderPage />} />
            <Route path="products" element={<ProductsPage />} />
            <Route path="products/:id" element={<ProductEditPage />} />
            <Route path="categories" element={<CategoriesPage />} />
            <Route path="variants" element={<VariantsPage />} />
            <Route path="pricing" element={<PricingPage />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="payments" element={<PaymentsPage />} />
            <Route path="shipments" element={<ShipmentsPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="promos" element={<PromosPage />} />
            <Route path="banners" element={<BannersPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<AdminPage title="Раздел не найден"><Link to="/admin" className="underline">На главную панели</Link></AdminPage>} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
