import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getPublicSettings } from '@/lib/api';
import { useSession } from '@/lib/session';
import { openTelegramLink } from '@/lib/telegram';
import { humanizeError } from '@shared/orders';
import { PageHeader } from '@/components/layout';
import { Button, Notice, Skeleton } from '@/components/ui';
import { IconBox, IconChat, IconChevronRight, IconSend, IconShield, IconStar, IconUser } from '@/components/icons';
import type { ReactNode } from 'react';

const REVIEWS_CHANNEL_URL = 'https://t.me/km_otzv';
const MANAGER_URL_DEFAULT = 'https://t.me/keep_admin';

export function TelegramRequired() {
  const s = useSession();
  return (
    <div className="px-4 pt-4">
      {s.status === 'error' ? (
        <Notice tone="bad">
          <p>{humanizeError(s.error)}</p>
          <button className="mt-2 font-medium underline underline-offset-4" onClick={s.retry}>Повторить вход</button>
        </Notice>
      ) : (
        <Notice>
          <p className="font-medium">Откройте KEEP MARKET в Telegram</p>
          <p className="mt-1 text-graphite">Заказы, избранное и личный кабинет работают только внутри Telegram: так мы подтверждаем, что это вы, без паролей. Каталог доступен и в браузере.</p>
        </Notice>
      )}
    </div>
  );
}

function Row({ to, onClick, icon, children }: { to?: string; onClick?: () => void; icon: ReactNode; children: ReactNode }) {
  const inner = <span className="flex h-14 items-center gap-3"><span className="text-graphite">{icon}</span><span className="flex-1">{children}</span><IconChevronRight className="text-fog" /></span>;
  return <li>{to ? <Link to={to} className="block px-4">{inner}</Link> : <button onClick={onClick} className="block w-full px-4 text-left">{inner}</button>}</li>;
}

export default function ProfilePage() {
  const s = useSession();
  const settings = useQuery({ queryKey: ['settings'], queryFn: getPublicSettings });
  const bot = typeof settings.data?.telegram_bot_username === 'string' ? settings.data.telegram_bot_username : null;
  const channel = typeof settings.data?.telegram_channel_url === 'string' ? settings.data.telegram_channel_url : null;
  const managerSetting = typeof settings.data?.manager_contact_url === 'string' ? settings.data.manager_contact_url : null;
  const managerUrl = managerSetting && /^https:\/\/t\.me\/\w{4,64}$/.test(managerSetting) ? managerSetting : MANAGER_URL_DEFAULT;
  const hours = typeof settings.data?.support_hours === 'string' ? settings.data.support_hours : null;
  const p = s.profile;

  return (
    <div>
      <PageHeader title="Профиль" />
      {s.status === 'loading' ? <div className="px-4"><Skeleton className="h-14" /></div> : null}
      {p ? (
        <div className="flex items-center gap-3 px-4 pb-4">
          {p.photo_url ? <img src={p.photo_url} alt="" className="h-14 w-14 object-cover" /> : <div className="flex h-14 w-14 items-center justify-center bg-concrete font-display text-lg">{(p.first_name ?? '?').slice(0, 1)}</div>}
          <div>
            <p className="font-medium">{[p.first_name, p.last_name].filter(Boolean).join(' ') || 'Покупатель'}</p>
            {p.username ? <p className="text-sm text-graphite">@{p.username}</p> : null}
          </div>
        </div>
      ) : s.status !== 'loading' ? <TelegramRequired /> : null}

      {p && !p.bot_connected && bot ? (
        <Notice className="mx-4 mb-4">
          Чтобы получать уведомления о заказах, откройте бота и нажмите «Старт».
          <Button size="sm" className="mt-3" onClick={() => openTelegramLink(`https://t.me/${bot}?start=hello`)}><IconSend size={16} /> Открыть бота</Button>
        </Notice>
      ) : null}

      <ul className="divide-y divide-line border-y border-line">
        <Row to="/orders" icon={<IconBox />}>Мои заказы</Row>
        {bot ? <Row onClick={() => openTelegramLink(`https://t.me/${bot}`)} icon={<IconChat />}>Поддержка и вопросы по заказу</Row> : null}
        {channel ? <Row onClick={() => openTelegramLink(channel)} icon={<IconSend />}>Канал KEEP MARKET</Row> : null}
        <Row onClick={() => openTelegramLink(REVIEWS_CHANNEL_URL)} icon={<IconStar />}>Отзывы</Row>
        <Row onClick={() => openTelegramLink(managerUrl)} icon={<IconChat />}>Написать менеджеру</Row>
        {s.isStaff ? <Row to="/admin" icon={<IconShield />}>Панель управления</Row> : null}
        {s.isAdmin ? <Row to="/admin/staff" icon={<IconUser />}>Сотрудники и права</Row> : null}
      </ul>
      {hours ? <p className="px-4 pt-4 text-sm text-graphite">Поддержка: {hours}</p> : null}
    </div>
  );
}
