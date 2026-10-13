import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/supabase';
import { check, errText, rpc } from '../api';
import { AdminPage, Section, Table, Td } from '../ui';
import { Badge, Button, ErrorState, Field, Notice, Select, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { formatDateTime } from '@/components/order';
import { priceRowsFromCsv, PRICE_COLUMNS, type PriceRow } from '@shared/csv';
import { humanizeError } from '@shared/orders';
import { config } from '@/lib/config';

interface Preview { import_id: string; total_rows: number; valid_rows: number; error_rows: number; errors: Array<{ row: number; sku: string | null; errors: string[] }>; new_offers: number; price_changes: number }
interface ImportRow { id: string; filename: string; status: string; total_rows: number; valid_rows: number; error_rows: number; created_at: string; applied_at: string | null; suppliers: { name: string } | null }

const STATUS: Record<string, string> = { preview: 'Предпросмотр', applied: 'Применён', rolled_back: 'Отменён', discarded: 'Отброшен' };

export default function PricingPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const sups = useQuery({ queryKey: ['admin', 'suppliers-min'], queryFn: async () => check(await db().from('suppliers').select('id, name').eq('is_active', true).order('name')) as Array<{ id: string; name: string }> });
  const history = useQuery({ queryKey: ['admin', 'imports'], queryFn: async () => check(await db().from('supplier_imports').select('id, filename, status, total_rows, valid_rows, error_rows, created_at, applied_at, suppliers(name)').order('created_at', { ascending: false }).limit(50)) as unknown as ImportRow[] });
  const [supplier, setSupplier] = useState('');
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [filename, setFilename] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (f: File | undefined) => {
    setFileError(null); setRows(null); setPreview(null);
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { setFileError('Файл больше 2 МБ'); return; }
    if (!/\.(csv|txt)$/i.test(f.name)) { setFileError('Нужен файл .csv'); return; }
    try {
      const text = await f.text();
      const { rows: r, mapping } = priceRowsFromCsv(text);
      if (mapping.missing.length) {
        setFileError(`Не найдены обязательные колонки: ${mapping.missing.map((m) => PRICE_COLUMNS[m][0]).join(', ')}. Пример — в шаблоне ниже.`);
        return;
      }
      setRows(r);
      setFilename(f.name);
    } catch (e) { setFileError(errText(e)); }
  };

  const runPreview = async () => {
    if (!rows || !supplier) return;
    setBusy(true);
    try {
      setPreview(await rpc<Preview>('staff_import_preview', { p_supplier_id: supplier, p_filename: filename, p_rows: rows }));
      await qc.invalidateQueries({ queryKey: ['admin', 'imports'] });
    } catch (e) { toast(humanizeError(errText(e)), 'error'); } finally { setBusy(false); }
  };

  const apply = async (withErrors: boolean) => {
    if (!preview) return;
    if (!window.confirm(`Применить ${preview.valid_rows} строк? Изменённые значения можно будет вернуть отменой импорта.`)) return;
    setBusy(true);
    try {
      const r = await rpc<{ updated: number; created: number }>('staff_import_apply', { p_import_id: preview.import_id, p_apply_with_errors: withErrors });
      toast(`Обновлено: ${r.updated}, новых предложений: ${r.created}`, 'success');
      setPreview(null); setRows(null);
      await qc.invalidateQueries({ queryKey: ['admin', 'imports'] });
    } catch (e) { toast(humanizeError(errText(e)), 'error'); } finally { setBusy(false); }
  };

  const discard = async () => {
    if (!preview) return;
    try { await rpc('staff_import_discard', { p_import_id: preview.import_id }); setPreview(null); await qc.invalidateQueries({ queryKey: ['admin', 'imports'] }); }
    catch (e) { toast(errText(e), 'error'); }
  };

  const rollback = async (id: string) => {
    if (!window.confirm('Отменить импорт и восстановить предыдущие значения? Строки, изменённые более поздним импортом, не трогаются.')) return;
    try {
      const r = await rpc<{ restored: number; deleted: number; skipped: number }>('staff_import_rollback', { p_import_id: id });
      toast(`Восстановлено: ${r.restored}, удалено новых: ${r.deleted}, пропущено: ${r.skipped}`, 'success');
      await qc.invalidateQueries({ queryKey: ['admin', 'imports'] });
    } catch (e) { toast(humanizeError(errText(e)), 'error'); }
  };

  return (
    <AdminPage title="Прайсы и остатки">
      <Section title="Загрузка CSV-прайса">
        <ol className="mb-4 max-w-2xl list-decimal space-y-1 pl-5 text-sm text-graphite">
          <li>Выберите поставщика и файл. Обязательные колонки: артикул поставщика, цена, остаток. Необязательные: название, размеры и цвета через «|».</li>
          <li>Сервер проверит каждую строку и покажет отчёт. Данные на этом шаге не меняются.</li>
          <li>Подтвердите импорт. Его можно отменить и вернуть прежние значения.</li>
        </ol>
        <a className="mb-4 inline-block text-sm underline underline-offset-4" href={`${config.baseUrl}supplier-price-template.csv`} download>Скачать шаблон прайса</a>
        <div className="grid max-w-2xl gap-4 md:grid-cols-2">
          <Field label="Поставщик">
            {(id) => (
              <Select id={id} value={supplier} onChange={(e) => { setSupplier(e.target.value); setPreview(null); }}>
                <option value="">Выберите</option>
                {sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Файл CSV" error={fileError ?? undefined}>
            {(id) => <input id={id} type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} className="text-sm file:mr-3 file:h-11 file:border-0 file:bg-concrete file:px-4" />}
          </Field>
        </div>
        {rows ? <p className="mt-3 text-sm">Строк в файле: {rows.length}</p> : null}
        <Button className="mt-4" disabled={!rows || !supplier} loading={busy && !preview} onClick={runPreview}>Проверить файл</Button>

        {preview ? (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge tone="good">Корректных строк: {preview.valid_rows}</Badge>
              <Badge tone={preview.error_rows ? 'bad' : 'neutral'}>С ошибками: {preview.error_rows}</Badge>
              <Badge>Новых предложений: {preview.new_offers}</Badge>
              <Badge tone={preview.price_changes ? 'warn' : 'neutral'}>Изменений цены: {preview.price_changes}</Badge>
            </div>
            {preview.errors.length ? (
              <Table head={['Строка', 'Артикул', 'Ошибки']}>
                {preview.errors.slice(0, 200).map((e) => (
                  <tr key={e.row}><Td className="num">{e.row + 1}</Td><Td className="num">{e.sku ?? '—'}</Td><Td className="text-rust">{e.errors.join('; ')}</Td></tr>
                ))}
              </Table>
            ) : null}
            {preview.new_offers ? <Notice>Новые артикулы создаются как предложения без привязки к товару. Привяжите их в разделе «Поставщики».</Notice> : null}
            <div className="flex flex-wrap gap-2">
              {preview.error_rows === 0
                ? <Button loading={busy} onClick={() => apply(false)}>Применить импорт</Button>
                : preview.valid_rows > 0 ? <Button loading={busy} onClick={() => apply(true)}>Применить только корректные строки</Button> : null}
              <Button variant="secondary" onClick={discard}>Отказаться</Button>
            </div>
          </div>
        ) : null}
      </Section>

      <Section title="Журнал импорта">
        {history.isError ? <ErrorState onRetry={() => void history.refetch()} /> : null}
        {history.isLoading ? <Skeleton className="h-24" /> : null}
        {history.data?.length ? (
          <Table head={['Дата', 'Поставщик', 'Файл', 'Строк', 'Ошибок', 'Статус', '']}>
            {history.data.map((h) => (
              <tr key={h.id}>
                <Td className="whitespace-nowrap">{formatDateTime(h.created_at)}</Td><Td>{h.suppliers?.name}</Td><Td>{h.filename}</Td>
                <Td className="num">{h.valid_rows}/{h.total_rows}</Td><Td className="num">{h.error_rows}</Td><Td>{STATUS[h.status] ?? h.status}</Td>
                <Td>{h.status === 'applied' ? <Button size="sm" variant="ghost" onClick={() => rollback(h.id)}>Отменить импорт</Button> : null}</Td>
              </tr>
            ))}
          </Table>
        ) : history.data ? <p className="text-sm text-graphite">Импортов ещё не было.</p> : null}
      </Section>
    </AdminPage>
  );
}
