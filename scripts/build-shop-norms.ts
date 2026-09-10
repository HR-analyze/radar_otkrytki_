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
import { SHOP_NORMS_SEED_PATH } from '../src/lib/shop-norms-store';

const source = process.argv[2] ?? path.join('fixtures', 'normy-lavok.csv');

const { norms, warnings } = parseShopNorms(fs.readFileSync(source));
if (norms.length === 0) {
  console.error(`✗ В «${source}» не нашлось ни одной лавки`);
  process.exit(1);
}

const seed = {
  $comment:
    'Нормативы открытия по лавкам. Собирается из справочника «Лавки»: npm run norms:build. ' +
    'Правки с сайта сюда не попадают — они живут в data/manual.db (см. shop-norms-store.ts).',
  source: path.basename(source),
  builtAt: new Date().toISOString().slice(0, 10),
  norms: [...norms].sort((a, b) => a.code.localeCompare(b.code, 'ru', { numeric: true })),
};

fs.writeFileSync(SHOP_NORMS_SEED_PATH, JSON.stringify(seed, null, 2) + '\n', 'utf8');

const noDriver = norms.filter((n) => !n.driverAt).map((n) => n.code);
const noCook = norms.filter((n) => n.cookShifts.length === 0).map((n) => n.code);
const dirty = norms.filter((n) => n.warnings.length > 0);

console.log(`✓ ${norms.length} лавок → ${SHOP_NORMS_SEED_PATH}`);
if (noDriver.length) console.log(`  без нормы водителя: ${noDriver.join(', ')}`);
if (noCook.length) console.log(`  без нормы поваров:  ${noCook.join(', ')}`);
for (const w of warnings) console.log(`  ! ${w}`);
for (const n of dirty) console.log(`  ! ${n.code}: ${n.warnings.join('; ')}`);
