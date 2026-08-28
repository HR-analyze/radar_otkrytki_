/**
 * Печёт src/generated/snapshot.json из fixtures — без SQLite и без записи в БД.
 *
 * Запускается автоматически перед `npm run build` (npm-хук `prebuild`), поэтому
 * работает на Vercel: нативный `better-sqlite3` там не собирается, а этот путь
 * его вообще не касается — только чистый JS-парсер xlsx.
 *
 * Вручную: npm run snapshot
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/lib/config';
import { fixturesFingerprint, readFixtures } from '../src/lib/fixtures';
import { parseAttendanceBuffer } from '../src/lib/parsers/attendance';
import { parseDeliveryTimes } from '../src/lib/parsers/delivery';
import { parseLegacyVitriny } from '../src/lib/parsers/legacy-vitriny';
import { mergeDeliveryTimes } from '../src/lib/delivery-merge';
import {
  dedupeAttendance,
  exportCoverage,
  isLegacyStale,
  rollUpAttendance,
} from '../src/lib/rollup';
import { configFingerprint, type Snapshot } from '../src/lib/snapshot';
import type { AttendanceRow, CriterionStatusRow, Shop } from '../src/lib/types';

const FIXTURES = process.env.RADAR_FIXTURES_DIR ?? path.join(process.cwd(), 'fixtures');
const OUT = path.join(process.cwd(), 'src', 'generated', 'snapshot.json');

function main(): void {
  const config = loadConfig();

  // Файлы не перечислены в коде: чтобы добавить день, достаточно положить
  // очередную выгрузку в fixtures/ — см. src/lib/fixtures.ts.
  const files = readFixtures(FIXTURES);
  const warnings: string[] = [...files.warnings];

  // 1. Легаси-книга: справочник лавок с РМ + история, раскрашенная вручную.
  const legacy = files.legacy
    ? parseLegacyVitriny(files.legacy.buffer, config)
    : { shops: [], people: [], showcase: [], criteria: [], dates: [], warnings: [] };
  warnings.push(...legacy.warnings);

  // 2. Сырые выгрузки: расчёт по алгоритму за все даты, что в них найдутся.
  let attendance: AttendanceRow[] = [];
  for (const file of files.attendance) {
    const parsed = parseAttendanceBuffer(file.buffer, config);
    attendance.push(...parsed.rows);
    warnings.push(...parsed.warnings.map((w) => `[${file.name}] ${w.message}`));
  }

  // 2.1. Повторные отметки одного человека — в одну строку (см. dedupeAttendance).
  const deduped = dedupeAttendance(attendance);
  attendance = deduped.rows;

  // 3. Лавки: имя из самой свежей выгрузки, супервайзер — из легаси-книги.
  const shops = new Map<string, Shop>();
  for (const s of legacy.shops) shops.set(s.code, s);
  for (const r of attendance) {
    const prev = shops.get(r.shopCode);
    shops.set(r.shopCode, {
      code: r.shopCode,
      name: r.shopName,
      region: prev?.region ?? null,
    });
  }

  // 3.1. Журнал отгрузок: время приезда водителя там, где нет отметки face id.
  let deliveryStats = '';
  if (files.delivery) {
    const parsed = parseDeliveryTimes(files.delivery.buffer);
    warnings.push(...parsed.warnings.map((w) => `[${files.delivery!.name}] ${w}`));

    // Дни считаем известными по остальным источникам: в журнале есть даты,
    // по которым нет ни выгрузок, ни легаси-книги.
    const knownDates = new Set([...legacy.dates, ...attendance.map((r) => r.date)]);
    const names = new Map([...shops].map(([code, shop]) => [code, shop.name]));
    const merged = mergeDeliveryTimes(attendance, parsed.rows, knownDates, names, config);
    attendance = merged.rows;

    deliveryStats =
      `  отгрузки: строк ${parsed.rows.length}, подставлено ${merged.applied} лавко-дней, ` +
      `скрыто отметок без face id ${merged.suppressed}, вне периода ${merged.skippedDates}`;
  }

  // 4. Статусы критериев: посчитанное перекрывает легаси, а устаревшее
  //    легаси не берётся вовсе — см. isLegacyStale.
  const coverage = exportCoverage(attendance);
  const criteria = new Map<string, CriterionStatusRow>();
  let droppedLegacy = 0;
  for (const c of legacy.criteria) {
    if (isLegacyStale(coverage, c.date, c.shopCode, c.criterion)) {
      droppedLegacy++;
      continue;
    }
    criteria.set(`${c.date}|${c.shopCode}|${c.criterion}`, c);
  }
  for (const date of new Set(attendance.map((r) => r.date))) {
    for (const c of rollUpAttendance(date, attendance, config)) {
      criteria.set(`${c.date}|${c.shopCode}|${c.criterion}`, c);
    }
  }

  const snapshot: Snapshot = {
    generatedAt: new Date().toISOString(),
    source: 'json',
    configFingerprint: configFingerprint(),
    fixturesFingerprint: fixturesFingerprint(FIXTURES),
    shops: [...shops.values()],
    attendance,
    showcase: legacy.showcase,
    criteria: [...criteria.values()],
    legacyPeople: legacy.people.filter(
      (p) => !isLegacyStale(coverage, p.date, p.shopCode, p.criterion),
    ),
    runs: [
      {
        job: 'snapshot',
        source: `fixtures: ${[files.legacy?.name, files.delivery?.name, ...files.attendance.map((f) => f.name)]
          .filter(Boolean)
          .join(', ')}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'ok',
        rows: attendance.length + legacy.people.length,
      },
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snapshot));

  const sizeKb = Math.round(fs.statSync(OUT).size / 1024);
  const dates = [...new Set(snapshot.criteria.map((c) => c.date))].sort();

  console.log(`Снимок собран: ${path.relative(process.cwd(), OUT)} (${sizeKb} КБ)`);
  console.log(`  файлы: ${files.legacy ? files.legacy.name + ' (легаси)' : 'легаси-книги нет'}` +
    (files.delivery ? `, отгрузки: ${files.delivery.name}` : ', журнала отгрузок нет') +
    (files.attendance.length ? `, выгрузки: ${files.attendance.map((f) => f.name).join(', ')}` : ', выгрузок нет'));
  console.log(
    `  лавок ${snapshot.shops.length}, отметок ${snapshot.attendance.length}, ` +
      `витрин ${snapshot.showcase.length}, статусов критериев ${snapshot.criteria.length}`,
  );
  console.log(`  даты: ${dates.length ? `${dates[0]} — ${dates[dates.length - 1]} (${dates.length})` : 'нет'}`);
  if (deliveryStats) console.log(deliveryStats);
  if (deduped.removed > 0) {
    console.log(`  повторных отметок свёрнуто: ${deduped.removed}`);
  }
  if (droppedLegacy > 0) {
    console.log(
      `  легаси-статусов отброшено (день закрыт выгрузкой): ${droppedLegacy}`,
    );
  }
  if (warnings.length) console.log(`  предупреждений при разборе: ${warnings.length}`);
}

main();
