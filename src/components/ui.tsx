// Базовые элементы интерфейса KEEP MARKET
import { forwardRef, useEffect, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { IconAlert, IconCheck, IconClose } from './icons';
import { formatRub } from '@shared/money';

// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, block, className, children, disabled, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 font-medium transition-[background,opacity,transform] active:scale-[0.985] disabled:opacity-40 disabled:active:scale-100',
        size === 'sm' && 'h-9 px-3 text-sm',
        size === 'md' && 'h-11 px-4 text-base',
        size === 'lg' && 'h-[52px] px-5 text-md',
        variant === 'primary' && 'bg-ink text-paper',
        variant === 'secondary' && 'bg-concrete text-ink',
        variant === 'ghost' && 'bg-transparent text-ink underline-offset-4 hover:underline',
        variant === 'danger' && 'bg-transparent text-rust ring-1 ring-inset ring-rust/40',
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <span role="status" aria-label="Загрузка" className={clsx('inline-block animate-spin rounded-full border-2 border-current border-r-transparent', className ?? 'h-5 w-5')} />;
}

// ---------------------------------------------------------------------------
interface FieldProps { label: string; error?: string; hint?: string; children: (id: string) => ReactNode; optional?: boolean }
export function Field({ label, error, hint, children, optional }: FieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm text-graphite">
        {label}{optional ? <span className="text-fog"> — необязательно</span> : null}
      </label>
      {children(id)}
      {error ? <p className="text-sm text-rust" role="alert">{error}</p> : hint ? <p className="text-sm text-fog">{hint}</p> : null}
    </div>
  );
}

const inputCls = 'w-full bg-concrete px-3.5 text-base text-ink placeholder:text-fog outline-none ring-1 ring-inset ring-transparent focus:ring-ink aria-[invalid=true]:ring-rust';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={clsx(inputCls, 'h-11', className)} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={clsx(inputCls, 'min-h-[88px] py-2.5', className)} {...p} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return <select ref={ref} className={clsx(inputCls, 'h-11 appearance-none pr-8', className)} {...p}>{children}</select>;
});

export function Checkbox({ checked, onChange, children, id }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; id?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm leading-5">
      <span className="relative mt-0.5 h-5 w-5 shrink-0">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 h-5 w-5 cursor-pointer appearance-none bg-concrete ring-1 ring-inset ring-fog checked:bg-ink checked:ring-ink" />
        <IconCheck size={16} strokeWidth={2.6} className="pointer-events-none absolute left-0.5 top-0.5 hidden text-paper peer-checked:block" />
      </span>
      <span>{children}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
export function Chip({ active, children, onClick, disabled, title }: { active?: boolean; children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} aria-pressed={active}
      className={clsx('h-9 shrink-0 px-3.5 text-sm transition-colors',
        active ? 'bg-ink text-paper' : 'bg-concrete text-ink',
        disabled && 'text-fog line-through decoration-fog/70 opacity-70')}>
      {children}
    </button>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'ink'; children: ReactNode }) {
  return (
    <span className={clsx('inline-flex h-6 items-center px-2 text-xs font-medium',
      tone === 'neutral' && 'bg-concrete text-graphite',
      tone === 'good' && 'bg-moss/15 text-moss',
      tone === 'warn' && 'bg-amber/15 text-amber',
      tone === 'bad' && 'bg-rust/15 text-rust',
      tone === 'ink' && 'bg-ink text-paper')}>
      {children}
    </span>
  );
}

export function DemoBadge() {
  return <Badge tone="warn">Демо</Badge>;
}

export function Price({ kopecks, className }: { kopecks: number | null | undefined; className?: string }) {
  return <span className={clsx('num whitespace-nowrap', className)}>{formatRub(kopecks)}</span>;
}

// ---------------------------------------------------------------------------
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('animate-pulse bg-concrete', className)} />;
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-14">
      <p className="font-display text-lg">{title}</p>
      {text ? <p className="max-w-[34ch] text-graphite">{text}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ text = 'Не удалось загрузить данные. Проверьте соединение.', onRetry }: { text?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mx-4 my-6 flex items-start gap-3 bg-rust/10 p-4 text-sm">
      <IconAlert className="shrink-0 text-rust" />
      <div className="flex flex-col items-start gap-2">
        <p>{text}</p>
        {onRetry ? <button className="font-medium underline underline-offset-4" onClick={onRetry}>Повторить</button> : null}
      </div>
    </div>
  );
}

export function Notice({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'warn' | 'good' | 'bad'; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('p-4 text-sm leading-5',
      tone === 'neutral' && 'bg-concrete',
      tone === 'warn' && 'bg-amber/12 text-ink',
      tone === 'good' && 'bg-moss/12',
      tone === 'bad' && 'bg-rust/10', className)}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label="Закрыть" className="absolute inset-0 animate-fade bg-black/45" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-shop animate-sheet flex-col bg-paper pb-safeb">
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <h2 className="font-display text-md">{title}</h2>
          <button onClick={onClose} aria-label="Закрыть" className="-mr-2 p-2"><IconClose /></button>
        </div>
        <div className="overflow-y-auto px-4 pb-4">{children}</div>
        {footer ? <div className="border-t border-line px-4 py-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 pb-3 pt-8">
      <h2 className="font-display text-lg">{children}</h2>
      {action}
    </div>
  );
}

export function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="inline-flex h-10 items-center bg-concrete" role="group" aria-label={label}>
      <button type="button" className="h-10 w-10 text-lg disabled:opacity-30" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label="Меньше">−</button>
      <span className="num w-8 text-center" aria-live="polite">{value}</span>
      <button type="button" className="h-10 w-10 text-lg disabled:opacity-30" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label="Больше">+</button>
    </div>
  );
}
