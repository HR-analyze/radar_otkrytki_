import type { DepartureSummary } from '@/lib/queries';
import { formatClock, formatDuration, shortDate } from '@/lib/time';
import { plural } from '@/lib/plural';
import { StatusBadge } from '@/components/Status';

/**
 * Выезд с РЦ — сетевой показатель.
 *
 * Стоит отдельным блоком, а не среди критериев лавок, потому что к лавкам он и
 * не привязан: в выгрузке по РЦ лавок нет, а водители склада и водители,
 * отмечающиеся в лавках, — почти разные люди. Смешать их в одну цифру значило
 * бы соврать.
 *
 * Время на фабрике (приезд → выезд) показывается справочно и в балл не входит:
 * балл заказчик задал только за время убытия.
 */
export function DepartureBlock({
  data,
  greenUntil,
  yellowUntil,
  zones,
}: {
  data: DepartureSummary;
  greenUntil: string;
  yellowUntil: string;
  zones: { green: number; yellow: number; red: number };
}) {
  const total = data.green + data.yellow + data.red;

  return (
    <section className="surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Выезд с {data.units.join(', ') || 'РЦ'}</h2>
        <span className="text-xs muted">
          🟢 до {greenUntil} — {zones.green} {plural(zones.green, 'балл', 'балла', 'баллов')} · 🟡 до{' '}
          {yellowUntil} — {zones.yellow} · 🔴 позже — {zones.red}
        </span>
      </div>
      <p className="mt-0.5 text-xs muted">
        Во сколько машины ушли со склада. Показатель сетевой: лавок в выгрузке нет, поэтому в
        статусы лавок он не входит.
      </p>

      <div className="mt-3 flex flex-wrap items-baseline gap-4 text-sm">
        <Count label="до срока" value={data.green} total={total} tone="green" />
        <Count label="впритык" value={data.yellow} total={total} tone="yellow" />
        <Count label="позже" value={data.red} total={total} tone="red" />
        {data.score != null && (
          <StatusBadge status={data.status}>
            балл {data.score.toFixed(2).replace('.', ',')}
          </StatusBadge>
        )}
        <span className="text-xs muted" title="Медиана времени от приезда на фабрику до выезда">
          на фабрике: <b className="tabular-nums">{formatDuration(data.medianStay)}</b> (медиана)
        </span>
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
            <th className="pb-1.5 pr-3 text-right font-medium">Выезд</th>
            <th className="pb-1.5 pr-3 text-right font-medium">На фабрике</th>
            <th className="pb-1.5 pr-3 text-right font-medium">🟢</th>
            <th className="pb-1.5 pr-3 text-right font-medium">🟡</th>
            <th className="pb-1.5 pr-3 text-right font-medium">🔴</th>
            <th className="pb-1.5 text-right font-medium">Балл</th>
          </tr>
        </thead>
        <tbody>
          {data.days.map((d) => (
            <tr key={d.date} className="border-t" style={{ borderColor: 'var(--border)' }}>
              <td className="py-1.5 pr-3 tabular-nums">{shortDate(d.date)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums muted">{formatClock(d.median)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums muted">
                {formatDuration(d.medianStay)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{d.green}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{d.yellow}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{d.red}</td>
              <td className="py-1.5 text-right">
                {d.score == null ? (
                  <span className="muted">—</span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <span className={`dot-${d.status} inline-block size-2 rounded-full`} />
                    {d.score.toFixed(2).replace('.', ',')}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-xs muted">
        «Выезд» и «на фабрике» — медианы за день. Время на фабрике справочное, в балл не входит.
      </p>

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
                <span className="min-w-0 flex-1 truncate">{l.employeeName}</span>
                <span
                  className="shrink-0 tabular-nums muted"
                  title="Времени на фабрике: приезд → выезд"
                >
                  {formatDuration(l.stay)}
                </span>
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
