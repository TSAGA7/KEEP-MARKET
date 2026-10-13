// Способы доставки и интерфейс ShippingProvider.
// На первом этапе выбор доставки — это ПРЕДПОЧТЕНИЕ покупателя: заказ перевозчику не передаётся,
// реальные пункты выдачи не выдумываются. Адаптеры с API подключаются постепенно (isIntegrated=true).
import { z } from 'zod';

export const DELIVERY_METHODS = [
  'cdek_pickup', 'cdek_courier', 'ozon_pickup', 'russian_post', 'yandex_delivery', 'keep_courier_moscow',
] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export type DeliveryKind = 'pickup' | 'address' | 'moscow_courier';

export interface PickupPoint {
  id: string;
  name: string;
  address: string;
  city: string;
  workHours?: string;
}

export interface ShippingQuote {
  costKopecks: number;
  daysMin: number;
  daysMax: number;
}

/** Адаптер службы доставки. Методы с API опциональны — без них работает ручной режим. */
export interface ShippingProvider {
  readonly method: DeliveryMethod;
  readonly carrier: 'cdek' | 'ozon' | 'russian_post' | 'yandex' | 'keep_courier';
  readonly title: string;
  readonly kind: DeliveryKind;
  readonly description: string;
  /** true — подключён официальный API/виджет перевозчика; false — ручной режим с последующим согласованием */
  readonly isIntegrated: boolean;
  searchPickupPoints?(city: string): Promise<PickupPoint[]>;
  quote?(params: { city: string; postalCode?: string; weightGrams: number }): Promise<ShippingQuote | null>;
}

class ManualProvider implements ShippingProvider {
  readonly isIntegrated = false;
  constructor(
    readonly method: DeliveryMethod,
    readonly carrier: ShippingProvider['carrier'],
    readonly title: string,
    readonly kind: DeliveryKind,
    readonly description: string,
  ) {}
}

export const SHIPPING_PROVIDERS: Record<DeliveryMethod, ShippingProvider> = {
  cdek_pickup: new ManualProvider('cdek_pickup', 'cdek', 'СДЭК — пункт выдачи', 'pickup',
    'Укажите удобный пункт выдачи СДЭК — менеджер проверит возможность отправки и согласует стоимость.'),
  cdek_courier: new ManualProvider('cdek_courier', 'cdek', 'СДЭК — курьер', 'address',
    'Курьерская доставка СДЭК до двери. Стоимость и срок согласует менеджер.'),
  ozon_pickup: new ManualProvider('ozon_pickup', 'ozon', 'Ozon Доставка', 'pickup',
    'Доставка в пункт Ozon — доступность способа подтверждается для каждого заказа.'),
  russian_post: new ManualProvider('russian_post', 'russian_post', 'Почта России', 'address',
    'Отправка Почтой России. Понадобится почтовый индекс.'),
  yandex_delivery: new ManualProvider('yandex_delivery', 'yandex', 'Яндекс Доставка', 'address',
    'Доступные способы Яндекс Доставки (в том числе ранее связанные с Boxberry) — по согласованию с менеджером.'),
  keep_courier_moscow: new ManualProvider('keep_courier_moscow', 'keep_courier', 'Курьер KEEP MARKET по Москве', 'moscow_courier',
    'Собственная курьерская доставка в пределах Москвы.'),
};

export function enabledProviders(settings: Partial<Record<DeliveryMethod, boolean>> | null | undefined): ShippingProvider[] {
  return DELIVERY_METHODS.filter((m) => settings?.[m] !== false).map((m) => SHIPPING_PROVIDERS[m]);
}

export const DELIVERY_INTERVALS = ['10:00–14:00', '14:00–18:00', '18:00–22:00'] as const;

const text = (min: number, max: number, msg: string) => z.string().trim().min(min, msg).max(max, 'Слишком длинное значение');
const optionalText = (max: number) => z.string().trim().max(max, 'Слишком длинное значение').optional().or(z.literal(''));

export const pickupAddressSchema = z.object({
  pickup_mode: z.enum(['widget', 'manual']),
  city: text(2, 80, 'Укажите город'),
  pickup_point_id: optionalText(64),
  pickup_point_name: optionalText(160),
  pickup_point_address: text(3, 300, 'Укажите адрес пункта выдачи'),
  instructions: optionalText(500),
}).refine((a) => a.pickup_mode !== 'widget' || !!a.pickup_point_id, { message: 'Выберите пункт выдачи', path: ['pickup_point_id'] });

export const streetAddressSchema = z.object({
  city: text(2, 80, 'Укажите город'),
  street: text(2, 160, 'Укажите улицу'),
  house: text(1, 20, 'Укажите дом'),
  building: optionalText(20),
  apartment: optionalText(20),
  postal_code: z.string().trim().regex(/^\d{6}$/, 'Индекс — 6 цифр').optional().or(z.literal('')),
  instructions: optionalText(500),
});

export const postAddressSchema = streetAddressSchema.extend({
  postal_code: z.string().trim().regex(/^\d{6}$/, 'Индекс — 6 цифр'),
});

export const moscowCourierAddressSchema = z.object({
  full_address: text(8, 300, 'Укажите полный адрес'),
  entrance: optionalText(10),
  floor: optionalText(10),
  intercom: optionalText(20),
  courier_comment: optionalText(500),
  preferred_interval: z.enum(DELIVERY_INTERVALS).optional().or(z.literal('')),
});

export function addressSchemaFor(method: DeliveryMethod) {
  switch (method) {
    case 'cdek_pickup':
    case 'ozon_pickup':
      return pickupAddressSchema;
    case 'russian_post':
      return postAddressSchema;
    case 'cdek_courier':
    case 'yandex_delivery':
      return streetAddressSchema;
    case 'keep_courier_moscow':
      return moscowCourierAddressSchema;
  }
}

/** Краткое описание адреса для карточки заказа */
export function formatAddress(method: DeliveryMethod, a: Record<string, unknown> | null | undefined): string {
  if (!a) return '';
  const s = (k: string) => (typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string).trim() : null);
  const kind = SHIPPING_PROVIDERS[method]?.kind;
  if (kind === 'pickup') {
    return [s('city'), s('pickup_point_name'), s('pickup_point_address'), a.pickup_mode === 'manual' ? '(указан вручную, требует согласования)' : null]
      .filter(Boolean).join(', ');
  }
  if (kind === 'moscow_courier') {
    return [s('full_address'), s('entrance') && `подъезд ${s('entrance')}`, s('floor') && `этаж ${s('floor')}`,
      s('intercom') && `домофон ${s('intercom')}`, s('preferred_interval') && `интервал ${s('preferred_interval')}`].filter(Boolean).join(', ');
  }
  return [s('postal_code'), s('city'), s('street'), s('house') && `д. ${s('house')}`, s('building') && `корп./стр. ${s('building')}`,
    s('apartment') && `кв./оф. ${s('apartment')}`].filter(Boolean).join(', ');
}
