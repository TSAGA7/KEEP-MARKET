import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check, errText } from '../api';
import { AdminPage, Table, Td } from '../ui';
import { Button, ErrorState, Field, Input, Select, Sheet, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { slugify } from './ProductEditPage';

interface Cat { id: string; parent_id: string | null; name: string; slug: string; sort_order: number; is_active: boolean }

export default function CategoriesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'categories-full'], queryFn: async () => check(await db().from('categories').select('*').order('sort_order')) as Cat[] });
  const [edit, setEdit] = useState<Partial<Cat> | null>(null);

  const save = async () => {
    if (!edit?.name) return;
    const row = { name: edit.name.trim(), slug: (edit.slug || slugify(edit.name)).trim(), parent_id: edit.parent_id || null, sort_order: Number(edit.sort_order ?? 0), is_active: edit.is_active ?? true };
    try {
      if (edit.id) check(await db().from('categories').update(row).eq('id', edit.id));
      else check(await db().from('categories').insert(row));
      toast('Категория сохранена', 'success');
      setEdit(null);
      await qc.invalidateQueries({ queryKey: ['admin', 'categories-full'] });
      await qc.invalidateQueries({ queryKey: ['categories'] });
    } catch (e) { toast(errText(e).includes('duplicate') ? 'Такой slug уже есть' : errText(e), 'error'); }
  };
  const remove = async (c: Cat) => {
    if (!window.confirm(`Удалить категорию «${c.name}»? Если в ней есть товары или подкатегории, удаление не пройдёт — скройте её.`)) return;
    try { check(await db().from('categories').delete().eq('id', c.id)); await qc.invalidateQueries({ queryKey: ['admin', 'categories-full'] }); }
    catch { toast('Нельзя удалить: в категории есть товары или подкатегории. Скройте её вместо удаления.', 'error'); }
  };
  const parents = (q.data ?? []).filter((c) => !c.parent_id);

  return (
    <AdminPage title="Категории" actions={<Button size="sm" onClick={() => setEdit({ is_active: true, sort_order: 0 })}>Добавить категорию</Button>}>
      {q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-40" /> : null}
      {q.data ? (
        <Table head={['Название', 'Slug', 'Родитель', 'Порядок', 'Видна', '']}>
          {parents.flatMap((p) => [p, ...(q.data ?? []).filter((c) => c.parent_id === p.id)]).map((c) => (
            <tr key={c.id}>
              <Td>{c.parent_id ? <span className="text-fog">— </span> : null}{c.name}</Td><Td className="num text-graphite">{c.slug}</Td>
              <Td>{q.data?.find((x) => x.id === c.parent_id)?.name ?? '—'}</Td><Td>{c.sort_order}</Td><Td>{c.is_active ? 'да' : 'скрыта'}</Td>
              <Td className="whitespace-nowrap"><Button size="sm" variant="ghost" onClick={() => setEdit(c)}>Изменить</Button><Button size="sm" variant="ghost" onClick={() => remove(c)}>Удалить</Button></Td>
            </tr>
          ))}
        </Table>
      ) : null}
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Категория' : 'Новая категория'} footer={<Button block onClick={save}>Сохранить</Button>}>
        {edit ? (
          <div className="space-y-4">
            <Field label="Название">{(id) => <Input id={id} value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            <Field label="Slug" hint="Пусто — сформируется из названия">{(id) => <Input id={id} value={edit.slug ?? ''} onChange={(e) => setEdit({ ...edit, slug: e.target.value })} />}</Field>
            <Field label="Родительская категория" optional>
              {(id) => (
                <Select id={id} value={edit.parent_id ?? ''} onChange={(e) => setEdit({ ...edit, parent_id: e.target.value || null })}>
                  <option value="">Нет (верхний уровень)</option>
                  {parents.filter((p) => p.id !== edit.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Порядок сортировки">{(id) => <Input id={id} inputMode="numeric" value={String(edit.sort_order ?? 0)} onChange={(e) => setEdit({ ...edit, sort_order: Number(e.target.value) || 0 })} />}</Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.is_active ?? true} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} className="h-4 w-4" /> Показывать покупателям</label>
          </div>
        ) : null}
      </Sheet>
    </AdminPage>
  );
}
