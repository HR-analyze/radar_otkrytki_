/**
 * Нарушения открытия за период — то же, что вкладка, но в консоли.
 *
 *   npm run analyze:violations -- --from 2026-09-01 --to 2026-09-15
 *   npm run analyze:violations -- --from 2026-09-01 --to 2026-09-15 --pdf отчёт.pdf --csv нарушения.csv
 *
 * Без `--from`/`--to` берётся весь период, который есть в данных. Источник —
 * тот же, что у дашборда: SQLite, если база поднята, иначе снимок.
 *
 * Правила — в src/lib/violations.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/lib/config';
import { loadSnapshot, storageMode } from '../src/lib/snapshot';
import { readNorms } from '../src/lib/shop-norms-store';
import {
  analyzeDepartures,
  analyzeViolations,
  formatLate,
  kindsOf,
  toCsv,
  type DeparturesReport,
  type ShopDay,
  type ViolationsGroup,
  type ViolationsReport,
} from '../src/lib/violations';
import { renderViolationsReport } from '../src/lib/violations-pdf';

interface Args {
  from?: string;
  to?: string;
  pdf?: string;
  csv?: string;
  gap?: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`Не задано значение для ${a}`);
      i += 1;
      return v;
    };
    if (a === '--from') args.from = next();
    else if (a === '--to') args.to = next();
    else if (a === '--pdf') args.pdf = next();
    else if (a === '--csv') args.csv = next();
    else if (a === '--staff-gap-seconds') args.gap = Number(next());
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await loadSnapshot();
  const config = loadConfig();
  const norms = (await readNorms()).byCode;

  const dates = [...new Set(snapshot.attendance.map((r) => r.date))].sort();
  if (dates.length === 0) {
    console.error('В данных нет ни одного дня с отметками — считать нечего.');
    process.exit(1);
  }

  const from = args.from ?? dates[0];
  const to = args.to ?? dates[dates.length - 1];

  const report = analyzeViolations(snapshot.attendance, norms, config, from, to, {
    staffGapSeconds: args.gap,
  });
  const departures = analyzeDepartures(
    snapshot.departures,
    snapshot.attendance,
    norms,
    config,
    from,
    to,
  );

  const covered = dates.filter((d) => d >= from && d <= to);
  console.log(`Источник: ${storageMode() === 'sqlite' ? 'SQLite' : 'снимок'}`);
  console.log(
    `Период: ${from} — ${to}. Дней с отметками в этом периоде: ${covered.length}` +
      (covered.length ? ` (${covered[0]} — ${covered[covered.length - 1]})` : ''),
  );
  console.log('');
  console.log(text(report, departures));

  if (args.pdf) {
    fs.writeFileSync(
      path.resolve(args.pdf),
      await renderViolationsReport({ report, departures }),
    );
    console.log(`\nPDF-отчёт: ${args.pdf}`);
  }
  if (args.csv) {
    fs.writeFileSync(path.resolve(args.csv), toCsv(report, departures), 'utf8');
    console.log(`Таблица нарушений: ${args.csv}`);
  }
}

function text(report: ViolationsReport, departures: DeparturesReport): string {
  const s = report.summary;
  const lines: string[] = [];

  lines.push(`Проверено лавко-дней: ${s.checked} (без отметки водителя: ${s.noDriverMark})`);
  lines.push('');
  lines.push(
    `1. Выезд с РЦ позже ${departures.greenUntil}: ` +
      (departures.hasData
        ? `${departures.yellow + departures.red} из ${departures.checked} (красных ${departures.red})`
        : 'выгрузки по РЦ за период нет'),
  );
  lines.push(
    `2. Водитель вовремя, сотрудника не было: ${s.byKind.driver_on_time_no_staff} ` +
      `(и ещё ${s.byKind.no_staff_driver_late}, где водитель при этом опоздал)`,
  );
  lines.push(
    `3. Сотрудник есть — водитель опоздал: ${s.byKind.driver_late} ` +
      `(опозданий в красной зоне за период: ${s.driverLateRed})`,
  );
  lines.push(
    `4. Опоздавших поваров: ${s.lateCooks} (красных ${s.lateCooksRed}) ` +
      `в ${s.byKind.cook_late} лавко-днях`,
  );

  if (departures.late.length > 0) {
    lines.push('');
    lines.push('Выезды с РЦ позже норматива:');
    lines.push(
      table(
        ['дата', 'водитель', 'выехал', 'позже'],
        departures.late.map((l) => [l.date, l.employeeName, l.time, formatLate(l.lateBy)]),
      ),
    );
  }

  const noStaff = report.days.filter((d) => {
    const k = kindsOf(d);
    return k.includes('driver_on_time_no_staff') || k.includes('no_staff_driver_late');
  });
  lines.push('');
  lines.push('Сотрудника не было (отметка легла на отметку водителя):');
  lines.push(dayTable(noStaff));

  const driverLate = report.days
    .filter((d) => kindsOf(d).includes('driver_late'))
    .sort((a, b) => (b.driverLateBy ?? 0) - (a.driverLateBy ?? 0));
  lines.push('');
  lines.push('Водитель опоздал при вышедшем сотруднике:');
  lines.push(dayTable(driverLate));

  const cooks = report.days
    .filter((d) => !d.skipped)
    .flatMap((d) => d.lateCooks.map((cook) => ({ day: d, cook })))
    .sort((a, b) => b.cook.lateBy - a.cook.lateBy);
  lines.push('');
  lines.push('Опоздания поваров:');
  lines.push(
    cooks.length === 0
      ? '  — нет'
      : table(
          ['дата', 'лавка', 'повар', 'норма', 'пришёл', 'опоздание'],
          cooks.map(({ day, cook }) => [
            day.date,
            day.shopCode,
            cook.name,
            cook.norm,
            cook.time,
            formatLate(cook.lateBy),
          ]),
        ),
  );

  lines.push('');
  lines.push('Повторяемость по лавкам:');
  lines.push(groupTable(report.byShop.filter((g) => g.total > 0), 'лавка', 'дней'));
  lines.push('');
  lines.push('Повторяемость по водителям:');
  // У водителя счётчик — лавко-дни: за смену он объезжает несколько лавок.
  lines.push(groupTable(report.byDriver.filter((g) => g.total > 0), 'водитель', 'лавко-дней'));

  return lines.join('\n');
}

function dayTable(days: readonly ShopDay[]): string {
  if (days.length === 0) return '  — нет';
  return table(
    ['дата', 'лавка', 'норма', 'водитель', 'опоздание', 'первый сотрудник', 'разрыв'],
    days.map((d) => [
      d.date,
      d.shopCode,
      d.driverNorm ?? '—',
      d.driver?.time ?? '—',
      d.driverLateBy != null && d.driverLateBy > 0 ? formatLate(d.driverLateBy) : 'в норме',
      d.staff ? `${d.staff.role} ${d.staff.time}` : '—',
      d.staffGapSeconds == null ? '—' : `${d.staffGapSeconds} с`,
    ]),
  );
}

function groupTable(groups: readonly ViolationsGroup[], head: string, unit: string): string {
  if (groups.length === 0) return '  — нет';
  return table(
    [head, unit, '№2', '№3', '№4', 'всего'],
    groups.map((g) => [
      g.title,
      String(g.days),
      String(g.byKind.driver_on_time_no_staff + g.byKind.no_staff_driver_late),
      String(g.byKind.driver_late),
      String(g.byKind.cook_late),
      String(g.total),
    ]),
  );
}

function table(head: readonly string[], rows: readonly string[][]): string {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    '  ' + cells.map((c, i) => (c ?? '').padEnd(width[i])).join('  ').trimEnd();
  return [line(head), line(width.map((w) => '─'.repeat(w))), ...rows.map(line)].join('\n');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
