'use client';

import { useMemo, useState } from 'react';
import type { DepartureDriver, DepartureShop, DepartureTrip } from '@/lib/queries';
import type { Status } from '@/lib/types';
import { formatClock, formatDuration, shortDate } from '@/lib/time';
import { plural } from '@/lib/plural';
import { STATUS_TEXT } from '@/components/Status';
import { ClearButton } from './ClearButton';

type Zone = Extract<Status, 'red' | 'yellow' | 'green'>;

const ZONES: { key: Zone; label: string }[] = [
  { key: 'red', label: '🔴 Красные' },
  { key: 'yellow', label: '🟡 Жёлтые' },
  { key: 'green', label: '🟢 Зелёные' },
];

/** «Ё» и регистр не должны мешать: «Пётр» ищется и как «петр». */
function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').trim();
}

/**
 * Таблица «кто какой балл получил» с фильтром.
 *
 * Фильтр живёт в браузере, без запроса на сервер: водителей сотня, данные уже
 * на странице, а перезагружать всю сводку ради одной таблицы — долго.
 *
 * Поиск — по ФИО или коду лавки: «М17» покажет всех, кто в ней отмечался.
 * Зона — по баллу водителя за период, а не по отдельным выездам.
 */
export function DriverTable({
  drivers,
  dates,
}: {
  drivers: DepartureDriver[];
  dates: string[];
}) {
  const [query, setQuery] = useState('');
  const [zone, setZone] = useState<Zone | null>(null);

  const counts = useMemo(() => {
    const c: Record<Zone, number> = { red: 0, yellow: 0, green: 0 };
    for (const dr of drivers) if (dr.status in c) c[dr.status as Zone]++;
    return c;
  }, [drivers]);

  const shown = useMemo(() => {
    const q = norm(query);
    return drivers.filter((dr) => {
      if (zone && dr.status !== zone) return false;
      if (!q) return true;
      return (
        norm(dr.employeeName).includes(q) ||
        dr.shops.some((s) => norm(s.code) === q || norm(s.name).includes(q))
      );
    });
  }, [drivers, query, zone]);

  const filtered = query.trim() !== '' || zone !== null;

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder="ФИО или лавка (М17)"
            aria-label="Фильтр водителей: ФИО или код лавки"
            className="w-full rounded-lg border px-3 py-1.5 pr-8 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          />
          {query && <ClearButton onClick={() => setQuery('')} label="Сбросить поиск водителя" />}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {ZONES.map((z) => {
            const on = zone === z.key;
            return (
              <button
                key={z.key}
                type="button"
                onClick={() => setZone(on ? null : z.key)}
                aria-pressed={on}
                className={`rounded-md border px-2.5 py-1 text-xs ${on ? 'font-semibold' : 'muted hover:opacity-70'}`}
                style={{
                  borderColor: on ? 'var(--focus)' : 'var(--border)',
                  color: on ? 'var(--text)' : undefined,
                  background: on ? 'color-mix(in srgb, var(--focus) 10%, transparent)' : undefined,
                }}
              >
                {z.label} · {counts[z.key]}
              </button>
            );
          })}
        </div>

        {filtered && (
          <span className="text-xs muted">
            показано {shown.length} из {drivers.length}
          </span>
        )}
      </div>

      <div className="radar-scroll mt-2">
        <table className="radar-table w-full text-sm">
          <thead>
            <tr>
              <th className="radar-sticky px-3 py-2 text-left text-xs font-medium muted">
                Водитель
              </th>
              <th
                className="px-2 py-2 text-left text-xs font-medium muted"
                title="Где за период стоит его отметка водителя — по полному ФИО. Чаще всего — первой"
              >
                Лавки
              </th>
              <th className="px-2 py-2 text-right text-xs font-medium muted">Балл</th>
              <th className="px-2 py-2 text-right text-xs font-medium muted">Выездов</th>
              <th
                className="px-2 py-2 text-right text-xs font-medium muted"
                title="Строки, где приход на РЦ есть, а отметки об уходе нет: во сколько человек выехал — неизвестно, балл по ним не ставится"
              >
                Без ухода
              </th>
              <th className="hidden px-2 py-2 text-right text-xs font-medium muted sm:table-cell">
                На фабрике
              </th>
              {dates.map((d) => (
                <th key={d} className="px-1 py-2 text-center text-xs font-medium muted">
                  {shortDate(d)}
                </th>
              ))}
              <th className="w-full" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td className="radar-sticky px-3 py-3 text-xs muted whitespace-nowrap">
                  Никого не нашлось — поменяй запрос или сбрось зону.
                </td>
                <td colSpan={dates.length + 6} />
              </tr>
            )}
            {shown.map((dr) => (
              <tr key={dr.employeeName}>
                <td className="radar-sticky px-3 py-1 whitespace-nowrap" title={dr.employeeName}>
                  {dr.employeeName}
                </td>
                <ShopsCell shops={dr.shops} />
                <td className="px-2 py-1 text-right whitespace-nowrap">
                  {dr.score == null ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 tabular-nums">
                      <span className={`dot-${dr.status} inline-block size-2 rounded-full`} />
                      {dr.score.toFixed(2).replace('.', ',')}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 text-right text-xs whitespace-nowrap tabular-nums muted">
                  {dr.trips}
                </td>
                <td
                  className="px-2 py-1 text-right text-xs whitespace-nowrap tabular-nums muted"
                  title={
                    dr.unknown > 0
                      ? `${dr.unknown} ${plural(dr.unknown, 'отметка', 'отметки', 'отметок')} прихода на РЦ без ухода — балл по ним не ставится`
                      : undefined
                  }
                >
                  {dr.unknown || ''}
                </td>
                <td className="hidden px-2 py-1 text-right text-xs whitespace-nowrap tabular-nums muted sm:table-cell">
                  {formatDuration(dr.medianStay)}
                </td>
                {dates.map((d) => (
                  <TripCell key={d} name={dr.employeeName} date={d} trips={dr.days[d]} />
                ))}
                <td aria-hidden />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Лавки водителя: коды через запятую, названия и число дней — в подсказке. */
function ShopsCell({ shops }: { shops: DepartureShop[] }) {
  if (shops.length === 0) {
    return (
      <td
        className="px-2 py-1 text-xs muted"
        title="За период в лавках не отмечался: в выгрузке по РЦ лавок нет, а других данных о маршруте нет"
      >
        —
      </td>
    );
  }

  return (
    <td
      className="px-2 py-1 text-xs whitespace-nowrap"
      title={shops
        .map((s) => `${s.name} — ${s.days} ${plural(s.days, 'день', 'дня', 'дней')}`)
        .join('\n')}
    >
      {shops.map((s) => s.code).join(', ')}
    </td>
  );
}

/** Клетка дня: обычно один выезд, но иногда водитель выезжает дважды. */
function TripCell({
  name,
  date,
  trips,
}: {
  name: string;
  date: string;
  trips: DepartureTrip[] | undefined;
}) {
  if (!trips || trips.length === 0) return <td className="px-1 py-0.5" />;

  return (
    <td className="px-1 py-0.5">
      <span className="flex flex-col items-center gap-0.5">
        {trips.map((t, i) => (
          <span
            key={i}
            className={`st-${t.status} block w-full rounded px-1 py-0.5 text-center text-[11px] font-semibold tabular-nums whitespace-nowrap`}
            title={tripTitle(name, date, t)}
          >
            {t.minutes == null ? '·' : formatClock(t.minutes)}
          </span>
        ))}
      </span>
    </td>
  );
}

function tripTitle(name: string, date: string, t: DepartureTrip): string {
  const parts = [`${name} · ${shortDate(date)}`];
  parts.push(
    t.minutes == null
      ? 'приход на РЦ есть, отметки об уходе нет'
      : `выезд ${formatClock(t.minutes)} · ${STATUS_TEXT[t.status]} · ${t.score} ` +
        `${plural(t.score ?? 0, 'балл', 'балла', 'баллов')}`,
  );
  if (t.stay != null) parts.push(`на фабрике ${formatDuration(t.stay)}`);
  return parts.join(' · ');
}
