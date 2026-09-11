import Link from 'next/link';
import type { Status } from '@/lib/types';

export const STATUS_TEXT: Record<Status, string> = {
  green: 'Зелёная',
  yellow: 'Жёлтая',
  red: 'Красная',
  other_schedule: 'Другой график',
  no_data: 'Нет данных',
};

/**
 * Подписи фильтра «Статус». Живут здесь, а не в Filters: те же слова сводка
 * показывает под заголовком, и разъехаться эти два места не должны.
 */
export const STATUS_FILTER_TITLE: Record<Status, string> = {
  red: '🔴 Только красные',
  yellow: '🟡 Есть жёлтые',
  green: '🟢 Есть зелёные',
  other_schedule: '🕘 Другой график',
  no_data: '· Без данных',
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

/**
 * Ячейка таблицы-радара.
 *
 * Значок и подложка несут один и тот же смысл, но программа чтения с экрана
 * читала бы «красный круг» — это про картинку, а не про лавку. Поэтому у
 * ссылки есть полная подпись: лавка, день, статус.
 *
 * Высота 1.75rem на телефоне мала для пальца, поэтому там ячейка выше: 44
 * пикселя — та величина, ниже которой промахиваются мимо соседнего дня.
 */
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
      aria-hidden
      className={`st-${status} flex h-11 w-full items-center justify-center rounded text-[11px] font-semibold sm:h-7`}
    >
      {status === 'red' ? '🔴' : status === 'yellow' ? '🟡' : status === 'green' ? '🟢' : '·'}
    </span>
  );

  return (
    <td className="px-0.5 py-0.5" title={title}>
      {href ? (
        <Link href={href} aria-label={title ?? STATUS_TEXT[status]}>
          {inner}
        </Link>
      ) : (
        <span role="img" aria-label={title ?? STATUS_TEXT[status]}>
          {inner}
        </span>
      )}
    </td>
  );
}

/**
 * Горизонтальная полоса 🟢/🟡/🔴 с подписями.
 *
 * Весь смысл полосы был в цвете: программа чтения с экрана видела три пустых
 * div и молчала, а `title` на неинтерактивном элементе она не читает. Даём
 * полосе роль изображения и подпись словами — «🟢 12 · 🟡 3 · 🔴 5».
 */
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

  const words = [
    green > 0 && `зелёных ${green}`,
    yellow > 0 && `жёлтых ${yellow}`,
    red > 0 && `красных ${red}`,
    missing > 0 && `без данных ${missing}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      role="img"
      aria-label={words || 'нет данных'}
      className="flex h-2 w-full overflow-hidden rounded-full"
      style={{ background: 'var(--neutral-soft)' }}
    >
      {seg(green, 'dot-green', 'Зелёные')}
      {seg(yellow, 'dot-yellow', 'Жёлтые')}
      {seg(red, 'dot-red', 'Красные')}
    </div>
  );
}

/**
 * Расшифровка обозначений радара.
 *
 * Что означает точка «·» в ячейке, не было написано нигде: её читали как
 * «ноль» или как «плохо», хотя это «данных за день нет» — разница между
 * претензией к лавке и претензией к выгрузке.
 */
export function StatusLegend({ note }: { note?: string }) {
  const items: { status: Status; text: string }[] = [
    { status: 'green', text: 'в норме' },
    { status: 'yellow', text: 'на границе' },
    { status: 'red', text: 'нарушение' },
    { status: 'no_data', text: 'нет данных за день' },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs muted">
      {items.map((i) => (
        <span key={i.status} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`st-${i.status} flex size-4 items-center justify-center rounded text-[9px]`}
          >
            {i.status === 'red' ? '🔴' : i.status === 'yellow' ? '🟡' : i.status === 'green' ? '🟢' : '·'}
          </span>
          {i.text}
        </span>
      ))}
      {/* Подсказка про клики — длинная, и на телефоне она съедала две строки
          из тех немногих, что достались таблице. Там она и не нужна: пальцем
          по ячейке всё равно тыкают, а заголовок виден. */}
      {note && <span className="hidden sm:inline">{note}</span>}
    </div>
  );
}
