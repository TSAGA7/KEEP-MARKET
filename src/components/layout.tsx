import { useEffect, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { IconBag, IconGrid, IconHeart, IconHome, IconUser } from './icons';
import { useCart } from '@/lib/cart';
import { tg } from '@/lib/telegram';

const TABS = [
  { to: '/', label: 'Главная', icon: IconHome, end: true },
  { to: '/catalog', label: 'Каталог', icon: IconGrid },
  { to: '/favorites', label: 'Избранное', icon: IconHeart },
  { to: '/cart', label: 'Корзина', icon: IconBag },
  { to: '/profile', label: 'Профиль', icon: IconUser },
] as const;

const ROOTS = new Set(TABS.map((t) => t.to as string));

/** Кнопка «Назад» Telegram: видна на вложенных экранах */
function useTelegramBackButton() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const w = tg();
    if (!w?.BackButton) return;
    const onBack = () => (window.history.length > 1 ? navigate(-1) : navigate('/'));
    if (ROOTS.has(location.pathname)) {
      w.BackButton.hide();
    } else {
      w.BackButton.show();
      w.BackButton.onClick(onBack);
    }
    return () => w.BackButton.offClick(onBack);
  }, [location.pathname, navigate]);
}

function BottomNav() {
  const { count } = useCart();
  return (
    <nav aria-label="Основная навигация"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/95 pb-safeb backdrop-blur supports-[backdrop-filter]:bg-paper/85">
      <ul className="mx-auto grid h-[var(--nav-h)] max-w-shop grid-cols-5">
        {TABS.map(({ to, label, icon: Icon, ...rest }) => (
          <li key={to}>
            <NavLink to={to} end={'end' in rest} className={({ isActive }) =>
              clsx('relative flex h-full flex-col items-center justify-center gap-1 text-[11px] leading-none', isActive ? 'text-ink' : 'text-fog')}>
              {({ isActive }) => (
                <>
                  <Icon size={23} strokeWidth={isActive ? 2 : 1.6} />
                  <span>{label}</span>
                  {to === '/cart' && count > 0 ? (
                    <span className="num absolute left-1/2 top-1.5 ml-2 min-w-[18px] bg-ink px-1 text-center text-[11px] leading-[18px] text-paper" aria-label={`Товаров в корзине: ${count}`}>
                      {count > 99 ? '99+' : count}
                    </span>
                  ) : null}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function ShopLayout() {
  useTelegramBackButton();
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return (
    <div className="mx-auto min-h-screen max-w-shop pt-safet" style={{ paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 12px)' }}>
      <Outlet />
      <BottomNav />
    </div>
  );
}

export function PageHeader({ title, right, sub }: { title: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  return (
    <header className="px-4 pb-2 pt-5">
      <div className="flex items-start justify-between gap-3">
        <h1 className="font-display text-xl">{title}</h1>
        {right}
      </div>
      {sub ? <div className="mt-1 text-sm text-graphite">{sub}</div> : null}
    </header>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx('font-display font-bold leading-none tracking-[-0.02em]', className)} aria-label="KEEP MARKET">
      KEEP<span className="font-medium"> MARKET</span>
    </span>
  );
}
