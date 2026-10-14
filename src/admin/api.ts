// Запросы админ-панели. Доступ определяет RLS и SQL-функции (роль проверяется на сервере);
// скрытие разделов в интерфейсе — только удобство.
import { db, callFunction } from '@/lib/supabase';

export function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  return check(await db().rpc(fn, args)) as T;
}

export interface AdminProduct {
  id: string; slug: string; title: string; description: string | null; category_id: string | null; brand_name: string | null;
  sku: string; price_kopecks: number; discount_percent: number; materials: string | null; care: string | null; size_chart: unknown; origin_description: string | null;
  weight_grams: number | null; length_mm: number | null; width_mm: number | null; height_mm: number | null;
  is_featured: boolean; is_demo: boolean; status: 'draft' | 'pending_review' | 'published' | 'hidden' | 'archived';
  supplier_id: string | null; supplier_documents_reference: string | null; trademark_review_status: string; compliance_status: string;
  compliance_notes: string | null; reviewed_at: string | null; reviewed_by: string | null; internal_notes: string | null;
  published_at: string | null; created_at: string; updated_at: string;
}

export interface AdminVariant {
  id: string; product_id: string; sku: string; size: string | null; color: string | null; color_hex: string | null;
  price_override_kopecks: number | null; stock_qty: number; stock_confirmed_at: string | null; min_qty: number; max_qty: number;
  is_active: boolean; sort_order: number;
}

export interface AdminImage {
  id: string; product_id: string; storage_path: string | null; url: string | null; alt: string | null; sort_order: number;
  original_storage_path: string | null; processed_storage_path: string | null;
  processing_status: 'none' | 'pending' | 'processing' | 'done' | 'failed' | 'skipped'; processing_error: string | null;
}
export interface Supplier { id: string; internal_code: string; name: string; contacts: Record<string, string>; notes: string | null; terms: string | null;
  processing_days_min: number | null; processing_days_max: number | null; is_active: boolean; checklist: Record<string, boolean>; created_at: string;
  telegram_chat_id: number | null; telegram_username: string | null }

export const PRODUCT_STATUS_LABEL: Record<AdminProduct['status'], string> = {
  draft: 'Черновик', pending_review: 'На проверке', published: 'Опубликован', hidden: 'Скрыт', archived: 'В архиве',
};
export const REVIEW_STATUS_LABEL: Record<string, string> = {
  pending_review: 'Не проверен', approved: 'Одобрен', rejected: 'Отклонён', needs_more_documents: 'Нужны документы',
};
export const BLOCKER_LABEL: Record<string, string> = {
  COMPLIANCE_NOT_APPROVED: 'Нет одобрения юридической проверки',
  TRADEMARK_NOT_APPROVED: 'Не проверены товарные знаки и обозначения',
  NO_CATEGORY: 'Не выбрана категория',
  NO_PRICE: 'Не указана цена',
  NO_DESCRIPTION: 'Нет описания (минимум 10 символов)',
  NO_IMAGES: 'Нет фотографий',
  NO_VARIANTS: 'Нет активных вариантов (размер/цвет)',
  CREATE_AS_DRAFT_FIRST: 'Сначала сохраните черновик',
};

export async function listProducts(p: { q?: string; status?: string; review?: string }) {
  let query = db().from('products').select('id, slug, title, sku, price_kopecks, status, compliance_status, trademark_review_status, is_demo, category_id, updated_at')
    .order('updated_at', { ascending: false }).limit(200);
  if (p.status) query = query.eq('status', p.status);
  if (p.review === 'pending') query = query.or('compliance_status.neq.approved,trademark_review_status.neq.approved');
  if (p.q) {
    const s = p.q.replace(/[%,()]/g, ' ').trim();
    if (s) query = query.or(`title.ilike.%${s}%,sku.ilike.%${s}%`);
  }
  return check(await query) as Array<Pick<AdminProduct, 'id' | 'slug' | 'title' | 'sku' | 'price_kopecks' | 'status' | 'compliance_status' | 'trademark_review_status' | 'is_demo' | 'category_id' | 'updated_at'>>;
}

/** Количество товаров по статусам (для обзора). Считает сервер, строки не загружаются. */
export async function countProductsByStatus<S extends string>(statuses: S[]): Promise<Record<S, number>> {
  const res = await Promise.all(statuses.map((st) => db().from('products').select('id', { count: 'exact', head: true }).eq('status', st)));
  return Object.fromEntries(res.map((r, i) => { if (r.error) throw r.error; return [statuses[i], r.count ?? 0]; })) as Record<S, number>;
}

/** Удаление товара из архива навсегда: сервер удаляет запись (проверяет роль и статус «В архиве»),
 *  затем убираем файлы фото из хранилища. */
export async function deleteArchivedProduct(id: string) {
  const paths = await rpc<string[]>('admin_delete_archived_product', { p_product_id: id });
  if (paths?.length) await db().storage.from('product-images').remove(paths);
}

