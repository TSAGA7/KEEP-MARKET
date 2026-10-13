import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { check, errText, rpc } from '../api';
import { AdminPage, Section, Table, Td } from '../ui';
import { Badge, Button, ErrorState, Input, Notice, Select, Skeleton, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { humanizeError } from '@shared/orders';

interface Setting { key: string; value: unknown; is_public: boolean; is_critical: boolean; description: string | null; updated_at: string }

function SettingRow({ s, canEdit, onSaved }: { s: Setting; canEdit: boolean; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const isText = typeof s.value === 'string' || s.value === null;
  const isLong = ['offer_text', 'privacy_policy_text', 'return_policy', 'delivery_info'].includes(s.key);
  const [val, setVal] = useState(isText ? ((s.value as string | null) ?? '') : JSON.stringify(s.value, null, 2));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    let value: unknown;
    if (typeof s.value === 'boolean') value = val === 'true';
    else if (typeof s.value === 'number') { value = Number(val); if (!Number.isFinite(value as number)) { toast('Нужно число', 'error'); return; } }
    else if (isText) value = val.trim() === '' ? null : val;
    else { try { value = JSON.parse(val); } catch { toast('Некорректный JSON', 'error'); return; } }
    setBusy(true);
    try {
      const r = await db().from('store_settings').update({ value }).eq('key', s.key).select('key');
      check(r);
      if (!r.data?.length) throw new Error('FORBIDDEN');
      toast('Сохранено', 'success');
      await onSaved();
    } catch (e) { toast(humanizeError(errText(e)), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-2 border-b border-line py-4 md:grid-cols-[260px_1fr_auto] md:items-start">
      <div>
        <p className="text-sm font-medium">{s.description ?? s.key}</p>
        <p className="num text-xs text-fog">{s.key} {s.is_critical ? <Badge tone="warn">только владелец</Badge> : null} {s.is_public ? <Badge>видно покупателям</Badge> : null}</p>
      </div>
      {typeof s.value === 'boolean' ? (
        <Select value={val} onChange={(e) => setVal(e.target.value)} disabled={!canEdit}><option value="true">Да</option><option value="false">Нет</option></Select>
      ) : isLong || (!isText && typeof s.value === 'object') ? (
        <Textarea rows={isLong ? 6 : 4} value={val} onChange={(e) => setVal(e.target.value)} disabled={!canEdit} className="font-sans text-sm" />
      ) : (
        <Input value={val} onChange={(e) => setVal(e.target.value)} disabled={!canEdit} />
      )}
      {canEdit ? <Button size="sm" variant="secondary" loading={busy} onClick={save}>Сохранить</Button> : <span />}
    </div>
  );
}

interface StaffRow { user_id: string; role: string; granted_at: string; profiles: { username: string | null; first_name: string | null; telegram_id: number } | null }

export default function SettingsPage() {
  const s = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: async () => check(await db().from('store_settings').select('*').order('key')) as Setting[] });
  const staff = useQuery({ queryKey: ['admin', 'staff'], queryFn: async () => check(await db().from('user_roles').select('user_id, role, granted_at, profiles!user_roles_user_id_fkey(username, first_name, telegram_id)').order('granted_at')) as unknown as StaffRow[] });
  const [tgUser, setTgUser] = useState('');
  const [role, setRole] = useState<'manager' | 'admin'>('manager');
  const [purging, setPurging] = useState(false);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['admin', 'settings'] }); await qc.invalidateQueries({ queryKey: ['settings'] }); };

  const grant = async () => {
    const t = tgUser.trim().replace(/^@/, '');
    if (!t) return;
    try {
      const filter = /^\d+$/.test(t) ? db().from('profiles').select('id').eq('telegram_id', Number(t)) : db().from('profiles').select('id').ilike('username', t);
      const p = check(await filter.maybeSingle()) as { id: string } | null;
      if (!p) { toast('Пользователь не найден: он должен хотя бы раз открыть магазин в Telegram', 'error'); return; }
      await rpc('staff_set_role', { p_user_id: p.id, p_role: role, p_grant: true });
      toast('Роль назначена', 'success');
      setTgUser('');
      await qc.invalidateQueries({ queryKey: ['admin', 'staff'] });
    } catch (e) { toast(humanizeError(errText(e)), 'error'); }
  };
  const revoke = async (r: StaffRow) => {
    if (!window.confirm('Снять роль?')) return;
    try { await rpc('staff_set_role', { p_user_id: r.user_id, p_role: r.role, p_grant: false }); await qc.invalidateQueries({ queryKey: ['admin', 'staff'] }); }
    catch (e) { toast(humanizeError(errText(e)), 'error'); }
  };
  const purge = async () => {
    if (!window.confirm('Обезличить контактные данные закрытых заказов старше срока хранения? Действие необратимо.')) return;
    setPurging(true);
    try { const n = await rpc<number>('purge_expired_personal_data'); toast(`Обезличено заказов: ${n}`, 'success'); }
    catch (e) { toast(humanizeError(errText(e)), 'error'); } finally { setPurging(false); }
  };

  return (
    <AdminPage title="Настройки магазина">
      <Section title="Сотрудники">
        <p className="mb-3 max-w-2xl text-sm text-graphite">Владелец назначает администраторов и менеджеров, администратор — менеджеров. Роль владельца через интерфейс не передаётся. Сотрудник должен один раз открыть магазин в Telegram.</p>
        {staff.isError ? <ErrorState onRetry={() => void staff.refetch()} /> : null}
        {staff.data ? (
          <Table head={['Сотрудник', 'Telegram ID', 'Роль', 'С', '']} className="mb-4">
            {staff.data.map((r) => (
              <tr key={`${r.user_id}-${r.role}`}>
                <Td>{r.profiles?.username ? `@${r.profiles.username}` : r.profiles?.first_name ?? '—'}</Td><Td className="num">{r.profiles?.telegram_id}</Td>
                <Td>{r.role === 'owner' ? 'Владелец' : r.role === 'admin' ? 'Администратор' : 'Менеджер'}</Td>
                <Td>{new Date(r.granted_at).toLocaleDateString('ru-RU')}</Td>
                <Td>{r.role !== 'owner' && r.user_id !== s.profile?.id && (s.isOwner || r.role === 'manager') ? <Button size="sm" variant="ghost" onClick={() => revoke(r)}>Снять роль</Button> : null}</Td>
              </tr>
            ))}
          </Table>
        ) : <Skeleton className="h-16" />}
        <div className="flex max-w-xl flex-wrap gap-2">
          <Input className="flex-1" placeholder="@username или Telegram ID" value={tgUser} onChange={(e) => setTgUser(e.target.value)} />
          <Select className="w-44" value={role} onChange={(e) => setRole(e.target.value as 'manager' | 'admin')}>
            <option value="manager">Менеджер</option>{s.isOwner ? <option value="admin">Администратор</option> : null}
          </Select>
          <Button onClick={grant}>Назначить</Button>
        </div>
      </Section>

      <Section title="Параметры">
        {!s.isOwner ? <Notice className="mb-3">Критичные настройки (платежи, безопасность, хранение данных) меняет только владелец.</Notice> : null}
        {settings.isError ? <ErrorState onRetry={() => void settings.refetch()} /> : null}
        {settings.isLoading ? <Skeleton className="h-40" /> : null}
        {settings.data?.map((x) => <SettingRow key={x.key} s={x} canEdit={s.isOwner || (s.isAdmin && !x.is_critical)} onSaved={refresh} />)}
      </Section>

      {s.isOwner ? (
        <Section title="Хранение персональных данных">
          <p className="mb-3 max-w-2xl text-sm text-graphite">Контакты получателей в доставленных и отменённых заказах обезличиваются по истечении срока из настройки pd_retention_days. Рекомендуется запуск по расписанию (см. docs/supabase.md), здесь — ручной запуск.</p>
          <Button variant="secondary" loading={purging} onClick={purge}>Обезличить устаревшие данные</Button>
        </Section>
      ) : null}
    </AdminPage>
  );
}
