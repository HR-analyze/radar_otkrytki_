import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-showcase-upload-'));
process.env.RADAR_STORAGE = 'snapshot';
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'showcase.json');
process.env.RADAR_FIXTURES_DIR = path.join(dir, 'fixtures');
process.env.RADAR_UPLOAD_LOG_PATH = path.join(dir, 'upload-log.json');
delete process.env.RADAR_UPLOAD_TOKEN;
fs.mkdirSync(process.env.RADAR_FIXTURES_DIR);
fs.writeFileSync(process.env.RADAR_SHOWCASE_PATH, JSON.stringify({ days: {} }));

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * Книга как из Google-таблицы: «Все данные» от легаси-книги на месте, витрины —
 * на листах «Витрины 0800» и «Витрины 1600», проценты записаны тремя способами.
 */
function book(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['Регион', 'Лавка', 'Параметр', null, d('2026-08-20')]]),
    'Все данные',
  );

  const morning = XLSX.utils.aoa_to_sheet([
    ['Лавка', d('2026-10-08'), d('2026-10-09'), d('2026-10-10')],
    ['М1 Милютинский', 95, 100, 'вых'],
    ['М2 Покровка', 0.9, 1, '100 на 9 утра (поставка пришла в 8 утра)'],
    ['М31 Аэропорт', 'Поставка 7:42 (просмотр на 8:42) 100%', '95% просмотр на 8:34', null],
    ['М84 Котельники (откр. с 12.10.)', null, null, null],
    ['Итого', 0.93, null, null],
    ['М9 Солянка', 250, '8:40', -5],
  ]);
  // Доли в Google-таблице лежат в ячейках с форматом «0%»: 1 там — это 100%.
  for (const ref of ['B3', 'C3']) morning[ref].z = '0%';
  XLSX.utils.book_append_sheet(wb, morning, 'Витрины 0800');

  const afternoon = XLSX.utils.aoa_to_sheet([
    ['Лавка', d('2026-10-08'), d('2026-10-09'), d('2026-10-10')],
    ['М1 Милютинский', 80, null, null],
    ['М2 Покровка', null, 'после поставки', 70],
    ['М3 Пресня', 75, null, null],
  ]);
  // Объединение на две даты: значение лежит только в первой ячейке.
  afternoon['!merges'] = [XLSX.utils.decode_range('B4:C4')];
  XLSX.utils.book_append_sheet(wb, afternoon, 'Витрины 1600');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test('книга витрин опознаётся по листам 0800/1600, хотя «Все данные» в ней тоже есть', async () => {
  const { detectFixtureKind } = await import('./fixtures');
  const { showcaseSlotOfSheet } = await import('./parsers/showcase-sheets');
  assert.equal(detectFixtureKind(['Все данные', 'Витрины 0800', 'Витрины 1600']), 'showcase');
  assert.equal(detectFixtureKind(['Все данные']), 'legacy', 'старая книга — по-прежнему легаси');
  assert.equal(showcaseSlotOfSheet('Витрины 08:00 '), 'morning');
  assert.equal(showcaseSlotOfSheet('витрина 8.00'), 'morning');
  assert.equal(showcaseSlotOfSheet('Витрины 1600'), 'afternoon');
  assert.equal(showcaseSlotOfSheet('Витрины'), null);
  assert.equal(showcaseSlotOfSheet('Статистика'), null);
});

test('ячейка: число, доля, текст с процентом и текст без него', async () => {
  const { readCell } = await import('./parsers/showcase-sheets');
  assert.deepEqual(readCell(95), { fill: 0.95 });
  assert.deepEqual(readCell(0.95), { fill: 0.95 });
  assert.deepEqual(readCell(1), { fill: 1 }, 'единица — это 100%: доли записаны в формате «0%»');
  assert.deepEqual(readCell('95%'), { fill: 0.95 });
  assert.deepEqual(readCell('0,9'), { fill: 0.9 });
  assert.deepEqual(readCell(' 100 '), { fill: 1 });
  assert.deepEqual(readCell('100 на 9 утра'), { fill: 1, text: '100 на 9 утра' });
  assert.deepEqual(readCell('Поставка 7:42 (просмотр на 8:42) 100%'), { fill: 1, text: 'Поставка 7:42 (просмотр на 8:42) 100%' });
  assert.deepEqual(readCell('вых'), { fill: null, text: 'вых' });
  assert.deepEqual(readCell('8:40 пришла поставка'), { fill: null, text: '8:40 пришла поставка' }, 'время — не процент');
  assert.equal(readCell(null), null);
  assert.equal(readCell('   '), null);
  assert.ok('error' in readCell(250)!);
  assert.ok('error' in readCell(-5)!);
});

