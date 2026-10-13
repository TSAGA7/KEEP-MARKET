import { describe, expect, it, vi } from 'vitest';
import {
  MockPaymentProvider, YooKassaProvider, WebhookVerificationError, createPaymentProvider,
  decimalStringToKopecks, ipInAllowList, kopecksToDecimalString,
} from '@shared/payments';

const SECRET = 'mock-secret-for-tests-1234567890';

describe('mock-провайдер', () => {
  const p = new MockPaymentProvider(SECRET, 'http://localhost:5173/dev/mock-payment');

  it('создаёт тестовую ссылку и принимает только подписанные уведомления', async () => {
    const res = await p.createPayment({ paymentId: 'abc', idempotencyKey: 'k', amountKopecks: 1000, orderNumber: 'KM-1', description: 'd', returnUrl: 'x' });
    expect(res.providerPaymentId).toBe('mock_abc');
    expect(res.confirmationUrl).toContain('/dev/mock-payment?payment=mock_abc');
    const body = JSON.stringify({ event_id: 'e1', type: 'payment.succeeded', payment_id: 'mock_abc', amount_kopecks: 1000 });
    const ev = await p.verifyWebhook({ headers: { 'x-mock-signature': await p.sign(body) }, rawBody: body });
    expect(ev).toMatchObject({ kind: 'payment', status: 'succeeded', amountKopecks: 1000, eventKey: 'e1' });
  });

  it('отклоняет уведомление с неверной подписью или изменённым телом', async () => {
    const body = JSON.stringify({ event_id: 'e1', type: 'payment.succeeded', payment_id: 'mock_abc', amount_kopecks: 1000 });
    const sig = await p.sign(body);
    await expect(p.verifyWebhook({ headers: { 'x-mock-signature': 'deadbeef' }, rawBody: body })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(p.verifyWebhook({ headers: { 'x-mock-signature': sig }, rawBody: body.replace('1000', '1') })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(p.verifyWebhook({ headers: {}, rawBody: body })).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('запрещён в production', () => {
    expect(() => createPaymentProvider({ PAYMENT_PROVIDER: 'mock', MOCK_PAYMENT_SECRET: SECRET })).toThrow('MOCK_PROVIDER_FORBIDDEN_IN_PRODUCTION');
    expect(() => createPaymentProvider({ APP_ENV: 'production', PAYMENT_PROVIDER: 'mock', MOCK_PAYMENT_SECRET: SECRET })).toThrow();
    expect(createPaymentProvider({ APP_ENV: 'development', PAYMENT_PROVIDER: 'mock', MOCK_PAYMENT_SECRET: SECRET })?.isTest).toBe(true);
    expect(createPaymentProvider({ PAYMENT_PROVIDER: 'none' })).toBeNull();
  });
});

describe('ЮKassa адаптер (без реальной сети)', () => {
  function provider(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof YooKassaProvider>[0]> = {}) {
    return new YooKassaProvider({ shopId: '123', secretKey: 'test_key', fetchImpl, ...extra });
  }

  it('создание платежа: сумма строкой с копейками, ключ идемпотентности, данные чека', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.amount).toEqual({ value: '3400.00', currency: 'RUB' });
      expect(body.capture).toBe(true);
      expect(body.receipt.items).toHaveLength(2);
      expect(body.receipt.items[1].payment_subject).toBe('service');
      expect((init?.headers as Record<string, string>)['Idempotence-Key']).toBe('idem-1');
      return new Response(JSON.stringify({ id: 'yk-1', status: 'pending', amount: { value: '3400.00', currency: 'RUB' }, paid: false,
        confirmation: { confirmation_url: 'https://yoomoney.ru/checkout/x' } }), { status: 200 });
    });
    const p = provider(fetchMock as unknown as typeof fetch, { sendReceipt: true });
    const r = await p.createPayment({ paymentId: 'p1', idempotencyKey: 'idem-1', amountKopecks: 340000, orderNumber: 'KM-1', description: 'Заказ',
      returnUrl: 'https://x', customerEmail: 'a@b.ru', receiptItems: [{ description: 'Футболка', quantity: 1, amountKopecks: 300000 }], deliveryKopecks: 40000 });
    expect(r).toEqual({ providerPaymentId: 'yk-1', confirmationUrl: 'https://yoomoney.ru/checkout/x', status: 'pending' });
  });

  it('уведомление проверяется повторным запросом в API: тело уведомления не доверенное', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.yookassa.ru/v3/payments/2a8f1b3c-000f-5000-9000-1b3c4d5e6f70');
      // API говорит: платёж ещё не оплачен, хотя уведомление утверждает обратное
      return new Response(JSON.stringify({ id: '2a8f1b3c-000f-5000-9000-1b3c4d5e6f70', status: 'pending', paid: false, amount: { value: '10.00', currency: 'RUB' } }));
    });
    const p = provider(fetchMock as unknown as typeof fetch);
    const ev = await p.verifyWebhook({ headers: {}, rawBody: JSON.stringify({ type: 'notification', event: 'payment.succeeded',
      object: { id: '2a8f1b3c-000f-5000-9000-1b3c4d5e6f70', status: 'succeeded' } }) });
    expect(ev).toMatchObject({ kind: 'payment', status: 'pending', amountKopecks: 1000 });
  });

  it('IP вне списка — отказ', async () => {
    const p = provider((async () => new Response('{}')) as unknown as typeof fetch, { allowedIps: ['185.71.76.0/27'] });
    await expect(p.verifyWebhook({ headers: {}, rawBody: '{}', remoteIp: '8.8.8.8' })).rejects.toBeInstanceOf(WebhookVerificationError);
    expect(ipInAllowList('185.71.76.10', ['185.71.76.0/27'])).toBe(true);
    expect(ipInAllowList('185.71.76.40', ['185.71.76.0/27'])).toBe(false);
    expect(ipInAllowList('77.75.156.11', ['77.75.156.11'])).toBe(true);
  });

  it('преобразование сумм без float-ошибок', () => {
    expect(kopecksToDecimalString(1)).toBe('0.01');
    expect(kopecksToDecimalString(123456)).toBe('1234.56');
    expect(decimalStringToKopecks('0.1')).toBe(10);
    expect(decimalStringToKopecks('19.99')).toBe(1999);
    expect(() => decimalStringToKopecks('1e5')).toThrow();
  });
});

import { receiptWithDiscount } from '@shared/payments';
describe('чек со скидкой', () => {
  it('сумма позиций чека равна сумме после скидки', () => {
    const items = [{ description: 'A', quantity: 2, amountKopecks: 1999 }, { description: 'B', quantity: 1, amountKopecks: 5001 }];
    const out = receiptWithDiscount(items, 777);
    const total = out.reduce((a, i) => a + i.amountKopecks * i.quantity, 0);
    expect(total).toBe(2 * 1999 + 5001 - 777);
    expect(out.every((i) => Number.isInteger(i.amountKopecks) && i.amountKopecks >= 0)).toBe(true);
    expect(receiptWithDiscount(items, 0)).toEqual(items);
  });
});
