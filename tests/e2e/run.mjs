// E2E-сценарий в настоящем браузере (Chromium, мобильный экран 390×844):
// покупатель: главная → каталог → товар → корзина → оформление → заявка без оплаты → мои заказы
// сотрудник: админка → заявка → проверка наличия → согласование → передача поставщику → отправка
// Запуск: npm run test:e2e  (нужны Playwright и Chromium; переменная E2E_SHOTS — куда сохранять скриншоты)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createBackend } from './mock-backend.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE ?? '/opt/npm-tools/node_modules/playwright')); }

const SHOTS = process.env.E2E_SHOTS ?? 'e2e-shots';
mkdirSync(SHOTS, { recursive: true });
const BASE = 'http://localhost:4173/KEEP-MARKET/';
const OWNER_TG = 111;
const CUSTOMER_TG = 222;

const TG_STUB = `(function(){var init=window.__TG_INIT||'';var noop=function(){};window.Telegram={WebApp:{initData:init,initDataUnsafe:{},version:'8.0',platform:'ios',
colorScheme:window.__TG_DARK?'dark':'light',themeParams:{},isExpanded:true,ready:noop,expand:noop,close:noop,setHeaderColor:noop,setBackgroundColor:noop,
setBottomBarColor:noop,disableVerticalSwipes:noop,openLink:function(u){window.__opened=u},openTelegramLink:function(u){window.__opened=u},
isVersionAtLeast:function(){return true},onEvent:noop,offEvent:noop,BackButton:{show:noop,hide:noop,onClick:noop,offClick:noop},
HapticFeedback:{impactOccurred:noop,notificationOccurred:noop,selectionChanged:noop}}};})();`;

function fail(msg) { console.error('E2E FAIL:', msg); process.exitCode = 1; throw new Error(msg); }

