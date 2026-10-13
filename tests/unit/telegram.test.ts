import { describe, expect, it } from 'vitest';
import { parseStartParam, signInitData, startTargetPath, verifyInitData, escapeTelegramHtml } from '@shared/telegram';
import { issueSessionJwt, verifySessionJwt } from '@shared/jwt';

const BOT_TOKEN = '123456789:TEST_TOKEN_for_unit_tests_only_xxxxxxxx';
const now = 1_760_000_000;
const user = JSON.stringify({ id: 424242, first_name: 'Анна', username: 'anna' });

describe('проверка Telegram initData', () => {
  it('принимает корректно подписанные данные', async () => {
    const initData = await signInitData({ auth_date: String(now - 60), query_id: 'AAE', user, start_param: 'p_demo_tee' }, BOT_TOKEN);
    const r = await verifyInitData(initData, BOT_TOKEN, { maxAgeSeconds: 3600, nowSeconds: now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.user.id).toBe(424242);
      expect(r.startParam).toBe('p_demo_tee');
    }
  });

  it('отклоняет подделку: изменённый пользователь при старом hash', async () => {
    const initData = await signInitData({ auth_date: String(now), user }, BOT_TOKEN);
    const tampered = initData.replace(encodeURIComponent('424242'), encodeURIComponent('1'));
    expect(tampered).not.toBe(initData);
    const r = await verifyInitData(tampered, BOT_TOKEN, { maxAgeSeconds: 3600, nowSeconds: now });
    expect(r).toEqual({ ok: false, error: 'INIT_DATA_INVALID' });
  });

  it('отклоняет данные, подписанные другим ботом', async () => {
    const initData = await signInitData({ auth_date: String(now), user }, '999:OTHER');
    const r = await verifyInitData(initData, BOT_TOKEN, { maxAgeSeconds: 3600, nowSeconds: now });
    expect(r.ok).toBe(false);
  });

  it('отклоняет устаревшие данные и данные «из будущего»', async () => {
    const old = await signInitData({ auth_date: String(now - 7200), user }, BOT_TOKEN);
    expect(await verifyInitData(old, BOT_TOKEN, { maxAgeSeconds: 3600, nowSeconds: now })).toEqual({ ok: false, error: 'INIT_DATA_EXPIRED' });
    const future = await signInitData({ auth_date: String(now + 3600), user }, BOT_TOKEN);
    expect((await verifyInitData(future, BOT_TOKEN, { maxAgeSeconds: 3600, nowSeconds: now })).ok).toBe(false);
  });

  it('отклоняет отсутствие hash, пользователя и ботов', async () => {
    expect((await verifyInitData('auth_date=1&user=%7B%7D', BOT_TOKEN, { maxAgeSeconds: 3600 })).ok).toBe(false);
    expect((await verifyInitData('', BOT_TOKEN, { maxAgeSeconds: 3600 }))).toEqual({ ok: false, error: 'INIT_DATA_MISSING' });
    const noUser = await signInitData({ auth_date: String(now) }, BOT_TOKEN);
    expect(await verifyInitData(noUser, BOT_TOKEN, { maxAgeSeconds: 3600, nowSeconds: now })).toEqual({ ok: false, error: 'INIT_DATA_NO_USER' });
    const bot = await signInitData({ auth_date: String(now), user: JSON.stringify({ id: 5, is_bot: true }) }, BOT_TOKEN);
    expect((await verifyInitData(bot, BOT_TOKEN, { maxAgeSeconds: 3600, nowSeconds: now })).ok).toBe(false);
  });

  it('разбирает start_param только безопасного формата', () => {
    expect(parseStartParam('p_demo_heavy_hoodie')).toEqual({ type: 'product', slug: 'demo-heavy-hoodie' });
    const id = '0b7e1c1e-3f1b-4c0a-9d6e-2a8f1b3c4d5e';
    expect(startTargetPath(parseStartParam(`a_${id}`))).toBe(`/admin/orders/${id}`);
    expect(parseStartParam('o_not-a-uuid')).toBeNull();
    expect(parseStartParam('p_<script>')).toBeNull();
    expect(parseStartParam('x'.repeat(65))).toBeNull();
  });

  it('экранирует HTML для сообщений бота', () => {
    expect(escapeTelegramHtml('<b>&')).toBe('&lt;b&gt;&amp;');
  });
});

describe('JWT сессии', () => {
  const secret = 'x'.repeat(40);
  it('выпускает и проверяет токен', async () => {
    const id = '0b7e1c1e-3f1b-4c0a-9d6e-2a8f1b3c4d5e';
    const { token } = await issueSessionJwt({ userId: id, telegramId: 1, roles: ['manager'], secret, ttlSeconds: 60, issuer: 'keep-market' });
    const c = await verifySessionJwt(token, secret);
    expect(c.sub).toBe(id);
    expect(c.role).toBe('authenticated');
  });

  it('отклоняет токен, подписанный другим секретом, и просроченный', async () => {
    const id = '0b7e1c1e-3f1b-4c0a-9d6e-2a8f1b3c4d5e';
    const { token } = await issueSessionJwt({ userId: id, telegramId: 1, roles: [], secret: 'y'.repeat(40), ttlSeconds: 60, issuer: 'k' });
    await expect(verifySessionJwt(token, secret)).rejects.toThrow();
    const expired = await issueSessionJwt({ userId: id, telegramId: 1, roles: [], secret, ttlSeconds: -10, issuer: 'k' });
    await expect(verifySessionJwt(expired.token, secret)).rejects.toThrow();
  });
});
