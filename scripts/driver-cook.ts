/**
 * Сверка отметок водителя и первого повара за период.
 *
 *   npm run analyze:driver-cook -- --from 2026-09-01 --to 2026-09-16
 *   npm run analyze:driver-cook -- --from 2026-09-01 --to 2026-09-16 --md отчёт.md --csv пары.csv
 *
 * Без `--from`/`--to` берётся весь период, который есть в данных. Источник —
 * тот же, что у дашборда: SQLite, если база поднята, иначе снимок
 * (`src/lib/snapshot.ts` решает сам).
 *
 * Правила разбора и то, почему берутся только живые отметки face id, —
 * в `src/lib/driver-cook.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeDriverCook,
  isSuspicious,
  type DriverCookGroup,
  type DriverCookPair,
  type DriverCookReport,
} from '../src/lib/driver-cook';
import { loadSnapshot, storageMode } from '../src/lib/snapshot';

interface Args {
  from?: string;
  to?: string;
  md?: string;
  csv?: string;
  simultaneous?: number;
  close?: number;
  all: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { all: false };
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
    else if (a === '--md') args.md = next();
    else if (a === '--csv') args.csv = next();
    else if (a === '--simultaneous-seconds') args.simultaneous = Number(next());
    else if (a === '--close-minutes') args.close = Number(next());
    else if (a === '--all') args.all = true;
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await loadSnapshot();
  const dates = [...new Set(snapshot.attendance.map((r) => r.date))].sort();

  if (dates.length === 0) {
    console.error('В данных нет ни одного дня с отметками — считать нечего.');
    process.exit(1);
  }

  const from = args.from ?? dates[0];
  const to = args.to ?? dates[dates.length - 1];
  const report = analyzeDriverCook(snapshot.attendance, from, to, {
    simultaneousSeconds: args.simultaneous,
    closeMinutes: args.close,
  });

  const covered = dates.filter((d) => d >= from && d <= to);
  console.log(`Источник: ${storageMode() === 'sqlite' ? 'SQLite' : 'снимок'}`);
  console.log(
    `Период: ${from} — ${to}. Дней с отметками в этом периоде: ${covered.length}` +
      (covered.length ? ` (${covered[0]} — ${covered[covered.length - 1]})` : ''),
  );

  if (covered.length === 0) {
    console.log('');
    console.log('За этот период выгрузок в данных нет — сводить нечего.');
    console.log(
      `Что есть: ${dates[0]} — ${dates[dates.length - 1]}. Положите выгрузки ` +
        '(«выходы» и «водители») в fixtures/ и пересоберите: npm run snapshot',
    );
    process.exit(2);
  }

  console.log('');
  console.log(text(report, args.all));

  if (report.summary.pairs === 0) {
    console.log('');
    console.log(
      'Ни одного лавко-дня, где face id есть и у водителя, и у повара. Обычно это ' +
        'значит, что за период загружены не обе выгрузки: нужны и «выходы», и «водители».',
    );
    console.log(`Дни с отметками в данных: ${dates[0]} — ${dates[dates.length - 1]}.`);
  }

  if (args.md) {
    fs.writeFileSync(path.resolve(args.md), markdown(report), 'utf8');
    console.log(`\nОтчёт: ${args.md}`);
  }
  if (args.csv) {
    fs.writeFileSync(path.resolve(args.csv), csv(report.pairs), 'utf8');
    console.log(`Таблица пар: ${args.csv}`);
  }
}

function share(n: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((n / total) * 1000) / 10}%`;
}

function text(r: DriverCookReport, all: boolean): string {
  const { summary: s } = r;
  const lines: string[] = [];
  const n = s.pairs;

  lines.push(`Лавко-дней с обеими живыми отметками: ${n}`);
  lines.push(`Пропущено (отметки face id только у одной стороны или нет вовсе): ${s.skipped}`);
  lines.push('');
  lines.push('Как разошлись отметки водителя и первого повара:');
  lines.push(
    `  1. водитель раньше повара (> ${r.options.simultaneousSeconds} сек): ` +
      `${s.byBucket.driver_before} (${share(s.byBucket.driver_before, n)}), ` +
      `из них лавку открыл водитель: ${s.aloneByBucket.driver_before}`,
  );
  lines.push(
    `  2. одновременно (± ${r.options.simultaneousSeconds} сек): ` +
      `${s.byBucket.simultaneous} (${share(s.byBucket.simultaneous, n)}), ` +
      `из них до пары в лавке никого: ${s.aloneByBucket.simultaneous}`,
  );
  lines.push(
    `  3. повар раньше, но в пределах ${r.options.closeMinutes} мин: ` +
      `${s.byBucket.cook_before_close} (${share(s.byBucket.cook_before_close, n)}), ` +
      `из них до пары в лавке никого: ${s.aloneByBucket.cook_before_close}`,
  );
  lines.push(
    `  4. повар раньше водителя (обычный день): ` +
      `${s.byBucket.cook_before} (${share(s.byBucket.cook_before, n)})`,
  );

  const suspicious = r.pairs.filter(isSuspicious);
  lines.push('');
  lines.push(
    `Пары «отметились вместе, и до них в лавке никого»: ${suspicious.length} ` +
      `(${share(suspicious.length, n)})`,
  );

  lines.push('');
  lines.push('Лавки с повторяющимся совпадением:');
  lines.push(groupTable(r.byShop.filter((g) => g.alone > 0), 'Лавка'));

  lines.push('');
  lines.push('Водители с повторяющимся совпадением:');
  lines.push(groupTable(r.byDriver.filter((g) => g.alone > 0), 'Водитель'));

  lines.push('');
  const shown = all ? r.pairs : suspicious;
  lines.push(all ? 'Все пары:' : 'Совпавшие пары по дням:');
  lines.push(pairTable(shown));

  return lines.join('\n');
}

function groupTable(groups: readonly DriverCookGroup[], head: string): string {
  if (groups.length === 0) return '  — нет';
  const rows = groups.map((g) => [
    g.title,
    String(g.pairs),
    String(g.driverBefore),
    String(g.simultaneous),
    String(g.cookBeforeClose),
    String(g.alone),
  ]);
  return table([head, 'дней', 'вод. раньше', 'одноврем.', 'рядом', 'совпало'], rows);
}

function pairTable(pairs: readonly DriverCookPair[]): string {
  if (pairs.length === 0) return '  — нет';
  const rows = pairs.map((p) => [
    p.date,
    p.shopCode,
    p.driverTime,
    p.cookTime,
    delta(p.deltaMinutes),
    p.driverName,
    p.cookName,
    p.precedingMark ?? 'никого',
  ]);
  return table(
    ['дата', 'лавка', 'водитель', 'повар', 'разрыв', 'кто за рулём', 'кто на кухне', 'до них'],
    rows,
  );
}

/** «+2,4 мин» — водитель раньше; «−0,3 мин» — повар раньше. */
function delta(minutes: number): string {
  const sign = minutes > 0 ? '+' : minutes < 0 ? '−' : '';
  return `${sign}${String(Math.abs(minutes)).replace('.', ',')} мин`;
}

