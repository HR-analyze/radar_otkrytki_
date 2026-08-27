import Link from 'next/link';
import type { Status } from '@/lib/types';

export const STATUS_TEXT: Record<Status, string> = {
  green: 'Зелёная',
  yellow: 'Жёлтая',
  red: 'Красная',
  other_schedule: 'Другой график',
  no_data: 'Нет данных',
};

export function StatusBadge({ status, children }: { status: Status; children?: React.ReactNode }) {
  return (
    <span
      className={`st-${status} inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap`}
    >
      <span className={`dot-${status} inline-block size-1.5 rounded-full`} />
      {children ?? STATUS_TEXT[status]}
    </span>
  );
}

/** Ячейка таблицы-радара. */
export function StatusCell({
  status,
  href,
  title,
}: {
  status: Status;
  href?: string;
  title?: string;
}) {
  const inner = (
    <span
      className={`st-${status} flex h-7 w-full items-center justify-center rounded text-[11px] font-semibold`}
    >
      {status === 'red' ? '🔴' : status === 'yellow' ? '🟡' : status === 'green' ? '🟢' : '·'}
    </span>
  );

  return (
    <td className="px-0.5 py-0.5" title={title}>
      {href ? <Link href={href}>{inner}</Link> : inner}
    </td>
  );
}

/** Горизонтальная полоса 🟢/🟡/🔴 с подписями. */
export function StatusBar({
  green,
  yellow,
  red,
  missing = 0,
}: {
  green: number;
  yellow: number;
  red: number;
  missing?: number;
}) {
  const total = green + yellow + red + missing || 1;
  const seg = (n: number, cls: string, label: string) =>
    n > 0 ? (
      <div
        className={cls}
        style={{ width: `${(n / total) * 100}%` }}
        title={`${label}: ${n}`}
      />
    ) : null;

  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--neutral-soft)' }}>
      {seg(green, 'dot-green', 'Зелёные')}
      {seg(yellow, 'dot-yellow', 'Жёлтые')}
      {seg(red, 'dot-red', 'Красные')}
    </div>
  );
}
