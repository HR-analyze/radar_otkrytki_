import type { DepartureSummary } from '@/lib/queries';
import { formatClock, shortDate } from '@/lib/time';
import { plural } from '@/lib/plural';

/**
 * Выезд с РЦ — сетевой показатель.
 *
 * Стоит отдельным блоком, а не среди критериев лавок, потому что к лавкам он и
 * не привязан: в выгрузке по РЦ лавок нет, а водители склада и водители,
 * отмечающиеся в лавках, — почти разные люди. Смешать их в одну цифру значило
 * бы соврать.
 */
export function DepartureBlock({
  data,
  greenUntil,
  yellowUntil,
}: {
  data: DepartureSummary;
  greenUntil: string;
  yellowUntil: string;
}) {
  const total = data.green + data.yellow + data.red;

  return (
    <section className="surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Выезд с {data.units.join(', ') || 'РЦ'}</h2>
        <span className="text-xs muted">
          🟢 до {greenUntil} · 🟡 до {yellowUntil} · дальше 🔴
        </span>
      </div>
      <p className="mt-0.5 text-xs muted">
        Во сколько машины ушли со склада. Показатель сетевой: лавок в выгрузке нет, поэтому в
        статусы лавок он не входит.
      </p>

      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <Count label="до срока" value={data.green} total={total} tone="green" />
        <Count label="впритык" value={data.yellow} total={total} tone="yellow" />
        <Count label="позже" value={data.red} total={total} tone="red" />
        {data.unknown > 0 && (
          <span className="text-xs muted" title="Есть приход на РЦ, но нет отметки об уходе">
            без отметки об уходе: {data.unknown}
          </span>
        )}
      </div>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-xs muted">
            <th className="pb-1.5 pr-3 text-left font-medium">День</th>
            <th className="pb-1.5 pr-3 text-right font-medium">Медиана</th>
            <th className="pb-1.5 pr-3 text-right font-medium">🟢</th>
            <th className="pb-1.5 pr-3 text-right font-medium">🟡</th>
            <th className="pb-1.5 text-right font-medium">🔴</th>
          </tr>
        </thead>
        <tbody>
          {data.days.map((d) => (
            <tr key={d.date} className="border-t" style={{ borderColor: 'var(--border)' }}>
              <td className="py-1.5 pr-3 tabular-nums">{shortDate(d.date)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums muted">{formatClock(d.median)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{d.green}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{d.yellow}</td>
              <td className="py-1.5 text-right tabular-nums">{d.red}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.late.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-semibold">
            Выехали позже {yellowUntil} — {data.late.length}{' '}
            {plural(data.late.length, 'выезд', 'выезда', 'выездов')}
          </h3>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs">
            {data.late.slice(0, 12).map((l) => (
              <li key={`${l.date}-${l.employeeName}`} className="flex gap-3">
                <span className="w-12 shrink-0 tabular-nums muted">{shortDate(l.date)}</span>
                <span className="w-12 shrink-0 tabular-nums">{formatClock(l.minutes)}</span>
                <span className="min-w-0 truncate">{l.employeeName}</span>
              </li>
            ))}
          </ul>
          {data.late.length > 12 && (
            <p className="mt-1 text-xs muted">…и ещё {data.late.length - 12}</p>
          )}
        </>
      )}
    </section>
  );
}

function Count({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: 'green' | 'yellow' | 'red';
}) {
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`dot-${tone} inline-block size-2 rounded-full`} />
      <b className="tabular-nums">{value}</b>
      <span className="text-xs muted">
        {label} · {share}%
      </span>
    </span>
  );
}
