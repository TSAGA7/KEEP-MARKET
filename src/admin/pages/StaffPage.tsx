// Сотрудники: выдача и снятие ролей по Telegram ID или @username.
// Если человек ещё не открывал магазин — создаётся приглашение, роль появится при его первом входе.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { check, errText, rpc } from '../api';
import { AdminPage, Section } from '../ui';
import { Button, ErrorState, Input, Notice, Select, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { humanizeError } from '@shared/orders';

interface StaffRow { user_id: string; role: string; granted_at: string; profiles: { username: string | null; first_name: string | null; telegram_id: number } | null }
interface Invite { id: string; telegram_id: number | null; username: string | null; role: string; created_at: string }

const ROLE_LABEL: Record<string, string> = { owner: 'Владелец', admin: 'Администратор', manager: 'Менеджер' };
const ROLE_HINT: Record<string, string> = {
  manager: 'Видит только заказы: проверка наличия, оплата, отправка. Финансы не видит.',
  admin: 'Заказы, товары, главная, настройки. Финансы (бухгалтерию) не видит.',
};

export default function StaffPage() {
  const s = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const staff = useQuery({
    queryKey: ['admin', 'staff'],
    queryFn: async () => check(await db().from('user_roles').select('user_id, role, granted_at, profiles!user_roles_user_id_fkey(username, first_name, telegram_id)').order('granted_at')) as unknown as StaffRow[],
  });
  const invites = useQuery({
    queryKey: ['admin', 'staff-invites'],
    queryFn: async () => check(await db().from('staff_invites').select('id, telegram_id, username, role, created_at').order('created_at')) as Invite[],
  });
  const [ident, setIdent] = useState('');
  const [role, setRole] = useState<'manager' | 'admin'>('manager');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['admin', 'staff'] });
    await qc.invalidateQueries({ queryKey: ['admin', 'staff-invites'] });
  };

  const grant = async () => {
    if (!ident.trim()) return;
    setBusy(true);
    try {
      const r = await rpc<{ result: 'granted' | 'invited' }>('staff_invite', { p_ident: ident.trim(), p_role: role });
      toast(r.result === 'granted'
        ? `Готово: ${ROLE_LABEL[role]?.toLowerCase()} назначен. Пусть закроет и заново откроет магазин`
        : 'Приглашение создано: права появятся, когда человек впервые откроет магазин в Telegram', 'success');
      setIdent('');
      await refresh();
    } catch (e) {
      const m = errText(e);
      toast(m.includes('staff_ident') ? 'Укажите @username или числовой Telegram ID' : humanizeError(m), 'error');
    } finally { setBusy(false); }
  };

  const revoke = async (r: StaffRow) => {
    if (!window.confirm(`Снять роль «${ROLE_LABEL[r.role]}»?`)) return;
    try { await rpc('staff_set_role', { p_user_id: r.user_id, p_role: r.role, p_grant: false }); await refresh(); toast('Роль снята', 'success'); }
    catch (e) { toast(humanizeError(errText(e)), 'error'); }
  };

  const cancelInvite = async (i: Invite) => {
    try { await rpc('staff_invite_cancel', { p_id: i.id }); await refresh(); }
    catch (e) { toast(humanizeError(errText(e)), 'error'); }
  };

  return (
    <AdminPage title="Сотрудники">
      <Section title="Выдать права">
        <div className="flex max-w-xl flex-col gap-2 sm:flex-row">
          <Input className="flex-1" placeholder="@username или Telegram ID" value={ident} onChange={(e) => setIdent(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void grant(); }} autoCapitalize="none" autoCorrect="off" />
          <Select className="sm:w-44" value={role} onChange={(e) => setRole(e.target.value as 'manager' | 'admin')}>
            <option value="manager">Менеджер</option>
            {s.isOwner ? <option value="admin">Администратор</option> : null}
          </Select>
          <Button loading={busy} onClick={() => void grant()} disabled={!ident.trim()}>Назначить</Button>
        </div>
        <p className="mt-2 max-w-xl text-sm text-graphite">{ROLE_HINT[role]}</p>
        <p className="mt-1 max-w-xl text-sm text-graphite">Telegram ID можно узнать у бота @userinfobot. Если человек ещё не заходил в магазин — права включатся при его первом входе.</p>
      </Section>

      <Section title="Команда">
        {staff.isError ? <ErrorState onRetry={() => void staff.refetch()} /> : null}
        {staff.isLoading ? <Skeleton className="h-24" /> : null}
        <ul className="divide-y divide-line border-y border-line">
          {(staff.data ?? []).map((r) => (
            <li key={`${r.user_id}-${r.role}`} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.profiles?.username ? `@${r.profiles.username}` : r.profiles?.first_name ?? '—'}</p>
                <p className="text-sm text-graphite">{ROLE_LABEL[r.role] ?? r.role} · ID <span className="num">{r.profiles?.telegram_id}</span> · с {new Date(r.granted_at).toLocaleDateString('ru-RU')}</p>
              </div>
              {r.role !== 'owner' && r.user_id !== s.profile?.id && (s.isOwner || r.role === 'manager') ? (
                <Button size="sm" variant="ghost" onClick={() => void revoke(r)}>Снять</Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      {invites.data && invites.data.length > 0 ? (
        <Section title="Ждут первого входа">
          <ul className="divide-y divide-line border-y border-line">
            {invites.data.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{i.username ? `@${i.username}` : <span className="num">ID {i.telegram_id}</span>}</p>
                  <p className="text-sm text-graphite">{ROLE_LABEL[i.role]} · приглашён {new Date(i.created_at).toLocaleDateString('ru-RU')}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void cancelInvite(i)}>Отменить</Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {!s.isOwner ? <Notice className="mt-4">Администратор может назначать только менеджеров.</Notice> : null}
    </AdminPage>
  );
}
