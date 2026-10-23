import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Фото витрины: от 1 до 7 на лавку за день. База — временная SQLite;
 * переменные окружения выставляются до первого импорта модулей.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-photos-'));
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
delete process.env.RADAR_STORAGE;

let photos: typeof import('./showcase-photos');

before(async () => {
  photos = await import('./showcase-photos');
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1');

test('формат определяется по байтам, а не по расширению', () => {
  assert.equal(photos.sniffImage(JPEG), 'image/jpeg');
  assert.equal(photos.sniffImage(PNG), 'image/png');
  assert.equal(photos.sniffImage(WEBP), 'image/webp');
  // HTML под видом .jpg — не фото: иначе его отдали бы браузеру как картинку.
  assert.equal(photos.sniffImage(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(photos.sniffImage(Buffer.alloc(0)), null);
});

test('к лавке за день — не больше семи фото', async () => {
  const jpeg = { mime: 'image/jpeg' as const, data: JPEG };

  const three = await photos.addPhotos('2026-10-14', 'М12', [jpeg, jpeg, jpeg]);
  assert.equal(three.length, 3);

  // Три есть, просят ещё пять — отказ целиком, а не «четыре из пяти молча».
  await assert.rejects(
    photos.addPhotos('2026-10-14', 'М12', [jpeg, jpeg, jpeg, jpeg, jpeg]),
    (e: unknown) => e instanceof photos.PhotoLimitError && /ещё 4 из 7/.test(e.message),
  );
  assert.equal((await photos.listPhotos('2026-10-14', 'М12')).length, 3);

  assert.equal((await photos.addPhotos('2026-10-14', 'М12', [jpeg, jpeg, jpeg, jpeg])).length, 7);
  await assert.rejects(
    photos.addPhotos('2026-10-14', 'М12', [jpeg]),
    (e: unknown) => e instanceof photos.PhotoLimitError && /уже 7 фото/.test(e.message),
  );

  // Лимит — на лавку за день, а не на лавку вообще и не на день вообще.
  assert.equal((await photos.addPhotos('2026-10-15', 'М12', [jpeg])).length, 1);
  assert.equal((await photos.addPhotos('2026-10-14', 'М13', [jpeg])).length, 1);
});

test('счётчики — в обоих разрезах редактора', async () => {
  assert.deepEqual(await photos.photoCounts({ date: '2026-10-14' }), {
    '2026-10-14|М12': 7,
    '2026-10-14|М13': 1,
  });
  assert.deepEqual(
    await photos.photoCounts({ shopCode: 'М12', from: '2026-10-01', to: '2026-10-31' }),
    { '2026-10-14|М12': 7, '2026-10-15|М12': 1 },
  );
});

test('фото читается с байтами и удаляется, освобождая место', async () => {
  const [first] = await photos.listPhotos('2026-10-14', 'М12');
  const full = await photos.readPhoto(first.id);
  assert.ok(full);
  assert.equal(full.mime, 'image/jpeg');
  assert.deepEqual(Buffer.from(full.data), JPEG);
  assert.equal(full.size, JPEG.length);

  const gone = await photos.deletePhoto(first.id);
  assert.equal(gone?.shopCode, 'М12');
  assert.equal(await photos.readPhoto(first.id), null);
  assert.equal(await photos.deletePhoto(first.id), null);

  // Было семь — после удаления можно снова добавить одно.
  const png = { mime: 'image/png' as const, data: PNG };
  assert.equal((await photos.addPhotos('2026-10-14', 'М12', [png])).length, 7);
});

test('мусорный id — просто «нет такого фото», а не ошибка базы', async () => {
  assert.equal(await photos.readPhoto('1; DROP TABLE showcase_photo'), null);
  assert.equal(await photos.readPhoto('abc'), null);
  assert.equal(await photos.deletePhoto('-1'), null);
});

test('карточка лавки получает фото по дням периода', async () => {
  const byDate = await photos.photosByDate('М12', '2026-10-01', '2026-10-31');
  assert.deepEqual(Object.keys(byDate), ['2026-10-14', '2026-10-15']);
  assert.equal(byDate['2026-10-14'].length, 7);
  // Старые — первыми, чужая лавка в выборку не попадает.
  const ids = byDate['2026-10-14'].map((p) => Number(p.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.ok(byDate['2026-10-14'].every((p) => p.shopCode === 'М12'));
  assert.deepEqual(await photos.photosByDate('М12', '2026-11-01', '2026-11-30'), {});
});
