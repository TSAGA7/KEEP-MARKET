import type { OrderStatus, PaymentStatus, PaymentMethod, ItemAvailability } from '@shared/orders';
import type { DeliveryMethod } from '@shared/delivery';

export type StockState = 'in_stock' | 'needs_confirmation' | 'out_of_stock';

export interface CatalogProduct {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  category_id: string | null;
  category_slug: string | null;
  category_name: string | null;
  brand_name: string | null;
  sku: string;
  price_kopecks: number;
  min_price_kopecks: number;
  max_price_kopecks: number;
  materials: string | null;
  care: string | null;
  size_chart: { columns: string[]; rows: string[][] } | null;
  origin_description: string | null;
  is_featured: boolean;
  is_demo: boolean;
  published_at: string | null;
  cover_ref: string | null;
  total_stock: number;
  stock_confirmed_at: string | null;
  stock_state: StockState;
  sizes: string[];
  colors: string[];
}

export interface CatalogVariant {
  id: string;
  product_id: string;
  sku: string;
  size: string | null;
  color: string | null;
  color_hex: string | null;
  price_kopecks: number;
  stock_qty: number;
  stock_confirmed_at: string | null;
  min_qty: number;
  max_qty: number;
  sort_order: number;
  stock_state: StockState;
}

export interface CatalogImage { id: string; product_id: string; image_ref: string; alt: string | null; sort_order: number }
export interface Category { id: string; parent_id: string | null; name: string; slug: string; sort_order: number }
export interface Banner { id: string; title: string; subtitle: string | null; image_ref: string | null; link_type: string; link_value: string | null; is_demo: boolean }
export interface Collection { id: string; slug: string; title: string; description: string | null; is_demo: boolean }

export interface Profile {
  id: string;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  photo_url: string | null;
  bot_connected: boolean;
  consent_pd_version: string | null;
}

export type StaffRole = 'owner' | 'admin' | 'manager';

export interface Order {
  id: string;
  number: string;
  customer_id: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod | null;
  delivery_method: DeliveryMethod;
  items_total_kopecks: number;
  discount_kopecks: number;
  delivery_kopecks: number | null;
  total_kopecks: number;
  customer_comment: string | null;
  manager_notes?: string | null;
  agreed_terms: { eta_text?: string; delivery_note?: string; payment_method?: string; checked_at?: string };
  requires_customer_confirmation: boolean;
  cancel_reason: string | null;
  issue_reason: string | null;
  assigned_manager_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  variant_id: string | null;
  title_snapshot: string;
  product_sku_snapshot: string;
  variant_sku_snapshot: string;
  size: string | null;
  color: string | null;
  image_url_snapshot: string | null;
  unit_price_kopecks: number;
  original_unit_price_kopecks: number;
  price_change_reason: string | null;
  quantity: number;
  line_total_kopecks: number;
  stock_was_fresh: boolean;
  availability: ItemAvailability;
  availability_note: string | null;
}

export interface OrderHistory { id: number; order_id: string; from_status: string | null; to_status: string; reason: string | null; visible_to_customer: boolean; changed_by: string | null; created_at: string }
export interface Shipment { id: string; order_id: string; carrier: string; tracking_number: string | null; status: string; shipped_at: string | null; delivered_at: string | null; cost_kopecks: number | null; notes: string | null }
export interface Payment { id: string; order_id: string; provider: string; status: string; amount_kopecks: number; refunded_kopecks: number; created_at: string; paid_at: string | null; is_test: boolean; failure_reason: string | null; confirmation_url: string | null }
