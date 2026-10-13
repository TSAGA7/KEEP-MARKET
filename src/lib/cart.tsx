// Корзина хранится локально (localStorage). Цена, наличие и сумма окончательно пересчитываются сервером.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cartTotals, clampQty, type CartLine } from '@shared/checkout';

const KEY = 'km.cart.v1';

interface CartState {
  lines: CartLine[];
  count: number;
  add: (line: CartLine) => void;
  setQty: (variantId: string, qty: number) => void;
  remove: (variantId: string) => void;
  replace: (lines: CartLine[]) => void;
  clear: () => void;
}

const Ctx = createContext<CartState | null>(null);

function load(): CartLine[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CartLine[];
    return Array.isArray(parsed) ? parsed.filter((l) => typeof l?.variantId === 'string' && Number.isInteger(l.quantity)).slice(0, 30) : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(load);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* приватный режим */ }
  }, [lines]);

  const add = useCallback((line: CartLine) => {
    setLines((prev) => {
      const existing = prev.find((l) => l.variantId === line.variantId);
      if (existing) {
        return prev.map((l) => (l.variantId === line.variantId ? { ...line, quantity: clampQty(l.quantity + line.quantity, line) } : l));
      }
      return [...prev, { ...line, quantity: clampQty(line.quantity, line) }].slice(0, 30);
    });
  }, []);

  const setQty = useCallback((variantId: string, qty: number) => {
    setLines((prev) => prev.map((l) => (l.variantId === variantId ? { ...l, quantity: clampQty(qty, l) } : l)));
  }, []);

  const remove = useCallback((variantId: string) => setLines((prev) => prev.filter((l) => l.variantId !== variantId)), []);
  const replace = useCallback((next: CartLine[]) => setLines(next), []);
  const clear = useCallback(() => setLines([]), []);

  const value = useMemo<CartState>(() => ({
    lines, count: cartTotals(lines.filter((l) => l.stockState !== 'out_of_stock')).itemsCount, add, setQty, remove, replace, clear,
  }), [lines, add, setQty, remove, replace, clear]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart(): CartState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCart outside CartProvider');
  return v;
}
