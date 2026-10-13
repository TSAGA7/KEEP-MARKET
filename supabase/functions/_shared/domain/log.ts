// Маскирование чувствительных данных перед записью в логи
const SENSITIVE_KEYS = /^(phone|email|recipient_name|full_address|street|house|apartment|address|first_name|last_name|username|init_?data|token|access_token|authorization|secret|password|card|pan|cvv|passport)/i;

export function maskPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const d = p.replace(/\D/g, '');
  if (d.length < 6) return '***';
  return `${d.slice(0, 2)}*****${d.slice(-2)}`;
}

export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.test(k)) {
        out[k] = k.toLowerCase().includes('phone') && typeof v === 'string' ? maskPhone(v) : '[masked]';
      } else {
        out[k] = maskSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Ошибка для клиента: только код, без внутренних деталей, SQL и персональных данных */
export function publicErrorCode(message: string | undefined | null): string {
  if (!message) return 'INTERNAL_ERROR';
  const m = message.match(/\b([A-Z][A-Z0-9_]{3,60})\b/);
  return m ? (m[1] as string) : 'INTERNAL_ERROR';
}
