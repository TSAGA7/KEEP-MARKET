import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check, errText } from '../api';
import { AdminPage, Table, Td } from '../ui';
import { Button, ErrorState, Field, Input, Price, Select, Sheet, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { parseRublesToKopecks } from '@shared/money';

interface Promo { id: string; code: string; kind: 'percent' | 'fixed'; value: number; min_order_kopecks: number; max_uses: number | null; used_count: number; starts_at: string | null; ends_at: string | null; is_active: boolean }

export default function PromosPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'promos'], queryFn: async () => check(await db().from('promo_codes').select('*').order('created_at', { ascending: false })) as Promo[] });
  const [form, setForm] = useState<{ code: string; kind: 'percent' | 'fixed'; value: string; min: string; max_uses: string; ends: string } | null>(null);

  const save = async () => {
    if (!form) return;
    const value = form.kind === 'percent' ? Number(form.value) : parseRublesToKopecks(form.value);
    if (!value || (form.kind === 'percent' && (value < 1 || value > 90))) { toast(form.kind === 'percent' ? 'Скидка от 1 до 90%' : 'Укажите сумму скидки', 'error'); return; }
    try {
      check(await db().from('promo_codes').insert({
        code: form.code.trim().toUpperCase(), kind: form.kind, value, min_order_kopecks: form.min ? parseRublesToKopecks(form.min) ?? 0 : 0,
        max_uses: form.max_uses ? Number(form.max_uses) : null, ends_at: form.ends ? new Date(`${form.ends}T23:59:59`).toISOString() : null,
      }));
      toast('Промокод создан', 'success');
      setForm(null);
      await qc.invalidateQueries({ queryKey: ['admin', 'promos'] });
    } catch (e) { toast(errText(e).includes('duplicate') ? 'Такой код уже есть' : errText(e).includes('check') ? 'Код: 3–32 символа A-Z, 0-9, _ и -' : errText(e), 'error'); }
  };
  const toggle = async (p: Promo) => {
    try { check(await db().from('promo_codes').update({ is_active: !p.is_active }).eq('id', p.id)); await qc.invalidateQueries({ queryKey: ['admin', 'promos'] }); }
    catch (e) { toast(errText(e), 'error'); }
  };

  return (
    <AdminPage title="Промокоды" actions={<Button size="sm" onClick={() => setForm({ code: '', kind: 'percent', value: '', min: '', max_uses: '', ends: '' })}>Создать промокод</Button>}>
      <p className="mb-4 max-w-2xl text-sm text-graphite">Скидка рассчитывается сервером при оформлении заявки. Если менеджер исключит позицию, скидка пересчитается автоматически.</p>
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-24" /> : null}
      {q.data?.length === 0 ? <p className="text-sm text-graphite">Промокодов нет.</p> : null}
      {q.data?.length ? (
        <Table head={['Код', 'Скидка', 'Мин. заказ', 'Использован', 'До', 'Статус', '']}>
          {q.data.map((p) => (
            <tr key={p.id}>
              <Td className="num font-medium">{p.code}</Td><Td>{p.kind === 'percent' ? `${p.value}%` : <Price kopecks={p.value} />}</Td>
              <Td><Price kopecks={p.min_order_kopecks} /></Td><Td className="num">{p.used_count}{p.max_uses ? ` из ${p.max_uses}` : ''}</Td>
              <Td>{p.ends_at ? new Date(p.ends_at).toLocaleDateString('ru-RU') : 'без срока'}</Td><Td>{p.is_active ? 'активен' : 'выключен'}</Td>
              <Td><Button size="sm" variant="ghost" onClick={() => toggle(p)}>{p.is_active ? 'Выключить' : 'Включить'}</Button></Td>
            </tr>
          ))}
        </Table>
      ) : null}
      <Sheet open={!!form} onClose={() => setForm(null)} title="Новый промокод" footer={<Button block onClick={save}>Создать</Button>}>
        {form ? (
          <div className="space-y-4">
            <Field label="Код">{(id) => <Input id={id} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Тип">{(id) => <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'percent' | 'fixed' })}><option value="percent">Процент</option><option value="fixed">Сумма, ₽</option></Select>}</Field>
              <Field label={form.kind === 'percent' ? 'Скидка, %' : 'Скидка, ₽'}>{(id) => <Input id={id} inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />}</Field>
            </div>
            <Field label="Минимальная сумма товаров, ₽" optional>{(id) => <Input id={id} inputMode="decimal" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} />}</Field>
            <Field label="Лимит использований" optional>{(id) => <Input id={id} inputMode="numeric" value={form.max_uses} onChange={(e) => setForm({ ...form, max_uses: e.target.value })} />}</Field>
            <Field label="Действует до" optional>{(id) => <Input id={id} type="date" value={form.ends} onChange={(e) => setForm({ ...form, ends: e.target.value })} />}</Field>
          </div>
        ) : null}
      </Sheet>
    </AdminPage>
  );
}