function table(head: readonly string[], rows: readonly string[][]): string {
  const width = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    '  ' + cells.map((c, i) => (c ?? '').padEnd(width[i])).join('  ').trimEnd();
  return [line(head), line(width.map((w) => '─'.repeat(w))), ...rows.map(line)].join('\n');
}

function markdown(r: DriverCookReport): string {
  const s = r.summary;
  const n = s.pairs;
  const suspicious = r.pairs.filter(isSuspicious);
  const out: string[] = [];

  out.push(`# Водитель и первый повар: ${r.from} — ${r.to}`);
  out.push('');
  out.push(
    `Лавко-дней с обеими живыми отметками face id — **${n}**; пропущено ${s.skipped} ` +
      '(отметка была только у одной стороны или время восстановлено из журнала отгрузок).',
  );
  out.push('');
  out.push('| Как разошлись отметки | Лавко-дней | Доля | До них в лавке никого |');
  out.push('| --- | ---: | ---: | ---: |');
  out.push(
    `| Водитель раньше повара | ${s.byBucket.driver_before} | ${share(s.byBucket.driver_before, n)} | ${s.aloneByBucket.driver_before} |`,
  );
  out.push(
    `| Одновременно (± ${r.options.simultaneousSeconds} сек) | ${s.byBucket.simultaneous} | ${share(s.byBucket.simultaneous, n)} | ${s.aloneByBucket.simultaneous} |`,
  );
  out.push(
    `| Повар раньше, разрыв до ${r.options.closeMinutes} мин | ${s.byBucket.cook_before_close} | ${share(s.byBucket.cook_before_close, n)} | ${s.aloneByBucket.cook_before_close} |`,
  );
  out.push(
    `| Повар раньше водителя | ${s.byBucket.cook_before} | ${share(s.byBucket.cook_before, n)} | — |`,
  );
  out.push('');
  out.push(`Пар «отметились вместе, и до них никого» — **${suspicious.length}**.`);
  out.push('');
  out.push('## Лавки');
  out.push('');
  out.push('| Лавка | Дней | Водитель раньше | Одновременно | Рядом | Совпало |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const g of r.byShop.filter((x) => x.alone > 0)) {
    out.push(
      `| ${g.title} | ${g.pairs} | ${g.driverBefore} | ${g.simultaneous} | ${g.cookBeforeClose} | ${g.alone} |`,
    );
  }
  out.push('');
  out.push('## Водители');
  out.push('');
  out.push('| Водитель | Дней | Водитель раньше | Одновременно | Рядом | Совпало |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const g of r.byDriver.filter((x) => x.alone > 0)) {
    out.push(
      `| ${g.title} | ${g.pairs} | ${g.driverBefore} | ${g.simultaneous} | ${g.cookBeforeClose} | ${g.alone} |`,
    );
  }
  out.push('');
  out.push('## Совпавшие пары');
  out.push('');
  out.push('| Дата | Лавка | Водитель | Повар | Разрыв | Кто за рулём | Кто на кухне |');
  out.push('| --- | --- | --- | --- | ---: | --- | --- |');
  for (const p of suspicious) {
    out.push(
      `| ${p.date} | ${p.shopCode} | ${p.driverTime} | ${p.cookTime} | ${delta(p.deltaMinutes)} | ${p.driverName} | ${p.cookName} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

function csv(pairs: readonly DriverCookPair[]): string {
  const head = [
    'Дата',
    'Код лавки',
    'Лавка',
    'Отметка водителя',
    'Отметка повара',
    'Разрыв, мин',
    'Категория',
    'До пары никого',
    'Кто отметился раньше',
    'Водитель',
    'Повар',
    'Должность повара',
  ];
  const rows = pairs.map((p) => [
    p.date,
    p.shopCode,
    p.shopName,
    p.driverTime,
    p.cookTime,
    String(p.deltaMinutes).replace('.', ','),
    p.bucket,
    p.aloneAtOpen ? 'да' : 'нет',
    p.precedingMark ?? '',
    p.driverName,
    p.cookName,
    p.cookRole,
  ]);
  // Разделитель «;» и BOM: так Excel открывает файл колонками и не ломает кириллицу.
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

function cell(v: string): string {
  return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
