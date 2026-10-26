/**
 * Пересборка справочника руководителей лавок: таблица с листом «Лавки»
 * → fixtures/shop-directors.json.
 *
 * В репозиторий уходят только код лавки, управляющий и ТД. Сама таблица — нет:
 * в ней телефоны, почта и адреса, а радару они не нужны.
 *
 *   npm run directors:build -- путь/к/таблице.xlsx
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseShopDirectors } from '../src/lib/parsers/shop-directors';
import { compareShopNumber } from '../src/lib/shops';
import { SHOP_DIRECTORS_SEED_PATH } from '../src/lib/shop-directors-store';

const source = process.argv[2];
if (!source) {
  console.error('Укажите таблицу: npm run directors:build -- путь/к/таблице.xlsx');
  process.exit(1);
}

const { rows, warnings } = parseShopDirectors(fs.readFileSync(source));
if (rows.length === 0) {
  console.error(`✗ В «${source}» не нашлось ни одной лавки`);
  process.exit(1);
}

const seed = {
  $comment:
    'Кто руководит лавкой: управляющий (director) или территориальный директор (territorial). ' +
    'Собирается командой npm run directors:build -- <таблица.xlsx>, лист «Лавки». Только имена — ' +
    'телефоны, почта и адреса из таблицы сюда не переносятся.',
  source: path.basename(source),
  builtAt: new Date().toISOString().slice(0, 10),
  shops: [...rows].sort((a, b) => compareShopNumber({ code: a.code, name: '' }, { code: b.code, name: '' })),
};

// Лавка — одной строкой: в диффе сразу видно, у кого сменился руководитель.
const json = JSON.stringify(seed, null, 2).replace(
  /\{\s*"code": ("[^"]+"),\s*"director": (null|"[^"]*"),\s*"territorial": (null|"[^"]*")\s*\}/g,
  '{ "code": $1, "director": $2, "territorial": $3 }',
);
fs.writeFileSync(SHOP_DIRECTORS_SEED_PATH, json + '\n', 'utf8');

const td = new Set(rows.map((r) => r.territorial).filter(Boolean));
const dirs = new Set(rows.map((r) => r.director).filter(Boolean));
const none = rows.filter((r) => !r.director && !r.territorial).map((r) => r.code);
console.log(`✓ ${rows.length} лавок → ${SHOP_DIRECTORS_SEED_PATH}: ТД ${td.size}, директоров ${dirs.size}`);
if (none.length) console.log(`  без руководителя: ${none.join(', ')}`);
for (const w of warnings) console.log(`  ! ${w}`);
