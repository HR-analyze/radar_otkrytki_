/**
 * Пересборка норм выхода сотрудников: книга с листом «Шаблон по часам-пикам»
 * → fixtures/staffing-norms.json.
 *
 * Как и нормы открытия (build-shop-norms.ts), результат кладётся в репозиторий
 * разобранным: в диффе видно, у какой лавки поменялась норма. Сама книга в
 * репозиторий не кладётся — во втором её листе фонд оплаты труда.
 *
 *   npm run staffing:build -- путь/к/шаблону.xlsx
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseStaffing } from '../src/lib/parsers/staffing';
import { compareShopNumber } from '../src/lib/shops';
import { STAFFING_SEED_PATH } from '../src/lib/staffing-store';

const source = process.argv[2];
if (!source) {
  console.error('Укажите книгу: npm run staffing:build -- путь/к/шаблону.xlsx');
  process.exit(1);
}

const { norms, warnings } = parseStaffing(fs.readFileSync(source));
if (norms.length === 0) {
  console.error(`✗ В «${source}» не нашлось ни одной лавки`);
  process.exit(1);
}

const seed = {
  $comment:
    'Норма выхода сотрудников по часовым окнам, лист «Шаблон по часам-пикам». ' +
    'Собирается командой npm run staffing:build -- <книга.xlsx>. Время — минуты от полуночи, окно [from, to); ' +
    'from: null — окно «до N», начало которого в шаблоне не нашлось.',
  source: path.basename(source),
  builtAt: new Date().toISOString().slice(0, 10),
  norms: [...norms].sort(compareShopNumber),
};

// Окно — одной строкой: так в диффе видно «у М17 в 11–16 стало 4 повара»,
// а не три строки скобок на каждую клетку шаблона.
const json = JSON.stringify(seed, null, 2).replace(
  /\{\s*"from": (null|\d+),\s*"to": (\d+),\s*"count": ([\d.]+)\s*\}/g,
  '{ "from": $1, "to": $2, "count": $3 }',
);
fs.writeFileSync(STAFFING_SEED_PATH, json + '\n', 'utf8');

console.log(`✓ ${norms.length} лавок → ${STAFFING_SEED_PATH}`);
for (const w of warnings) console.log(`  ! ${w}`);
