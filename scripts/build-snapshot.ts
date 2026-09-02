/**
 * Печёт src/generated/snapshot.json из fixtures — без SQLite и без записи в БД.
 *
 * Запускается автоматически перед `npm run build` (npm-хук `prebuild`), поэтому
 * работает на Vercel: нативный `better-sqlite3` там не собирается, а этот путь
 * его вообще не касается — только чистый JS-парсер xlsx.
 *
 * Сама сборка живёт в src/lib/etl/snapshot-build.ts: её же зовёт кнопка
 * загрузки на дашборде. Здесь остался только вывод в консоль — по нему в логе
 * сборки видно, какие файлы доехали и за какие дни.
 *
 * Вручную: npm run snapshot
 */
import path from 'node:path';
import { buildSnapshot } from '../src/lib/etl/snapshot-build';

function main(): void {
  const r = buildSnapshot();

  console.log(`Снимок собран: ${path.relative(process.cwd(), r.outPath)} (${r.sizeKb} КБ)`);
  console.log(
    `  файлы: ${r.files.legacy ? r.files.legacy + ' (легаси)' : 'легаси-книги нет'}` +
      (r.files.delivery ? `, отгрузки: ${r.files.delivery}` : ', журнала отгрузок нет') +
      (r.files.roster ? `, справочник: ${r.files.roster}` : ', справочника лавок нет') +
      (r.files.attendance.length
        ? `, выгрузки: ${r.files.attendance.join(', ')}`
        : ', выгрузок нет'),
  );
  console.log(
    `  лавок ${r.snapshot.shops.length}, отметок ${r.snapshot.attendance.length}, ` +
      `витрин ${r.snapshot.showcase.length}, статусов критериев ${r.snapshot.criteria.length}`,
  );
  console.log(
    `  даты: ${r.dates.length ? `${r.dates[0]} — ${r.dates[r.dates.length - 1]} (${r.dates.length})` : 'нет'}`,
  );
  if (r.rosterStats) console.log(r.rosterStats);
  if (r.deliveryStats) console.log(r.deliveryStats);
  if (r.dedupedRemoved > 0) {
    console.log(`  повторных отметок свёрнуто: ${r.dedupedRemoved}`);
  }
  if (r.droppedLegacy > 0) {
    console.log(`  легаси-статусов отброшено (день закрыт выгрузкой): ${r.droppedLegacy}`);
  }
  if (r.warnings.length) console.log(`  предупреждений при разборе: ${r.warnings.length}`);
}

main();
