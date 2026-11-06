/**
 * Пересборка сида нормативов: fixtures/normy-lavok.csv → fixtures/shop-norms.json.
 *
 * Справочник «Лавки» ведут в Google-таблице и выгружают руками. Разобранный
 * результат кладётся в репозиторий отдельным файлом, а не разбирается на лету:
 * в диффе видно, какие нормы поменялись, и правку справочника нельзя внести
 * незаметно.
 *
 *   npm run norms:build [путь-к-выгрузке]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseShopNorms } from '../src/lib/parsers/shop-norms';
import { normsSeedJson, SHOP_NORMS_SEED_PATH } from '../src/lib/shop-norms-store';

// Справочник, загруженный кнопкой с дашборда, лежит как normy-lavok.xlsx и
// вытесняет прежний CSV — берём тот, что есть.
const source =
  process.argv[2] ??
  ['normy-lavok.xlsx', 'normy-lavok.csv'].map((f) => path.join('fixtures', f)).find((f) => fs.existsSync(f)) ??
  path.join('fixtures', 'normy-lavok.csv');

const { norms, warnings } = parseShopNorms(fs.readFileSync(source));
if (norms.length === 0) {
  console.error(`✗ В «${source}» не нашлось ни одной лавки`);
  process.exit(1);
}

fs.writeFileSync(SHOP_NORMS_SEED_PATH, normsSeedJson(norms, path.basename(source)), 'utf8');

const noDriver = norms.filter((n) => !n.driverAt).map((n) => n.code);
const noCook = norms.filter((n) => n.cookAt.length === 0).map((n) => n.code);
const dirty = norms.filter((n) => n.warnings.length > 0);

console.log(`✓ ${norms.length} лавок → ${SHOP_NORMS_SEED_PATH}`);
if (noDriver.length) console.log(`  без нормы водителя: ${noDriver.join(', ')}`);
if (noCook.length) console.log(`  без нормы поваров:  ${noCook.join(', ')}`);
for (const w of warnings) console.log(`  ! ${w}`);
for (const n of dirty) console.log(`  ! ${n.code}: ${n.warnings.join('; ')}`);
