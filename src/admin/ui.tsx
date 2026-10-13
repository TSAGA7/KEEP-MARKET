// Общие элементы админ-панели
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { IconChevronLeft } from '@/components/icons';

export function AdminPage({ title, actions, children, back }: { title: ReactNode; actions?: ReactNode; children: ReactNode; back?: string }) {
  return (
    <div className="pb-16">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-4 pt-5 lg:px-8">
        <div className="flex items-center gap-2">
          {back ? <Link to={back} aria-label="Назад" className="-ml-2 p-2"><IconChevronLeft /></Link> : null}
          <h1 className="font-display text-xl">{title}</h1>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      <div className="px-4 lg:px-8">{children}</div>
    </div>
  );
}

/** Таблица: на широком экране — таблица, на телефоне — горизонтальная прокрутка */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-x-auto border border-line', className)}>
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-concrete text-graphite">
          <tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2.5 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={clsx('px-3 py-2.5 align-top', className)}>{children}</td>;
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="border-t border-line py-6 first:border-t-0 first:pt-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-md">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-40 shrink-0 text-graphite">{k}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}
