/**
 * Ручной запуск ETL по тестовым файлам из fixtures/.
 * Поднимает MVP с реальными данными за 19–25.08 одной командой: npm run seed
 *
 *   19–24.08 — легаси-статусы из Витрины.xlsx (раскрашены руками), origin='legacy';
 *              водитель за 19–21.08 считается по журналу «Время поставки»
 *   25–27.08 — посчитано из сырых выгрузок .xls, origin='computed'
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/lib/config';
import { getDb, dbPath, startImportRun } from '../src/lib/db';
import { readFixtures } from '../src/lib/fixtures';
import { parseAttendanceBuffer } from '../src/lib/parsers/attendance';
import { parseLegacyVitriny } from '../src/lib/parsers/legacy-vitriny';
import { exportCoverage, isLegacyStale } from '../src/lib/rollup';
import { runAttendanceJob } from '../src/lib/etl/attendance-job';
import {
  upsertCriterionStatuses,
  upsertLegacyPeople,
  upsertShops,
  upsertShowcase,
} from '../src/lib/repository';

const FIXTURES = process.env.RADAR_FIXTURES_DIR ?? path.join(process.cwd(), 'fixtures');

function main(): void {
  const config = loadConfig();
  const reset = process.argv.includes('--reset');

  const d = getDb();
  if (reset) {
    console.log('· Очищаю таблицы (--reset)');
    d.exec(`
      DELETE FROM attendance;
      DELETE FROM showcase_fill;
      DELETE FROM criterion_status;
      DELETE FROM legacy_person_status;
      DELETE FROM shops;
    `);
  }

  console.log(`· БД: ${dbPath()}`);

  // Файлы не перечислены в коде — берём всё, что лежит в папке.
  const files = readFixtures(FIXTURES);
  for (const w of files.warnings) console.log(`  ! ${w}`);

  // Что из легаси-книги вообще нужно: см. isLegacyStale. Считаем до записи
  // легаси, поэтому выгрузки разбираются здесь ещё раз.
  const coverage = exportCoverage(
    files.attendance.flatMap((f) => parseAttendanceBuffer(f.buffer, config).rows),
  );

  /* --- 1. Легаси-книга: справочник лавок + история ------------------------ */
  let legacyDates: string[] = [];
  if (!files.legacy) {
    console.log('· Легаси-книги в fixtures нет — пропускаю историю');
  } else {
  const run = startImportRun('seed:legacy', files.legacy.name);
  try {
    const legacy = parseLegacyVitriny(files.legacy.buffer, config);
    legacyDates = legacy.dates;
    const people = legacy.people.filter(
      (p) => !isLegacyStale(coverage, p.date, p.shopCode, p.criterion),
    );
    const criteria = legacy.criteria.filter(
      (c) => !isLegacyStale(coverage, c.date, c.shopCode, c.criterion),
    );

    upsertShops(legacy.shops);
    upsertLegacyPeople(people);
    upsertShowcase(legacy.showcase);
    upsertCriterionStatuses(criteria);
    run.finish('ok', criteria.length, legacy.warnings);

    console.log(
      `· Витрины.xlsx: лавок ${legacy.shops.length}, статусов людей ${people.length}, ` +
        `витрин ${legacy.showcase.length}, свёрнутых критериев ${criteria.length}` +
        (legacy.people.length > people.length
          ? ` (отброшено ${legacy.people.length - people.length} статусов: день закрыт выгрузкой)`
          : ''),
    );
    console.log(`  даты: ${legacy.dates.join(', ')}`);
    if (legacy.warnings.length) {
      console.log(`  предупреждений: ${legacy.warnings.length}`);
      for (const w of legacy.warnings.slice(0, 5)) console.log(`    · ${w}`);
    }
  } catch (e) {
    run.finish('error', 0, [], e instanceof Error ? e.message : String(e));
    throw e;
  }
  }

  /* --- 2. Сырые выгрузки: расчёт по алгоритму за все найденные даты ------- */
  if (files.attendance.length === 0 && !files.delivery) {
    console.log('· Выгрузок отметок в fixtures нет — считать нечего');
    printTotals(d);
    return;
  }

  const result = runAttendanceJob(
    files.attendance.map((f) => ({ label: f.name, buffer: f.buffer })),
    {
      delivery: files.delivery
        ? { label: files.delivery.name, buffer: files.delivery.buffer }
        : undefined,
      knownDates: legacyDates,
    },
  );

  console.log(
    `· Выгрузки отметок: строк ${result.rows}, даты ${result.dates.join(', ')}, ` +
      `предупреждений ${result.warnings.length}`,
  );
  if (files.delivery) {
    console.log(
      `· Журнал отгрузок ${files.delivery.name}: время водителя подставлено ` +
        `в ${result.deliveryApplied} лавко-дней (там, где нет отметки face id)`,
    );
  }
  const byKind = new Map<string, number>();
  for (const w of result.warnings) byKind.set(w.kind, (byKind.get(w.kind) ?? 0) + 1);
  for (const [kind, n] of byKind) console.log(`    · ${kind}: ${n}`);

  printTotals(d);
}

/* --- Итог ----------------------------------------------------------------- */
function printTotals(d: ReturnType<typeof getDb>): void {
  const stats = d
    .prepare(
      `SELECT date, COUNT(DISTINCT shop_code) AS shops, COUNT(*) AS cells,
              SUM(status='red') AS red, SUM(status='yellow') AS yellow, SUM(status='green') AS green
       FROM criterion_status GROUP BY date ORDER BY date`,
    )
    .all() as { date: string; shops: number; cells: number; red: number; yellow: number; green: number }[];

  console.log('\nИтог по дням:');
  console.log('  дата         лавок  ячеек   🔴    🟡    🟢');
  for (const s of stats) {
    console.log(
      `  ${s.date}   ${String(s.shops).padStart(4)}  ${String(s.cells).padStart(5)}  ` +
        `${String(s.red).padStart(4)}  ${String(s.yellow).padStart(4)}  ${String(s.green).padStart(4)}`,
    );
  }
  console.log('\nГотово. Запусти дашборд: npm run dev');
}

main();
