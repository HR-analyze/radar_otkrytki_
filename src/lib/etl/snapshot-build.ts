import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config';
import { fixturesFingerprint, readFixtures } from '../fixtures';
import { parseAttendanceBuffer } from '../parsers/attendance';
import { parseDeliveryTimes } from '../parsers/delivery';
import { parseLegacyVitriny } from '../parsers/legacy-vitriny';
import { mergeDeliveryTimes } from '../delivery-merge';
import { dedupeAttendance, exportCoverage, isLegacyStale, rollUpAttendance } from '../rollup';
import { configFingerprint, type Snapshot } from '../snapshot';
import type { AttendanceRow, CriterionStatusRow, Shop } from '../types';

/**
 * Сборка `src/generated/snapshot.json` из fixtures — без SQLite и без записи в БД.
 *
 * Живёт в библиотеке, а не в скрипте, потому что вызывается из двух мест:
 * `npm run snapshot` (в том числе хуком `prebuild`) и кнопка загрузки на
 * дашборде там, где папка выгрузок доступна на запись — иначе загруженный файл
 * лежал бы на диске, а цифры остались бы прежними до следующей сборки.
 */

export function defaultFixturesDir(): string {
  return process.env.RADAR_FIXTURES_DIR ?? path.join(process.cwd(), 'fixtures');
}

export function defaultSnapshotPath(): string {
  return path.join(process.cwd(), 'src', 'generated', 'snapshot.json');
}

export interface SnapshotBuildResult {
  outPath: string;
  sizeKb: number;
  snapshot: Snapshot;
  files: { legacy: string | null; delivery: string | null; attendance: string[] };
  dates: string[];
  warnings: string[];
  /** Строка статистики по журналу отгрузок — пустая, если журнала нет. */
  deliveryStats: string;
  dedupedRemoved: number;
  droppedLegacy: number;
}

export function buildSnapshot(
  options: { fixturesDir?: string; outPath?: string } = {},
): SnapshotBuildResult {
  const fixturesDir = options.fixturesDir ?? defaultFixturesDir();
  const outPath = options.outPath ?? defaultSnapshotPath();
  const config = loadConfig();

  // Файлы не перечислены в коде: чтобы добавить день, достаточно положить
  // очередную выгрузку в fixtures/ — см. src/lib/fixtures.ts.
  const files = readFixtures(fixturesDir);
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
    fixturesFingerprint: fixturesFingerprint(fixturesDir),
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
        source: `fixtures: ${[
          files.legacy?.name,
          files.delivery?.name,
          ...files.attendance.map((f) => f.name),
        ]
          .filter(Boolean)
          .join(', ')}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'ok',
        rows: attendance.length + legacy.people.length,
      },
    ],
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot));

  return {
    outPath,
    sizeKb: Math.round(fs.statSync(/* turbopackIgnore: true */ outPath).size / 1024),
    snapshot,
    files: {
      legacy: files.legacy?.name ?? null,
      delivery: files.delivery?.name ?? null,
      attendance: files.attendance.map((f) => f.name),
    },
    dates: [...new Set(snapshot.criteria.map((c) => c.date))].sort(),
    warnings,
    deliveryStats,
    dedupedRemoved: deduped.removed,
    droppedLegacy,
  };
}
