import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check } from '../api';
import { AdminPage, Table, Td } from '../ui';
import { ErrorState, Input, Skeleton, Button } from '@/components/ui';
import { formatDateTime } from '@/components/order';

interface Log { id: number; action: string; entity: string; entity_id: string | null; details: Record<string, unknown>; created_at: string; actor_id: string | null }

const ACTION: Record<string, string> = {
  order_created: 'Создана заявка', pd_viewed: 'Просмотр контактов получателя', role_granted: 'Выдана роль', role_revoked: 'Снята роль',
  stock_confirmed: 'Подтверждён остаток', import_preview: 'Проверка прайса', import_applied: 'Применён импорт', import_rolled_back: 'Отменён импорт',
  payment_event: 'Уведомление платежа', payment_created: 'Создан платёж', refund_requested: 'Запрошен возврат', offline_payment_registered: 'Зафиксирована оплата',
  bootstrap_owner: 'Назначен владелец', pd_purged: 'Обезличивание ПДн', insert: 'Создание', update: 'Изменение', delete: 'Удаление',
};

export default function AuditPage() {
  const [entity, setEntity] = useState('');
  const [limit, setLimit] = useState(100);
  const q = useQuery({
    queryKey: ['admin', 'audit', entity, limit],
    queryFn: async () => {
      let query = db().from('audit_logs').select('*').order('id', { ascending: false }).limit(limit);
      if (entity) query = query.eq('entity', entity);
      return check(await query) as Log[];
    },
  });
  const actors = useQuery({
    queryKey: ['admin', 'audit-actors', q.data?.map((l) => l.actor_id).join()],
    enabled: !!q.data,
    queryFn: async () => {
      const ids = [...new Set(q.data!.map((l) => l.actor_id).filter(Boolean))] as string[];
      if (!ids.length) return {} as Record<string, string>;
      const rows = check(await db().from('profiles').select('id, username, first_name').in('id', ids)) as Array<{ id: string; username: string | null; first_name: string | null }>;
      return Object.fromEntries(rows.map((r) => [r.id, r.username ? `@${r.username}` : r.first_name ?? r.id.slice(0, 8)]));
    },
  });
  return (
    <AdminPage title="Журнал действий">
      <p className="mb-4 max-w-2xl text-sm text-graphite">Журнал нельзя изменить или удалить. Персональные данные в нём не хранятся — только факт действия.</p>
      <Input className="mb-4 max-w-xs" placeholder="Фильтр по сущности: orders, products…" value={entity} onChange={(e) => setEntity(e.target.value.trim())} />
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-40" /> : null}
      {q.data ? (
        <>
          <Table head={['Время', 'Кто', 'Действие', 'Объект', 'Детали']}>
            {q.data.map((l) => (
              <tr key={l.id}>
                <Td className="whitespace-nowrap">{formatDateTime(l.created_at)}</Td>
                <Td>{l.actor_id ? actors.data?.[l.actor_id] ?? '…' : 'система'}</Td>
                <Td>{ACTION[l.action] ?? l.action}</Td>
                <Td className="text-graphite">{l.entity}{l.entity_id ? <div className="num text-xs text-fog">{l.entity_id.slice(0, 13)}</div> : null}</Td>
                <Td className="max-w-[360px] break-words text-xs text-graphite">{Object.keys(l.details ?? {}).length ? JSON.stringify(l.details) : ''}</Td>
              </tr>
            ))}
          </Table>
          {q.data.length >= limit ? <Button variant="secondary" className="mt-4" onClick={() => setLimit(limit + 100)}>Показать ещё</Button> : null}
        </>
      ) : null}
    </AdminPage>
  );
}
