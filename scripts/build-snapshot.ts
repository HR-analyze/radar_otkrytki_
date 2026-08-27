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
import { parseLegacyVitriny } from '../src/lib/parsers/legacy-vitriny';
import { rollUpAttendance } from '../src/lib/rollup';
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
  const attendance: AttendanceRow[] = [];
  for (const file of files.attendance) {
    const parsed = parseAttendanceBuffer(file.buffer, config);
    attendance.push(...parsed.rows);
    warnings.push(...parsed.warnings.map((w) => `[${file.name}] ${w.message}`));
  }

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

  // 4. Статусы критериев: посчитанные за 25.08 перекрывают легаси за ту же дату.
  const criteria = new Map<string, CriterionStatusRow>();
  for (const c of legacy.criteria) {
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
    legacyPeople: legacy.people,
    runs: [
      {
        job: 'snapshot',
        source: `fixtures: ${[files.legacy?.name, ...files.attendance.map((f) => f.name)]
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
    (files.attendance.length ? `, выгрузки: ${files.attendance.map((f) => f.name).join(', ')}` : ', выгрузок нет'));
  console.log(
    `  лавок ${snapshot.shops.length}, отметок ${snapshot.attendance.length}, ` +
      `витрин ${snapshot.showcase.length}, статусов критериев ${snapshot.criteria.length}`,
  );
  console.log(`  даты: ${dates.length ? `${dates[0]} — ${dates[dates.length - 1]} (${dates.length})` : 'нет'}`);
  if (warnings.length) console.log(`  предупреждений при разборе: ${warnings.length}`);
}

main();
