import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getPublicSettings } from '@/lib/api';
import { openTelegramLink } from '@/lib/telegram';
import { Button, Notice } from '@/components/ui';
import { IconCheck, IconSend } from '@/components/icons';

export default function CheckoutDonePage() {
  const { id = '' } = useParams();
  const state = (useLocation().state ?? {}) as { number?: string; botLink?: string | null; managerLink?: string | null };
  const settings = useQuery({ queryKey: ['settings'], queryFn: getPublicSettings });
  const hours = typeof settings.data?.support_hours === 'string' ? settings.data.support_hours : null;
  const link = state.botLink ?? state.managerLink ?? null;

  return (
    <div className="px-4 pt-8">
      <div className="flex h-12 w-12 items-center justify-center bg-ink text-paper"><IconCheck size={26} /></div>
      <h1 className="mt-5 font-display text-2xl leading-tight">Заявка принята</h1>
      {state.number ? <p className="mt-2 text-md">Номер заявки <span className="num font-semibold">{state.number}</span></p> : null}
      <p className="mt-4 text-graphite">Менеджер проверит наличие у поставщика и свяжется с вами, чтобы согласовать доставку и способ оплаты. Деньги не списывались.</p>

      {link ? (
        <Button block size="lg" className="mt-6" onClick={() => openTelegramLink(link)}>
          <IconSend size={20} /> Перейти к менеджеру в Telegram
        </Button>
      ) : null}

      <Notice className="mt-4">
        {link
          ? 'Если Telegram не открылся, найдите бота KEEP MARKET и отправьте ему номер заявки — менеджер увидит сообщение.'
          : 'Чтобы ускорить согласование, напишите боту KEEP MARKET и укажите номер заявки.'}
        {hours ? ` Мы на связи: ${hours}.` : ''}
      </Notice>

      <div className="mt-6 flex flex-col gap-2">
        <Link to={`/orders/${id}`}><Button block variant="secondary">Открыть заявку</Button></Link>
        <Link to="/catalog" className="py-3 text-center text-sm underline underline-offset-4">Продолжить покупки</Link>
      </div>
    </div>
  );
}
