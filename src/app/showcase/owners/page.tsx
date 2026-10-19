import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { listShops } from '@/lib/queries';
import { exportCoverage } from '@/lib/rollup';
import { loadSnapshot } from '@/lib/snapshot';
import { readShowcase } from '@/lib/showcase-store';
import { canEditOwners, readOwners } from '@/lib/showcase-owners-store';
import {
  reportDates,
  shopWorks,
  showcaseGaps,
  SLOT_TITLE,
  type OwnerGaps,
  type OwnerSlot,
} from '@/lib/showcase-owners';
import { isOpenOn } from '@/lib/status';
import { dateRange, formatDay, minutesNowMsk, shortDate, todayIso } from '@/lib/time';
import { plural } from '@/lib/plural';
import { ShowcaseOwnersEditor } from '@/components/ShowcaseOwnersEditor';
import { CopyButton } from '@/components/CopyButton';

export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' };
/** Больше квартала за раз не нужно, а таблица на год не читается. */
const MAX_DAYS = 92;

/**
 * Кто не заполнил витрины: по каждому ответственному — сколько замеров
 * пустует за период и какие именно (лавка × день).
 *
 * Раньше это выясняли запросом к базе и картинкой «ФИО → лавки». Теперь
 * список ответственных правится здесь же, внизу страницы, а пропуски
 * считаются по нему на лету (см. showcase-owners.ts).
 *
 * Отчёт считается по ТЕКУЩЕМУ списку: перекинули лавку — её прошлые пропуски
 * тоже переедут к новому человеку. История закреплений не хранится.
 */
