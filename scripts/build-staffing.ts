/**
 * Пересборка норм выхода сотрудников: книги с листом «Шаблон по часам-пикам»
 * → fixtures/staffing-norms.json.
 *
 * Как и нормы открытия (build-shop-norms.ts), результат кладётся в репозиторий
 * разобранным: в диффе видно, у какой лавки поменялась норма. Сами книги в
 * репозиторий не кладутся — во втором их листе фонд оплаты труда.
 *
 *   npm run staffing:build -- шаблон.xlsx
 *   npm run staffing:build -- книга-1.xlsx книга-2.xlsx …   (порядок важен)
 *
 * Книг может быть несколько — от разных людей, каждый расписал свои лавки.
 * Как они сливаются, см. parsers/staffing-merge.ts: правка одной книги
 * побеждает нетронутый шаблон остальных, а при споре и пересечении дислокаций
 * побеждает книга, указанная ПОЗЖЕ. Все правки и споры печатаются — их стоит
 * прочитать перед коммитом.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseStaffing } from '../src/lib/parsers/staffing';
import { mergeStaffing } from '../src/lib/parsers/staffing-merge';
import { compareShopNumber } from '../src/lib/shops';
import { STAFFING_SEED_PATH } from '../src/lib/staffing-store';
import { hasLayout, type StaffNorm } from '../src/lib/staffing';

const sources = process.argv.slice(2);
if (sources.length === 0) {
  console.error('Укажите книгу: npm run staffing:build -- путь/к/шаблону.xlsx [ещё книги…]');
  process.exit(1);
}

const warnings: string[] = [];
const books = sources.map((file) => {
  const parsed = parseStaffing(fs.readFileSync(file));
  if (parsed.norms.length === 0) {
    console.error(`✗ В «${file}» не нашлось ни одной лавки`);
    process.exit(1);
  }
  const name = path.basename(file);
  warnings.push(...parsed.warnings.map((w) => (sources.length > 1 ? `${name}: ${w}` : w)));
  return { name, norms: parsed.norms };
});

// Прежние нормы — только чтобы лавка, которой нет ни в одной книге, не
// пропала молча (см. mergeStaffing).
const previous: StaffNorm[] = fs.existsSync(STAFFING_SEED_PATH)
  ? (JSON.parse(fs.readFileSync(STAFFING_SEED_PATH, 'utf8')).norms ?? [])
  : [];
const { norms, edits, conflicts } = mergeStaffing(books, previous);

const seed = {
  $comment:
    'Норма выхода сотрудников по часовым окнам, лист «Шаблон по часам-пикам». ' +
    'Собирается командой npm run staffing:build -- <книга.xlsx>. Время — минуты от полуночи, окно [from, to); ' +
    'from: null — окно «до N», начало которого в шаблоне не нашлось. posts[i] — дислокации окна slots[i]: ' +
    'кто где стоит, разобранные из строк под лавкой; layout — рабочие места лавки и пометки.',
  source: books.length === 1 ? books[0].name : `«Шаблон по часам-пикам», ${books.length} книг`,
  builtAt: new Date().toISOString().slice(0, 10),
  norms: [...norms].sort(compareShopNumber),
};

// Окно — одной строкой: так в диффе видно «у М17 в 11–16 стало 4 повара»,
// а не три строки скобок на каждую клетку шаблона.
// Пост — тоже одной строкой: «М50 Кассир 11–16: 4 прием → 5 прием».
const json = JSON.stringify(seed, null, 2)
  .replace(/\{\s*"from": (null|\d+),\s*"to": (\d+),\s*"count": ([\d.]+)\s*\}/g, '{ "from": $1, "to": $2, "count": $3 }')
  .replace(/\{\s*"count": (null|\d+),\s*"place": ("(?:[^"\\]|\\.)*")\s*\}/g, '{ "count": $1, "place": $2 }');
fs.writeFileSync(STAFFING_SEED_PATH, json + '\n', 'utf8');

const laidOut = norms.filter(hasLayout).length;
console.log(`✓ ${norms.length} лавок, с дислокациями — ${laidOut} → ${STAFFING_SEED_PATH}`);
if (edits.length) console.log(`\nПравки норм из книг (${edits.length}):`);
for (const e of edits) console.log(`  ✎ ${e}`);
if (conflicts.length) console.log(`\nСпоры и пересечения (${conflicts.length}):`);
for (const c of conflicts) console.log(`  ⚠ ${c}`);
if (warnings.length) console.log(`\nПредупреждения разбора (${warnings.length}):`);
for (const w of [...new Set(warnings)]) console.log(`  ! ${w}`);
