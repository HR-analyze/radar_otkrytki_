import Link from 'next/link';
import type { ShowcaseNote } from '@/lib/queries';
import { shortDate } from '@/lib/time';
import { plural } from '@/lib/plural';

/**
 * Сводка комментариев за месяц.
 *
 * Комментарии пишут по одному, в разные дни и по разным лавкам, а читать их
 * потом нужно вместе: «что вообще происходило в сентябре». Перелистывать ради
 * этого тридцать дней в редакторе — не вариант.
 *
 * Месяц, а не произвольный период: справочники и отчётность у заказчика
 * месячные, и на вкладке уже есть свой выбор дня — второй календарь рядом
 * только путал бы.
 */
export function NotesSummary({
  notes,
  month,
  prev,
  next,
}: {
  notes: ShowcaseNote[];
  month: string;
  prev: string;
  next: string;
}) {
  const shops = new Set(notes.map((n) => n.shopCode)).size;

  return (
    <section className="surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold">Комментарии</h2>

        <div className="flex items-center gap-1">
          <MonthLink month={prev} label="←" title="Предыдущий месяц" />
          <span className="min-w-36 text-center text-sm font-medium">{monthName(month)}</span>
          <MonthLink month={next} label="→" title="Следующий месяц" />
        </div>

        {notes.length > 0 && (
          <span className="text-xs muted">
            {notes.length} {plural(notes.length, 'комментарий', 'комментария', 'комментариев')} у{' '}
            {shops} {plural(shops, 'лавки', 'лавок', 'лавок')}
          </span>
        )}
      </div>

      {notes.length === 0 ? (
        <p className="mt-3 text-sm muted">
          За этот месяц комментариев нет. Их оставляют в списке выше, рядом с процентом.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs muted">
                <th className="pb-1.5 pr-3 text-left font-medium">Дата</th>
                <th className="pb-1.5 pr-3 text-left font-medium">Лавка</th>
                <th className="pb-1.5 pr-3 text-left font-medium">РМ</th>
                <th className="pb-1.5 pr-3 text-right font-medium">Витрина</th>
                <th className="pb-1.5 text-left font-medium">Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((n) => (
                <tr
                  key={`${n.date}-${n.shopCode}`}
                  className="border-t align-top"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">
                    {shortDate(n.date)}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <Link
                      href={`/shop/${encodeURIComponent(n.shopCode)}?from=${n.date}&to=${n.date}`}
                      className="hover:underline"
                    >
                      {n.shopName}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3 text-xs whitespace-nowrap muted">{n.region ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums muted">
                    {n.percent == null ? '—' : `${n.percent}%`}
                  </td>
                  <td className="py-1.5">{n.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MonthLink({ month, label, title }: { month: string; label: string; title: string }) {
  return (
    <Link
      href={`/showcase?month=${month}`}
      title={title}
      aria-label={title}
      className="rounded-lg border px-2 py-1 text-sm"
      style={{ borderColor: 'var(--border)' }}
      scroll={false}
    >
      {label}
    </Link>
  );
}

/** «2026-09» → «сентябрь 2026». */
function monthName(month: string): string {
  const [year, m] = month.split('-');
  const date = new Date(Number(year), Number(m) - 1, 1);
  return date.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
}
