/**
 * Справочник «лавка → GUID подразделения в 1С» для API показателей (см. README,
 * «API для 1С»).
 *
 *   npx tsx scripts/import-1c-guids.ts <выгрузка из 1С>.xlsx
 *
 * На входе — запрос «Справочник.ПодразделенияОрганизаций», который присылает
 * отдел 1С: колонки «Наименование» и «Уид». В справочник попадают только
 * лавки — строки с кодом «М12 …». Отделы и департаменты 1С (у них кода нет)
 * и «М00 Команда открытий» радару не нужны и отбрасываются.
 *
 * Результат — config/1c-guids.json, он коммитится. Файл из 1С в репозиторий
 * не кладём: GUID меняются раз в несколько месяцев, при открытии лавки.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const CODE_RE = /^\s*[МM]\s*0*(\d{1,4})\b/i;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUT = path.join(process.cwd(), 'config', '1c-guids.json');

const file = process.argv[2];
if (!file) {
  console.error('Использование: npx tsx scripts/import-1c-guids.ts <файл из 1С>.xlsx');
  process.exit(1);
}

const wb = XLSX.read(fs.readFileSync(file));
const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
  header: 1,
  defval: null,
});

const headerAt = rows.findIndex((r) => r.some((c) => String(c ?? '').trim() === 'Уид'));
if (headerAt < 0) {
  console.error('Не нашёл колонку «Уид» — это точно выгрузка подразделений из 1С?');
  process.exit(1);
}
const header = rows[headerAt].map((c) => String(c ?? '').trim());
const nameCol = header.indexOf('Наименование');
const guidCol = header.indexOf('Уид');

const units: Record<string, { name: string; guid: string }> = {};
for (const r of rows.slice(headerAt + 1)) {
  const name = String(r[nameCol] ?? '').replace(/\s+/g, ' ').trim();
  const guid = String(r[guidCol] ?? '').trim().toLowerCase();
  const m = CODE_RE.exec(name);
  // «М00 Команда открытий» — команда, а не лавка: кода с нулём у лавок нет.
  if (!m || Number(m[1]) === 0) continue;
  if (!GUID_RE.test(guid)) {
    console.warn(`пропущено: у «${name}» GUID «${guid}» не похож на GUID`);
    continue;
  }
  const code = `М${Number(m[1])}`;
  if (units[code]) {
    console.error(`Код ${code} встречается дважды: «${units[code].name}» и «${name}»`);
    process.exit(1);
  }
  units[code] = { name, guid };
}

const sorted = Object.fromEntries(
  Object.entries(units).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1))),
);
fs.writeFileSync(
  OUT,
  `${JSON.stringify({ source: path.basename(file), units: sorted }, null, 2)}\n`,
);
console.log(`${Object.keys(sorted).length} лавок → ${path.relative(process.cwd(), OUT)}`);
