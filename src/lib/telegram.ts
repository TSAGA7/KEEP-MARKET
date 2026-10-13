// Обёртка над официальным Telegram WebApp API (https://core.telegram.org/bots/webapps).
// initDataUnsafe НЕ используется для авторизации: на сервер уходит исходная строка initData.

interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  isExpanded: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  disableVerticalSwipes?(): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  openLink(url: string, opts?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  isVersionAtLeast(v: string): boolean;
  onEvent(event: string, cb: () => void): void;
  offEvent(event: string, cb: () => void): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void; isVisible: boolean };
  HapticFeedback?: { impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void; notificationOccurred(t: 'error' | 'success' | 'warning'): void; selectionChanged(): void };
}

declare global {
  interface Window { Telegram?: { WebApp?: TgWebApp } }
}

export function tg(): TgWebApp | null {
  const w = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
  return w ?? null;
}

/** true — приложение открыто внутри Telegram (есть подписанные данные запуска) */
export function isInsideTelegram(): boolean {
  return !!tg()?.initData;
}

export function getInitData(): string {
  return tg()?.initData ?? '';
}

export function getStartParam(): string | null {
  const fromTg = tg()?.initDataUnsafe?.start_param;
  if (fromTg) return fromTg; // используется только для навигации, не для авторизации
  const url = new URL(window.location.href);
  return url.searchParams.get('tgWebAppStartParam') ?? url.searchParams.get('startapp');
}

export function applyTheme(): 'light' | 'dark' {
  const w = tg();
  const dark = w ? w.colorScheme === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  const bg = theme === 'dark' ? '#000000' : '#ffffff';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  try {
    if (w?.isVersionAtLeast('6.1')) {
      w.setHeaderColor?.(bg);
      w.setBackgroundColor?.(bg);
    }
    if (w?.isVersionAtLeast('7.10')) w.setBottomBarColor?.(bg);
  } catch {
    /* старые клиенты Telegram */
  }
  return theme;
}

export function initTelegram(onThemeChange: () => void) {
  const w = tg();
  if (!w) return;
  w.ready();
  w.expand();
  try {
    if (w.isVersionAtLeast('7.7')) w.disableVerticalSwipes?.();
  } catch { /* noop */ }
  w.onEvent('themeChanged', onThemeChange);
}

export function haptic(kind: 'success' | 'error' | 'light' | 'select') {
  const h = tg()?.HapticFeedback;
  if (!h) return;
  try {
    if (kind === 'success' || kind === 'error') h.notificationOccurred(kind);
    else if (kind === 'select') h.selectionChanged();
    else h.impactOccurred('light');
  } catch { /* noop */ }
}

/** Открыть ссылку t.me внутри Telegram, иначе — в новой вкладке */
export function openTelegramLink(url: string) {
  const w = tg();
  if (w && /^https:\/\/t\.me\//.test(url)) {
    w.openTelegramLink(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function openExternalLink(url: string) {
  const w = tg();
  if (w) w.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
