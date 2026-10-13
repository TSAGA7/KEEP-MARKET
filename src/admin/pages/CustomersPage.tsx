import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check } from '../api';
import { AdminPage, Table, Td } from '../ui';
import { ErrorState, Input, Skeleton } from '@/components/ui';
import { formatDateTime } from '@/components/order';

interface Row { id: string; username: string | null; first_name: string | null; last_name: string | null; created_at: string; last_login_at: string | null; bot_chat_id: number | null; orders: Array<{ id: string; number: string }> }

export default function CustomersPage() {
  const [term, setTerm] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'customers', term],
    queryFn: async () => {
      let query = db().from('profiles').select('id, username, first_name, last_name, created_at, last_login_at, bot_chat_id, orders!orders_customer_id_fkey(id, number)').order('created_at', { ascending: false }).limit(200);
      const t = term.replace(/[%,()@]/g, ' ').trim();
      if (t) query = query.or(`username.ilike.%${t}%,first_name.ilike.%${t}%,last_name.ilike.%${t}%`);
      return check(await query) as unknown as Row[];
    },
  });
  return (
    <AdminPage title="Покупатели">
      <p className="mb-4 max-w-2xl text-sm text-graphite">Здесь видны только данные Telegram-профиля. Телефоны и адреса получателей открываются в карточке заказа, каждый просмотр записывается в журнал.</p>
      <Input className="mb-4 max-w-sm" placeholder="Имя или username" value={term} onChange={(e) => setTerm(e.target.value)} />
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-32" /> : null}
      {q.data ? (
        <Table head={['Покупатель', 'Бот', 'Заказы', 'Первый вход', 'Последний вход']}>
          {q.data.map((c) => (
            <tr key={c.id}>
              <Td>{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}{c.username ? <div className="text-xs text-graphite">@{c.username}</div> : null}</Td>
              <Td>{c.bot_chat_id ? 'подключён' : '—'}</Td>
              <Td>{c.orders.length ? c.orders.slice(0, 3).map((o) => <Link key={o.id} to={`/admin/orders/${o.id}`} className="num mr-2 underline-offset-4 hover:underline">{o.number}</Link>) : '—'}{c.orders.length > 3 ? <span className="text-graphite">+{c.orders.length - 3}</span> : null}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(c.created_at)}</Td><Td className="whitespace-nowrap">{c.last_login_at ? formatDateTime(c.last_login_at) : '—'}</Td>
            </tr>
          ))}
        </Table>
      ) : null}
    </AdminPage>
  );
}
