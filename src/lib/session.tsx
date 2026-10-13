// Сессия: вход через Telegram initData → Edge Function auth-telegram → JWT в памяти.
// Токен хранится в sessionStorage только на время жизни вкладки/вебвью, чтобы пережить перезагрузку страницы.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { callFunction, setAccessToken, ApiError } from './supabase';
import { getInitData, isInsideTelegram } from './telegram';
import { config, isConfigured } from './config';
import type { Profile, StaffRole } from './types';

type Status = 'loading' | 'authenticated' | 'guest' | 'error';

interface SessionState {
  status: Status;
  profile: Profile | null;
  roles: StaffRole[];
  error: string | null;
  startParam: string | null;
  isStaff: boolean;
  isAdmin: boolean;
  isOwner: boolean;
  insideTelegram: boolean;
  retry: () => void;
}

const Ctx = createContext<SessionState | null>(null);
const STORAGE_KEY = 'km.session.v1';

interface AuthResponse {
  access_token: string;
  expires_at: number;
  start_param: string | null;
  roles: StaffRole[];
  profile: Profile;
}

function loadStored(initData: string): AuthResponse | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AuthResponse & { init_hash: string };
    // Сессия действительна только для того же запуска Telegram и не истекла (с запасом 5 минут)
    if (s.init_hash !== hashString(initData) || s.expires_at * 1000 < Date.now() + 300_000) return null;
    return s;
  } catch {
    return null;
  }
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SessionState, 'retry' | 'isStaff' | 'isAdmin' | 'isOwner' | 'insideTelegram'>>({
    status: 'loading', profile: null, roles: [], error: null, startParam: null,
  });
  const attempt = useRef(0);
  const initData = getInitData() || config.devInitData;
  const insideTelegram = isInsideTelegram() || !!config.devInitData;

  const authenticate = useCallback(async () => {
    attempt.current += 1;
    if (!initData || !isConfigured) {
      setAccessToken(null);
      setState({ status: 'guest', profile: null, roles: [], error: null, startParam: null });
      return;
    }
    const stored = loadStored(initData);
    if (stored) {
      setAccessToken(stored.access_token);
      setState({ status: 'authenticated', profile: stored.profile, roles: stored.roles, error: null, startParam: stored.start_param });
      return;
    }
    setState((s) => ({ ...s, status: 'loading', error: null }));
    try {
      const r = await callFunction<AuthResponse>('auth-telegram', { initData });
      setAccessToken(r.access_token);
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...r, init_hash: hashString(initData) }));
      } catch { /* sessionStorage недоступен */ }
      setState({ status: 'authenticated', profile: r.profile, roles: r.roles, error: null, startParam: r.start_param });
    } catch (e) {
      setAccessToken(null);
      setState({ status: 'error', profile: null, roles: [], error: e instanceof ApiError ? e.code : 'NETWORK_ERROR', startParam: null });
    }
  }, [initData]);

  useEffect(() => {
    void authenticate();
  }, [authenticate]);

  // Перевыпуск токена до истечения срока
  useEffect(() => {
    if (state.status !== 'authenticated') return;
    const t = window.setTimeout(() => {
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
      void authenticate();
    }, 6 * 3600 * 1000);
    return () => window.clearTimeout(t);
  }, [state.status, authenticate]);

  const value = useMemo<SessionState>(() => ({
    ...state,
    insideTelegram,
    isOwner: state.roles.includes('owner'),
    isAdmin: state.roles.includes('owner') || state.roles.includes('admin'),
    isStaff: state.roles.length > 0,
    retry: () => {
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
      void authenticate();
    },
  }), [state, insideTelegram, authenticate]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