export default async function ShowcaseOwnersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const today = todayIso();
  const slot: OwnerSlot = sp.slot === 'morning' ? 'morning' : 'afternoon';

  let from = isoParam(sp.from) ?? `${today.slice(0, 7)}-01`;
  let to = isoParam(sp.to) ?? today;
  if (from > to) [from, to] = [to, from];
  const range = dateRange(from, to < today ? to : today).slice(-MAX_DAYS);
  const cut = range.length > 0 && range[0] !== from;

  const config = loadConfig();
  const [store, owners, shops, active] = await Promise.all([
    readShowcase(),
    readOwners(),
    listShops(),
    listShops(today),
  ]);
  // Рабочие дни лавок — из выгрузок отметок: лавки нет в выгрузке за день —
  // в этот день она не работала (М16 по выходным), замер с неё не спрашиваем.
  const coverage = exportCoverage((await loadSnapshot()).attendance);
  const { dates, todaySkipped } = reportDates(range, today, minutesNowMsk(), slot);

  const report = showcaseGaps({
    owners: owners.owners,
    fills: slot === 'morning' ? store.days : store.afternoon,
    dates,
    shops,
    isOpen: (code, date) => isOpenOn(config, code, date),
    works: (code, date) => shopWorks(coverage, code, date),
  });

  const totalMissing = report.owners.reduce((n, o) => n + o.missingCount, 0);
  const totalExpected = report.owners.reduce((n, o) => n + o.expected, 0);
  const unknown = report.owners.flatMap((o) => o.unknown.map((code) => ({ code, owner: o.name })));
  const period = dates.length
    ? `${shortDate(dates[0])}–${shortDate(dates[dates.length - 1])}`
    : 'период без дней';

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/showcase" className="text-sm muted hover:opacity-70">
          ← Витрины
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Кто не заполнил витрины</h1>
        <p className="mt-1 text-sm muted">
          Пустой замер — значения нет вовсе; 0% считается заполненным. Не спрашиваются закрытые
          лавки и дни, когда лавка не работала: её нет в выгрузке отметок за день, а пока выгрузки
          нет — это её обычный выходной по прошлым неделям. Лавки берутся из списка
          ответственных внизу страницы.
        </p>
      </div>

      <form method="get" className="surface flex flex-wrap items-end gap-3 p-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs muted">С</span>
          <input type="date" name="from" defaultValue={from} max={today} className="rounded-lg border px-2.5 py-2" style={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs muted">По</span>
          <input type="date" name="to" defaultValue={to} max={today} className="rounded-lg border px-2.5 py-2" style={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs muted">Замер</span>
          <select name="slot" defaultValue={slot} className="rounded-lg border px-2.5 py-2" style={FIELD}>
            <option value="afternoon">на 16:00</option>
            <option value="morning">утренний</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-lg border px-3 py-2 font-medium hover:opacity-90"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          Показать
        </button>
      </form>

      <section className="surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              Замер {SLOT_TITLE[slot]} · {period}
            </h2>
            <p className="mt-0.5 text-xs muted">
              {totalExpected === 0
                ? 'Проверять нечего: в периоде нет дней или у ответственных нет лавок.'
                : `Пусто ${totalMissing} из ${totalExpected} ${plural(totalExpected, 'замера', 'замеров', 'замеров')}.`}
              {todaySkipped &&
                ` Сегодня (${shortDate(today)}) не учтено: ${SLOT_TITLE[slot]} ещё не наступило.`}
              {cut && ` Показаны последние ${MAX_DAYS} дней периода.`}
            </p>
          </div>
          {totalMissing > 0 && (
            <CopyButton text={chatText(report.owners, slot, period)} label="Скопировать для чата" />
          )}
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs muted">
                <th className="pb-1.5 font-medium">Ответственный</th>
                <th className="hidden pb-1.5 font-medium sm:table-cell">Лавки</th>
                <th className="pb-1.5 text-right font-medium">Пусто</th>
                <th className="pb-1.5 text-right font-medium">Заполнено</th>
              </tr>
            </thead>
            <tbody>
              {report.owners.map((o) => (
                <OwnerRow key={o.name} owner={o} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(report.unassigned.length > 0 || unknown.length > 0) && (
        <section className="surface p-4 text-sm" style={{ borderColor: 'var(--yellow)' }}>
          {report.unassigned.length > 0 && (
            <p>
              ⚠️ Ни за кем не закреплены:{' '}
              <strong>{report.unassigned.map((s) => s.code).join(', ')}</strong> — их пропуски
              здесь не видны никому.
            </p>
          )}
          {unknown.length > 0 && (
            <p className={report.unassigned.length > 0 ? 'mt-2' : ''}>
              ⚠️ Нет в справочнике радара, в пропуски не идут:{' '}
              {unknown.map((u) => `${u.code} (${u.owner})`).join(', ')}. Такую лавку не заполнить в
              редакторе — проверьте код или дождитесь выгрузки, где она есть.
            </p>
          )}
        </section>
      )}

      {/* key: после сохранения страница перечитывается, и редактор должен
          начать с сохранённого списка, а не со своих черновиков. */}
      <ShowcaseOwnersEditor
        key={owners.updatedAt ?? 'none'}
        owners={owners.owners}
        updatedAt={owners.updatedAt}
        editable={canEditOwners()}
        knownShops={active.map((s) => s.code)}
      />
    </div>
  );
}

function OwnerRow({ owner: o }: { owner: OwnerGaps }) {
  const share = o.expected ? Math.round((o.filled / o.expected) * 100) : null;
  const color = o.missingCount === 0 ? 'var(--green-ink)' : 'var(--red-ink)';
  return (
    <tr className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
      <td className="py-2 pr-3">
        <div className="font-medium">{o.name}</div>
        {o.missing.length > 0 && (
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer muted">
              {o.missing.length} {plural(o.missing.length, 'день', 'дня', 'дней')} с пропусками
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {o.missing.map((d) => (
                <li key={d.date}>
                  {/* День открывается в редакторе: увидел пропуск — тут же заполнил. */}
                  <Link href={`/showcase?date=${d.date}`} className="tabular-nums underline">
                    {formatDay(d.date, { weekday: 'short', day: 'numeric', month: 'numeric' })}
                  </Link>{' '}
                  — {d.shops.join(', ')}
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
      <td className="hidden py-2 pr-3 text-xs muted sm:table-cell">{o.shops.join(', ') || '—'}</td>
      <td className="py-2 text-right font-semibold tabular-nums" style={{ color }}>
        {o.missingCount}
      </td>
      <td className="py-2 pl-3 text-right tabular-nums muted whitespace-nowrap">
        {o.filled}/{o.expected}
        {share !== null && ` · ${share}%`}
        {o.daysOff > 0 && (
          <div className="text-xs" title="Лавка × день, когда лавки не было в выгрузке отметок">
            выходных: {o.daysOff}
          </div>
        )}
      </td>
    </tr>
  );
}

/** Текст в чат команды: только те, у кого есть пропуски. */
function chatText(owners: readonly OwnerGaps[], slot: OwnerSlot, period: string): string {
  const lines = [`Не заполнены витрины (${SLOT_TITLE[slot]}), ${period}:`];
  for (const o of owners) {
    if (o.missingCount === 0) continue;
    lines.push('', `${o.name} — ${o.missingCount}:`);
    for (const d of o.missing) lines.push(`  ${shortDate(d.date)}: ${d.shops.join(', ')}`);
  }
  return lines.join('\n');
}

function isoParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && ISO_DATE.test(value) ? value : null;
}