test('разбор книги: оба замера, комментарии, сомнительные ячейки названы', async () => {
  const { inspectUpload } = await import('./uploads');
  const { loadConfig } = await import('./config');
  const r = inspectUpload('Радар открытия.xlsx', book(), loadConfig());
  assert.ok(r.ok, r.ok ? '' : r.error);
  const f = r.file;

  assert.equal(f.kind, 'showcase');
  assert.deepEqual(f.dates, ['2026-10-08', '2026-10-09', '2026-10-10']);
  const byKey = new Map(f.showcase.map((e) => [`${e.shopCode}|${e.date}`, e]));
  assert.deepEqual(byKey.get('М1|2026-10-08'), { date: '2026-10-08', shopCode: 'М1', fill: 0.95, afternoonFill: 0.8 });
  assert.deepEqual(byKey.get('М1|2026-10-10'), { date: '2026-10-10', shopCode: 'М1', note: 'вых' });
  assert.deepEqual(byKey.get('М2|2026-10-09'), {
    date: '2026-10-09', shopCode: 'М2', fill: 1, note: '16:00: после поставки',
  });
  assert.deepEqual(byKey.get('М2|2026-10-10'), {
    date: '2026-10-10', shopCode: 'М2', fill: 1, afternoonFill: 0.7, note: '100 на 9 утра (поставка пришла в 8 утра)',
  });
  assert.equal(byKey.get('М31|2026-10-09')?.fill, 0.95);
  assert.ok(!f.showcase.some((e) => e.shopCode === 'М84'), 'пустая строка ничего не шлёт');
  assert.ok(!f.showcase.some((e) => e.shopCode === 'М9' && e.fill != null), 'мусор не стал процентом');

  const notes = f.notes.join('\n');
  assert.match(notes, /«Витрины 0800»!D2 · М1 · 10\.10: «вых» → процента нет/);
  assert.match(notes, /«Витрины 0800»!D3 · М2 · 10\.10: .* → 100% и комментарий/);
  assert.match(notes, /строка 6: не понял лавку «Итого»/);
  assert.match(notes, /«Витрины 0800»!B7 \(М9, 2026-10-08\): «250» — не процент/);
  assert.match(notes, /«Витрины 1600»!B4:C4: ячейка объединена/);
  assert.match(f.summary, /на 08:00 — 7 значений, на 16:00 — 3 значения/);
});

test('книга, где витрины не заполнены, отклоняется', async () => {
  const { inspectUpload } = await import('./uploads');
  const { loadConfig } = await import('./config');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Лавка', d('2026-10-08')], ['М1', null]]), 'Витрины 0800');
  const r = inspectUpload('пусто.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, loadConfig());
  assert.equal(r.ok, false);
});

test('загрузка: значения легли в базу, файл в fixtures не попал, пустое не затёрто', async () => {
  const { POST } = await import('../app/api/upload/route');
  const { saveShowcaseEdits, readShowcase } = await import('./showcase-store');

  // Уже вписанное в радаре: в книге за этот день у М31 пусто — должно остаться.
  await saveShowcaseEdits([{ date: '2026-10-10', shopCode: 'М31', fill: 0.85 }]);

  const form = new FormData();
  form.append('files', new File([new Uint8Array(book())], 'Радар открытия.xlsx'));
  const res = await POST(new Request('http://localhost/api/upload', { method: 'POST', body: form }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.visible, 'now');
  assert.match(body.notes.join(' '), /обновлено \d+ значени/);

  assert.deepEqual(fs.readdirSync(process.env.RADAR_FIXTURES_DIR!), [], 'книга в fixtures/ не кладётся');

  const store = await readShowcase();
  assert.equal(store.days['2026-10-08']['М1'], 0.95);
  assert.equal(store.afternoon['2026-10-08']['М1'], 0.8);
  assert.equal(store.days['2026-10-08']['М2'], 0.9);
  assert.equal(store.days['2026-10-10']['М31'], 0.85, 'пустая ячейка книги не стёрла значение');
  assert.equal(store.days['2026-10-10']['М1'], undefined, '«вых» — без процента');
  assert.equal(store.notes['2026-10-10']['М1'], 'вых');

  const { readUploadLog } = await import('./upload-log');
  const [logged] = await readUploadLog();
  assert.equal(logged.kind, 'showcase', 'загрузка видна в «Истории»');
});