export async function getAdminProduct(id: string) {
  const [p, v, i, c, offers] = await Promise.all([
    db().from('products').select('*').eq('id', id).maybeSingle(),
    db().from('product_variants').select('*').eq('product_id', id).order('sort_order').order('size'),
    db().from('product_images').select('*').eq('product_id', id).order('sort_order'),
    db().from('product_costs').select('purchase_price_kopecks').eq('product_id', id).maybeSingle(),
    rpc<Array<{ offer_id: string; supplier_name: string; supplier_sku: string; variant_id: string | null; stock_qty: number; confirmed_at: string | null }>>('staff_offer_availability', { p_product_id: id }),
  ]);
  return {
    product: check(p) as AdminProduct | null,
    variants: check(v) as AdminVariant[],
    images: check(i) as AdminImage[],
    cost: (c.data as { purchase_price_kopecks: number } | null)?.purchase_price_kopecks ?? null,
    costVisible: !c.error,
    offers,
  };
}

export async function adminOrderDetail(id: string) {
  const [o, items, hist, ship, pays] = await Promise.all([
    db().from('orders').select('*').eq('id', id).maybeSingle(),
    db().from('order_items').select('*').eq('order_id', id).order('created_at'),
    db().from('order_status_history').select('*').eq('order_id', id).order('id'),
    db().from('shipments').select('*').eq('order_id', id).order('created_at'),
    db().from('payments').select('*').eq('order_id', id).order('created_at'),
  ]);
  const order = check(o) as Record<string, unknown> | null;
  if (!order) return null;
  const itemIds = ((items.data ?? []) as Array<{ id: string }>).map((x) => x.id);
  // Себестоимость видна только owner/admin (для менеджера RLS вернёт пустой список)
  const costs = itemIds.length ? await db().from('order_item_costs').select('order_item_id, purchase_price_kopecks').in('order_item_id', itemIds) : { data: [] };
  const { data: logistics } = await db().from('order_logistics_costs').select('cost_kopecks').eq('order_id', id).maybeSingle();
  const { data: customer } = await db().from('profiles').select('id, telegram_id, username, first_name, last_name, bot_chat_id').eq('id', order.customer_id as string).maybeSingle();
  return { order, items: check(items), history: check(hist), shipments: check(ship), payments: pays.data ?? [], costs: costs.data ?? [], logisticsCost: logistics ? Number((logistics as { cost_kopecks: number }).cost_kopecks) : null, customer };
}

export const orderAction = (orderId: string, action: string, payload: Record<string, unknown> = {}) =>
  callFunction<{ status: string; customer_notified?: boolean }>('order-action', { order_id: orderId, action, payload });

export const refund = (paymentId: string, amountKopecks: number, reason: string, manualConfirmed?: boolean) =>
  callFunction<{ status: string }>('payment-refund', { payment_id: paymentId, amount_kopecks: amountKopecks, reason, manual_confirmed: manualConfirmed });

/** Загрузка фото в Storage: проверка типа по сигнатуре файла, размера и расширения на клиенте;
 *  на сервере — ограничения бакета (MIME, 5 МБ) и RLS (только owner/admin). */
export async function uploadProductImage(productId: string, file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Файл больше 5 МБ');
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join('');
  let ext: string | null = null;
  let mime = '';
  if (hex.startsWith('ffd8ff')) { ext = 'jpg'; mime = 'image/jpeg'; }
  else if (hex.startsWith('89504e47')) { ext = 'png'; mime = 'image/png'; }
  else if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') { ext = 'webp'; mime = 'image/webp'; }
  if (!ext) throw new Error('Допустимы только JPEG, PNG или WebP');
  const path = `${productId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db().storage.from('product-images').upload(path, file, { contentType: mime, upsert: false, cacheControl: '31536000' });
  if (error) throw new Error(error.message);
  return path;
}

export async function uploadPrivateDocument(ownerType: 'supplier' | 'product', ownerId: string, file: File): Promise<{ path: string; mime: string }> {
  if (file.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ');
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join('');
  let ext: string | null = null; let mime = '';
  if (hex.startsWith('25504446')) { ext = 'pdf'; mime = 'application/pdf'; }
  else if (hex.startsWith('ffd8ff')) { ext = 'jpg'; mime = 'image/jpeg'; }
  else if (hex.startsWith('89504e47')) { ext = 'png'; mime = 'image/png'; }
  if (!ext) throw new Error('Допустимы PDF, JPEG или PNG');
  const path = `${ownerType}/${ownerId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db().storage.from('private-documents').upload(path, file, { contentType: mime, upsert: false });
  if (error) throw new Error(error.message);
  return { path, mime };
}

export async function signedDocumentUrl(path: string): Promise<string> {
  const { data, error } = await db().storage.from('private-documents').createSignedUrl(path, 120);
  if (error || !data) throw new Error(error?.message ?? 'Не удалось получить ссылку');
  return data.signedUrl;
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m;
}