async function main() {
  const backend = await createBackend();
  // Сотрудник: профиль + роль владельца (bootstrap через SQL, как в инструкции)
  await backend.db.query(`insert into public.profiles (telegram_id, username, first_name) values ($1, 'owner', 'Владелец')`, [OWNER_TG]);
  await backend.db.query(`select public.bootstrap_owner($1)`, [OWNER_TG]);

  const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'pipe', detached: true, env: { ...process.env, VITE_BASE_PATH: '/KEEP-MARKET/' } });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('preview timeout')), 30000);
    server.stdout.on('data', (d) => { if (String(d).replace(/\x1b\[[0-9;]*m/g, '').includes('4173')) { clearTimeout(t); res(); } });
    setTimeout(() => { clearTimeout(t); res(); }, 5000);
  });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors = [];
  async function newPage(tgId, dark = false) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU' });
    await ctx.addInitScript(([init, d]) => { window.__TG_INIT = init; window.__TG_DARK = d; }, [tgId ? `mock-user:${tgId}` : '', dark]);
    await ctx.route('https://telegram.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: TG_STUB }));
    await ctx.route('http://mock.local/**', (r) => backend.handle(r));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`); });
    return page;
  }
  const shot = (page, name, full = false) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });

  try {
    // ---------------- Покупатель ----------------
    const p = await newPage(CUSTOMER_TG);
    await p.goto(BASE);
    await p.getByText('Новые поступления').waitFor();
    await p.waitForTimeout(400);
    await shot(p, '01-home');
    await shot(p, '01-home-full', true);

    await p.getByRole('link', { name: 'Каталог', exact: true }).click();
    await p.getByRole('heading', { name: 'Каталог' }).waitFor();
    await p.getByRole('link', { name: /Худи из плотного футера/ }).first().waitFor();
    await p.waitForTimeout(300);
    await shot(p, '02-catalog');

    await p.getByRole('link', { name: /Худи из плотного футера/ }).first().click();
    await p.getByRole('heading', { name: 'Худи из плотного футера' }).waitFor();
    await p.getByRole('button', { name: 'Выберите цвет' }).click();
    if (!(await p.getByText('Выберите цвет').first().isVisible())) fail('нет подсказки о выборе варианта');
    await p.getByRole('button', { name: 'Чёрный' }).click();
    await p.getByRole('button', { name: 'XL' }).isDisabled().then((d) => { if (!d) fail('XL (нет в наличии) должен быть недоступен'); });
    await p.getByRole('button', { name: 'M', exact: true }).click();
    await p.waitForTimeout(500);
    await shot(p, '03-product');
    await p.getByRole('button', { name: /Добавить в корзину/ }).click();
    await p.getByText('Добавлено в корзину').waitFor();

    // второй товар
    await p.goto(`${BASE}product/demo-tote-bag`);
    await p.getByRole('heading', { name: 'Сумка-тоут из плотного хлопка' }).waitFor();
    await p.getByRole('button', { name: 'Серый' }).click();
    await p.getByRole('button', { name: /Добавить в корзину/ }).click();

    await p.getByRole('link', { name: /Корзина/ }).click();
    await p.getByRole('button', { name: 'Оформить заказ' }).waitFor();
    await p.waitForTimeout(500);
    await shot(p, '04-cart', true);
    await p.getByRole('button', { name: 'Оформить заказ' }).click();

    await p.getByRole('heading', { name: 'Доставка' }).waitFor();
    await p.getByText('СДЭК — пункт выдачи').click();
    await p.getByLabel('ФИО получателя').fill('Анна Смирнова');
    await p.getByLabel('Телефон').fill('+7 916 123-45-67');
    await p.getByLabel('Город').fill('Москва');
    await p.getByLabel('Адрес пункта выдачи').fill('ул. Сретенка, 12');
    await shot(p, '05-checkout', true);
    await p.getByRole('button', { name: 'Заказать' }).click();
    await p.getByText('Без согласия мы не сможем обработать заявку').waitFor();
    await p.getByRole('checkbox').check();

    // Курьер по Москве — форма меняется
    await p.getByText('Курьер KEEP MARKET по Москве').click();
    await p.getByLabel('Полный адрес в Москве').waitFor();
    await p.getByLabel('Полный адрес в Москве').fill('Москва, ул. Сретенка, д. 12, кв. 4');
    await p.getByRole('button', { name: 'Заказать' }).click();

    await p.getByRole('heading', { name: 'Заявка принята' }).waitFor({ timeout: 15000 });
    const number = (await p.locator('.num').first().textContent())?.trim();
    if (!number?.startsWith('KM-')) fail('нет номера заявки');
    await shot(p, '06-done');
    await p.getByRole('button', { name: /Перейти к менеджеру/ }).click();
    const opened = await p.evaluate(() => window.__opened);
    if (!/^https:\/\/t\.me\/keep_market_test_bot\?start=order_[A-Za-z0-9]+$/.test(opened ?? '')) fail(`ссылка в бота некорректна: ${opened}`);
    if (/Анна|916|Сретенка/.test(opened)) fail('персональные данные в ссылке!');

    const orderRow = await backend.db.query(`select id, status, payment_status from public.orders where number = $1`, [number]);
    if (orderRow.rows[0]?.status !== 'new' || orderRow.rows[0]?.payment_status !== 'unpaid') fail('заявка должна быть new/unpaid');
    const payCount = await backend.db.query(`select count(*)::int c from public.payments`);
    if (payCount.rows[0].c !== 0) fail('платежей быть не должно');
    const orderId = orderRow.rows[0].id;

    await p.getByRole('button', { name: 'Открыть заявку' }).click();
    await p.getByText('Менеджер проверяет наличие у поставщика').waitFor();
    await shot(p, '07-order-customer', true);

    // ---------------- Владелец / менеджер ----------------
    const a = await newPage(OWNER_TG);
    await a.goto(`${BASE}admin`);
    await a.getByText('Новые заявки').first().waitFor();
    await a.waitForTimeout(400);
    await shot(a, '08-admin-dashboard', true);

    await a.goto(`${BASE}admin/orders/${orderId}`);
    await a.getByRole('button', { name: 'Начать проверку наличия' }).click();
    await a.getByRole('button', { name: 'Зафиксировать результат проверки' }).waitFor();
    await a.getByRole('button', { name: 'Показать контакты получателя' }).click();
    await a.getByText('+79161234567').waitFor();
    await a.getByRole('button', { name: 'Зафиксировать результат проверки' }).click();
    const selects = a.getByRole('dialog').getByLabel('Наличие');
    await selects.nth(1).selectOption('unavailable');
    await a.getByRole('dialog').getByLabel('Стоимость доставки, ₽').fill('350');
    await shot(a, '09-admin-availability');
    await a.getByRole('button', { name: 'Сохранить результат' }).click();
    await a.getByText(/Готово: Ждём покупателя/).waitFor();
    await a.waitForTimeout(300);
    await shot(a, '10-admin-order', true);

    // Покупатель подтверждает изменённые условия
    await p.reload();
    await p.getByRole('button', { name: 'Подтвердить заказ' }).click();
    await p.getByText('Заказ подтверждён').first().waitFor();
    await shot(p, '11-order-confirmed', true);

    // Сотрудник: оплата при получении → поставщик → готов → отправка
    await a.reload();
    await a.getByRole('button', { name: 'Согласовать способ оплаты' }).click();
    await a.getByRole('dialog').getByRole('combobox').selectOption('cash_on_delivery');
    await a.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
    await a.getByText(/Готово/).first().waitFor();
    await a.waitForTimeout(300);
    await a.getByRole('button', { name: 'Передать поставщику' }).click();
    await a.getByRole('button', { name: 'Готов к отправке' }).waitFor();
    await a.getByRole('button', { name: 'Готов к отправке' }).click();
    await a.getByRole('button', { name: 'Отправить и внести трек-номер' }).click();
    await a.getByRole('dialog').getByPlaceholder(/Трек-номер/).fill('1234567890');
    await a.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
    await a.getByText(/Готово: Отправлен/).waitFor();

    const final = await backend.db.query(`select status, payment_status, total_kopecks, delivery_kopecks from public.orders where id = $1`, [orderId]);
    const f = final.rows[0];
    if (f.status !== 'shipped' || f.payment_status !== 'unpaid' || Number(f.delivery_kopecks) !== 35000) fail(`итог: ${JSON.stringify(f)}`);

    await p.reload();
    await p.getByText('1234567890').waitFor();
    await shot(p, '12-order-shipped', true);

    // Покупатель не может открыть админку
    await p.goto(`${BASE}admin`);
    await p.getByText('Нет доступа').waitFor();

    // Тёмная тема Telegram и гость вне Telegram
    const d = await newPage(CUSTOMER_TG, true);
    await d.goto(`${BASE}product/demo-oversize-tee`);
    await d.getByRole('heading', { name: /Футболка/ }).waitFor();
    await d.waitForTimeout(500);
    await shot(d, '13-product-dark');
    const g = await newPage(null);
    await g.goto(`${BASE}profile`);
    await g.getByText('Откройте KEEP MARKET в Telegram').waitFor();
    await shot(g, '14-guest-profile');

    console.log(`E2E OK: заявка ${number} прошла путь new → shipped без онлайн-оплаты`);
  } finally {
    if (errors.length) {
      console.error('Ошибки в консоли браузера:\n' + [...new Set(errors)].join('\n'));
      process.exitCode = 1;
    }
    await browser.close();
    try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
  }
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
