import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { haptic } from '@/lib/telegram';

type Tone = 'success' | 'error' | 'info';
interface Toast { id: number; text: string; tone: Tone }
const Ctx = createContext<(text: string, tone?: Tone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, text, tone }]);
    if (tone !== 'info') haptic(tone === 'success' ? 'success' : 'error');
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[calc(var(--safe-top)+8px)] z-[60] flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto w-full max-w-[488px] animate-fade px-4 py-3 text-sm shadow-[0_8px_24px_rgba(0,0,0,.18)]',
            t.tone === 'error' ? 'bg-rust text-white' : 'bg-ink text-paper')}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
