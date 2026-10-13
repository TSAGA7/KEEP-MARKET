// Запросы к витрине и заказам. Только публичные представления (catalog_*) и данные, разрешённые RLS.
import { db, callFunction } from './supabase';
import type { Banner, CatalogImage, CatalogProduct, CatalogVariant, Category, Collection, Order, OrderHistory, OrderItem, Payment, Shipment } from './types';
import type { CreateOrderInput, CreateOrderResponse } from '@shared/checkout';

function check<T>(r: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export interface CatalogQuery {
  q?: string;
  category?: string;
  priceMin?: number;
  priceMax?: number;
  sizes?: string[];
  colors?: string[];
  sort?: 'new' | 'price_asc' | 'price_desc';
  collection?: string;
  inStock?: boolean;
  limit?: number;
  offset?: number;
}

export async function searchCatalog(p: CatalogQuery): Promise<CatalogProduct[]> {
  return check(await db().rpc('catalog_search', {
    p_query: p.q || null,
    p_category_slug: p.category || null,
    p_price_min: p.priceMin ?? null,
    p_price_max: p.priceMax ?? null,
    p_sizes: p.sizes?.length ? p.sizes : null,
    p_colors: p.colors?.length ? p.colors : null,
    p_sort: p.sort ?? 'new',
    p_limit: p.limit ?? 24,
    p_offset: p.offset ?? 0,
    p_collection_slug: p.collection || null,
    p_in_stock_only: p.inStock ?? false,
  })) as CatalogProduct[];
}

export async function catalogFilters(category?: string): Promise<{ sizes: string[]; colors: string[]; price_min: number | null; price_max: number | null; count: number }> {
  return check(await db().rpc('catalog_filters', { p_category_slug: category || null }));
}

export async function popularProducts(): Promise<CatalogProduct[]> {
  return check(await db().rpc('catalog_popular', { p_limit: 8 })) as CatalogProduct[];
}

export async function similarProducts(productId: string): Promise<CatalogProduct[]> {
  return check(await db().rpc('catalog_similar', { p_product_id: productId, p_limit: 8 })) as CatalogProduct[];
}

export async function getProduct(slug: string): Promise<{ product: CatalogProduct; variants: CatalogVariant[]; images: CatalogImage[] } | null> {
  const product = check(await db().from('catalog_products').select('*').eq('slug', slug).maybeSingle()) as CatalogProduct | null;
  if (!product) return null;
  const [variants, images] = await Promise.all([
    db().from('catalog_variants').select('*').eq('product_id', product.id).order('sort_order'),
    db().from('catalog_images').select('*').eq('product_id', product.id).order('sort_order'),
  ]);
  return { product, variants: check(variants) as CatalogVariant[], images: check(images) as CatalogImage[] };
}

export async function productsByIds(ids: string[]): Promise<CatalogProduct[]> {
  if (!ids.length) return [];
  return check(await db().from('catalog_products').select('*').in('id', ids)) as CatalogProduct[];
}

export async function variantsByIds(ids: string[]): Promise<CatalogVariant[]> {
  if (!ids.length) return [];
  return check(await db().from('catalog_variants').select('*').in('id', ids)) as CatalogVariant[];
}

export async function getCategories(): Promise<Category[]> {
  return check(await db().from('catalog_categories').select('*').order('sort_order')) as Category[];
}

export async function getBanners(): Promise<Banner[]> {
  return check(await db().from('catalog_banners').select('*').order('sort_order')) as Banner[];
}

export async function getCollections(): Promise<Collection[]> {
  return check(await db().from('catalog_collections').select('*').order('sort_order')) as Collection[];
}

export type PublicSettings = Record<string, unknown>;
export async function getPublicSettings(): Promise<PublicSettings> {
  const rows = check(await db().from('public_settings').select('key, value')) as Array<{ key: string; value: unknown }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---- Избранное (только для вошедших через Telegram) ----
export async function getFavoriteIds(): Promise<string[]> {
  const rows = check(await db().from('favorites').select('product_id').order('created_at', { ascending: false })) as Array<{ product_id: string }>;
  return rows.map((r) => r.product_id);
}
export async function setFavorite(userId: string, productId: string, on: boolean): Promise<void> {
  if (on) check(await db().from('favorites').upsert({ user_id: userId, product_id: productId }, { onConflict: 'user_id,product_id', ignoreDuplicates: true }));
  else check(await db().from('favorites').delete().eq('product_id', productId));
}

// ---- Заказы покупателя ----
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResponse> {
  return callFunction<CreateOrderResponse>('create-order', input, { allowConflict: true });
}

export async function myOrders(): Promise<Order[]> {
  return check(await db().from('orders').select('*').order('created_at', { ascending: false }).limit(50)) as Order[];
}

export interface OrderDetail {
  order: Order;
  items: OrderItem[];
  history: OrderHistory[];
  shipments: Shipment[];
  payments: Payment[];
  contact: { recipient_name: string; phone: string; email: string | null; address: Record<string, unknown> } | null;
}

export async function orderDetail(id: string): Promise<OrderDetail | null> {
  const order = check(await db().from('orders').select('*').eq('id', id).maybeSingle()) as Order | null;
  if (!order) return null;
  const [items, history, shipments, payments, contact] = await Promise.all([
    db().from('order_items').select('*').eq('order_id', id).order('created_at'),
    db().from('order_status_history').select('*').eq('order_id', id).order('id'),
    db().from('shipments').select('*').eq('order_id', id).order('created_at'),
    db().from('payments').select('id, order_id, provider, status, amount_kopecks, refunded_kopecks, created_at, paid_at, is_test, failure_reason, confirmation_url').eq('order_id', id).order('created_at'),
    db().from('order_contacts').select('recipient_name, phone, email, address').eq('order_id', id).maybeSingle(),
  ]);
  return {
    order,
    items: check(items) as OrderItem[],
    history: check(history) as OrderHistory[],
    shipments: check(shipments) as Shipment[],
    payments: check(payments) as Payment[],
    contact: check(contact) as OrderDetail['contact'],
  };
}

export async function orderAction(orderId: string, action: string, payload: Record<string, unknown> = {}) {
  return callFunction<{ status: string; customer_notified?: boolean }>('order-action', { order_id: orderId, action, payload });
}

export async function startPayment(orderId: string) {
  return callFunction<{ payment_id: string; confirmation_url: string; amount_kopecks: number; test: boolean }>('payment-create', { order_id: orderId });
}
