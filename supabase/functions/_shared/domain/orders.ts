// Статусы заявки и оплаты. Должны совпадать с CHECK-ограничениями и order_transition_allowed() в БД
// (проверяется тестом tests/unit/statuses.test.ts).

export const ORDER_STATUSES = [
  'new', 'checking_availability', 'awaiting_customer_confirmation', 'confirmed', 'supplier_processing',
  'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'issue',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ['unpaid', 'awaiting_payment', 'paid', 'partially_refunded', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ['online', 'manual_transfer', 'cash_on_delivery', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ['checking_availability', 'cancelled', 'issue'],
  checking_availability: ['awaiting_customer_confirmation', 'confirmed', 'cancelled', 'issue'],
  awaiting_customer_confirmation: ['confirmed', 'checking_availability', 'cancelled', 'issue'],
  confirmed: ['supplier_processing', 'awaiting_customer_confirmation', 'cancelled', 'issue'],
  supplier_processing: ['ready_to_ship', 'cancelled', 'issue'],
  ready_to_ship: ['shipped', 'cancelled', 'issue'],
  shipped: ['delivered', 'issue'],
  delivered: ['issue'],
  issue: ['checking_availability', 'awaiting_customer_confirmation', 'confirmed', 'supplier_processing', 'ready_to_ship', 'shipped', 'delivered', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  new: 'Новая заявка',
  checking_availability: 'Проверяем наличие',
  awaiting_customer_confirmation: 'Ждём вашего подтверждения',
  confirmed: 'Подтверждён',
  supplier_processing: 'Передан поставщику',
  ready_to_ship: 'Готов к отправке',
  shipped: 'Отправлен',
  delivered: 'Доставлен',
  cancelled: 'Отменён',
  issue: 'Требует внимания',
};

/** Для админки формулировки другие: «ждём покупателя» и т.п. */
export const ORDER_STATUS_LABEL_STAFF: Record<OrderStatus, string> = {
  ...ORDER_STATUS_LABEL,
  awaiting_customer_confirmation: 'Ждём покупателя',
  issue: 'Проблема',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  unpaid: 'Не оплачен',
  awaiting_payment: 'Ожидает оплаты',
  paid: 'Оплачен',
  partially_refunded: 'Частичный возврат',
  refunded: 'Возвращён',
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  online: 'Онлайн-оплата',
  manual_transfer: 'Перевод по реквизитам',
  cash_on_delivery: 'Оплата при получении',
  other: 'Другое (по согласованию)',
};

export type StaffAction =
  | 'start_check' | 'record_availability' | 'mark_customer_agreed' | 'set_payment_method' | 'send_to_supplier'
  | 'ready_to_ship' | 'ship' | 'set_tracking' | 'deliver' | 'cancel' | 'issue' | 'resolve_issue' | 'add_note' | 'assign_to_me';

export const STAFF_ACTIONS: readonly StaffAction[] = [
  'start_check', 'record_availability', 'mark_customer_agreed', 'set_payment_method', 'send_to_supplier',
  'ready_to_ship', 'ship', 'set_tracking', 'deliver', 'cancel', 'issue', 'resolve_issue', 'add_note', 'assign_to_me',
];

/** Какие основные действия показывать менеджеру в текущем статусе (сервер всё равно проверит). */
export function availableStaffActions(status: OrderStatus): StaffAction[] {
  const common: StaffAction[] = ['add_note'];
  switch (status) {
    case 'new': return ['start_check', 'cancel', 'issue', ...common];
    case 'checking_availability': return ['record_availability', 'cancel', 'issue', ...common];
    case 'awaiting_customer_confirmation': return ['mark_customer_agreed', 'record_availability', 'cancel', 'issue', ...common];
    case 'confirmed': return ['set_payment_method', 'send_to_supplier', 'cancel', 'issue', ...common];
    case 'supplier_processing': return ['ready_to_ship', 'set_payment_method', 'cancel', 'issue', ...common];
    case 'ready_to_ship': return ['ship', 'cancel', 'issue', ...common];
    case 'shipped': return ['set_tracking', 'deliver', 'issue', ...common];
    case 'delivered': return ['issue', ...common];
    case 'issue': return ['resolve_issue', 'cancel', ...common];
    case 'cancelled': return common;
  }
}

export const ITEM_AVAILABILITY_LABEL = {
  unknown: 'Не проверено',
  confirmed: 'В наличии',
  unavailable: 'Нет в наличии',
  replacement_offered: 'Предложена замена',
  waiting: 'Ожидание поставки',
} as const;
export type ItemAvailability = keyof typeof ITEM_AVAILABILITY_LABEL;

/** Человекочитаемые тексты кодов ошибок сервера */
export const ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Войдите через Telegram, чтобы продолжить',
  FORBIDDEN: 'Недостаточно прав для этого действия',
  USER_BLOCKED: 'Аккаунт заблокирован. Свяжитесь с поддержкой',
  ORDER_NOT_FOUND: 'Заказ не найден',
  INVALID_STATE: 'Действие недоступно в текущем статусе заказа',
  INVALID_STATUS_TRANSITION: 'Недопустимый переход статуса',
  REASON_REQUIRED: 'Укажите причину',
  NOTE_REQUIRED: 'Добавьте комментарий',
  PRICE_CHANGE_REASON_REQUIRED: 'Для изменения цены укажите причину',
  ALL_ITEMS_MUST_BE_CHECKED: 'Отметьте наличие по всем позициям',
  ALL_ITEMS_UNAVAILABLE_CANCEL_INSTEAD: 'Все позиции недоступны — отмените заявку с указанием причины',
  PAYMENT_METHOD_REQUIRED: 'Сначала согласуйте способ оплаты',
  PAYMENT_METHOD_NOT_ALLOWED: 'Этот способ оплаты не включён в настройках магазина',
  PAYMENT_REQUIRED_BEFORE_SUPPLIER: 'Для онлайн-оплаты заказ передаётся поставщику только после подтверждённой оплаты',
  REFUND_REQUIRED_BEFORE_CANCEL: 'Заказ оплачен: сначала оформите возврат',
  CANNOT_CANCEL_IN_THIS_STATE: 'Заказ уже передан в работу — для отмены свяжитесь с менеджером',
  CONTACT_MANAGER_TO_CANCEL_PAID_ORDER: 'Заказ оплачен — для отмены свяжитесь с менеджером',
  ONLINE_PAYMENT_DISABLED: 'Онлайн-оплата пока не подключена. Менеджер согласует способ оплаты',
  ONLINE_PAYMENT_NOT_AGREED: 'Способ оплаты ещё не согласован с менеджером',
  ORDER_NOT_CONFIRMED: 'Оплата возможна только после подтверждения наличия',
  DELIVERY_COST_NOT_AGREED: 'Стоимость доставки ещё не согласована',
  ALREADY_PAID: 'Заказ уже оплачен',
  PUBLISH_BLOCKED: 'Публикация невозможна: товар не прошёл проверку или не заполнен',
  COMPLIANCE_FIELDS_REQUIRE_REVIEW: 'Юридический статус меняется только через проверку',
  CHECKLIST_INCOMPLETE: 'Заполните все пункты чек-листа проверки',
  IMPORT_HAS_ERRORS: 'В файле есть ошибки. Исправьте их или примените только корректные строки',
  REFUND_AMOUNT_INVALID: 'Некорректная сумма возврата',
  RATE_LIMITED: 'Слишком много запросов. Попробуйте через минуту',
  INIT_DATA_INVALID: 'Не удалось подтвердить вход через Telegram. Перезапустите приложение',
  INIT_DATA_EXPIRED: 'Сессия Telegram устарела. Закройте и откройте приложение снова',
  CANNOT_CHANGE_OWN_ROLES: 'Нельзя менять собственные роли',
  CANNOT_CHANGE_OWNER: 'Роль владельца не меняется через интерфейс',
  ROLE_NOT_ASSIGNABLE: 'Эту роль нельзя назначить',
};

export function humanizeError(raw: string | undefined | null): string {
  if (!raw) return 'Что-то пошло не так. Попробуйте ещё раз';
  const code = Object.keys(ERROR_MESSAGES).find((k) => raw.includes(k));
  if (code) return ERROR_MESSAGES[code] as string;
  if (raw.startsWith('VALIDATION')) return 'Проверьте правильность заполнения полей';
  return 'Что-то пошло не так. Попробуйте ещё раз';
}
