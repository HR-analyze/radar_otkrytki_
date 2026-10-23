import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-norms-upload-'));
const fixtures = path.join(dir, 'fixtures');
process.env.RADAR_STORAGE = 'snapshot';
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_FIXTURES_DIR = fixtures;
process.env.RADAR_SHOP_NORMS_PATH = path.join(fixtures, 'shop-norms.json');
process.env.RADAR_SNAPSHOT_PATH = path.join(dir, 'snapshot.json');
process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'showcase.json');
delete process.env.RADAR_UPLOAD_TOKEN;
fs.mkdirSync(fixtures);
fs.writeFileSync(process.env.RADAR_SHOWCASE_PATH, JSON.stringify({ days: {} }));

// Действующие нормы: справочник, собранный раньше из CSV.
const seedNorm = (code: string, driverAt: string | null, cookAt: string[], departureAt: string | null) => ({
  code, name: code, driverAt, cookAt, departureAt, rawDriver: driverAt, rawCook: null, rawDeparture: departureAt,
  source: 'reference', warnings: [],
});
fs.writeFileSync(
  process.env.RADAR_SHOP_NORMS_PATH,
  JSON.stringify({
    source: 'normy-lavok.csv',
    norms: [
      seedNorm('М1', '06:30', ['06:20'], '03:50'),
      seedNorm('М2', '06:30', ['06:20'], '04:30'),
      seedNorm('М99', '06:00', ['06:00'], null),
    ],
  }),
);
fs.writeFileSync(path.join(fixtures, 'normy-lavok.csv'), ',название,время приезда водителя\n');

/** Справочник как из Google-таблицы: лист «Лавки», шапка в первой строке. */
function book(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [null, 'название', 'размер витрины общий', 'время приезда водителя', 'количество поваров и тайминг', 'погрузка на рц', 'время в пути до лавки'],
      ...rows,
    ]),
    'Лавки',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const NEW_BOOK = book([
  ['М01', 'Милютинский', '852см', '6.00', '3 с 6.20', '3:50', null],
  ['М02', 'Покровка', '8 430 мм', '6.30', '3 с 6.20', '4:30', '1:40'],
  ['М03', 'Пресня', '7,095 м', '6.40', '3 с 6:30', '5:10', null],
]);

test('справочник норм опознаётся по шапке, выгрузки — нет', async () => {
  const { detectFixtureKind, peekGrid } = await import('./fixtures');
  assert.equal(detectFixtureKind(['Лавки'], peekGrid(NEW_BOOK)), 'norms');
  assert.equal(
    detectFixtureKind(['Лист_1'], [['Сотрудник', 'Должность', 'Подразделение'], ['Иванов', 'Повар', 'М1']]),
    'attendance',
    '«Повар» в строках, а не в шапке — это выгрузка отметок',
  );
});

test('разбор: что поменяется, новые и пропавшие лавки, файл и пересобранный JSON', async () => {
  const { inspectUpload } = await import('./uploads');
  const { loadConfig } = await import('./config');
  const r = inspectUpload('Справочник лавок.xlsx', NEW_BOOK, loadConfig());
  assert.ok(r.ok, r.ok ? '' : r.error);
  const f = r.file;

  assert.equal(f.kind, 'norms');
  assert.equal(f.fileName, 'normy-lavok.xlsx');
  assert.match(f.summary, /3 лавки: приезд водителя у 3, повара у 3, выезд с РЦ у 3/);

  const notes = f.notes.join('\n');
  assert.match(notes, /Поменяется у 3 лавки/);
  assert.match(notes, /М1: водитель 06:30 → 06:00/);
  assert.doesNotMatch(notes, /М2:/, 'у М2 ничего не поменялось');
  assert.match(notes, /М3 \(новая\): водитель 06:40, повара 06:30, выезд с РЦ 05:10/);
  assert.match(notes, /Нет в справочнике — нормы снимутся: М99/);

  const seed = JSON.parse(f.extraFiles![0].buffer.toString('utf8'));
  assert.equal(f.extraFiles![0].fileName, 'shop-norms.json');
  assert.equal(seed.source, 'normy-lavok.xlsx');
  assert.deepEqual(seed.norms.map((n: { code: string }) => n.code), ['М1', 'М2', 'М3']);
});

test('справочник без изменений так и называется', async () => {
  const { normsChanges } = await import('./uploads');
  const { readNormsSeed } = await import('./shop-norms-store');
  const same = readNormsSeed();
  assert.deepEqual(normsChanges(same, same), { lines: [], changed: 0 });
});

test('загрузка: справочник и JSON легли в fixtures, CSV вытеснен, ручная правка названа', async () => {
  const { POST } = await import('../app/api/upload/route');
  const { saveNormsEdits, readNorms, readNormsSeed } = await import('./shop-norms-store');

  // Правка с «Порогов» главнее справочника — загрузка её не трогает.
  await saveNormsEdits([{ shopCode: 'М2', driverAt: '05:00', cookAt: ['05:00'] }]);

  const form = new FormData();
  form.append('files', new File([new Uint8Array(NEW_BOOK)], 'Справочник лавок.xlsx'));
  const res = await POST(new Request('http://localhost/api/upload', { method: 'POST', body: form }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  const files = fs.readdirSync(fixtures).sort();
  assert.ok(files.includes('normy-lavok.xlsx'));
  assert.ok(files.includes('shop-norms.json'));
  assert.ok(!files.includes('normy-lavok.csv'), 'прежний CSV вытеснен');

  assert.equal(readNormsSeed().find((n) => n.code === 'М1')?.driverAt, '06:00', 'новый справочник действует');
  const norms = (await readNorms()).byCode;
  assert.equal(norms['М2'].driverAt, '05:00', 'ручная правка осталась');
  assert.match(body.notes.join(' '), /правили руками на вкладке «Пороги».*М2/);
});
