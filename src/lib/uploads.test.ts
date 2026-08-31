import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { loadConfig } from './config';
import { githubTargetFromEnv } from './connectors/github';
import {
  canonicalFixtureName,
  inspectUpload,
  isSupersededBy,
  MAX_UPLOAD_BYTES,
  safeDisplayName,
} from './uploads';

const FIXTURES = path.join(process.cwd(), 'fixtures');
const config = loadConfig();

function upload(name: string) {
  return inspectUpload(name, fs.readFileSync(path.join(FIXTURES, name)), config);
}

test('выгрузка «выходы» распознаётся и получает каноническое имя своего дня', () => {
  const r = upload('2026-08-28_vyhody.xls');
  assert.ok(r.ok, 'файл должен быть распознан');

  assert.equal(r.file.kind, 'attendance');
  assert.match(r.file.summary, /Выгрузка «выходы»/);
  assert.deepEqual(r.file.dates, ['2026-08-28']);
  // Имя файла выводится из содержимого — как бы его ни назвали на диске.
  assert.equal(r.file.fileName, '2026-08-28_vyhody.xls');
  assert.ok(r.file.rows > 0 && r.file.shops > 0);
});

test('выгрузка «водители» отличается от «выходов» по должностям в файле', () => {
  const r = upload('2026-08-28_voditeli.xls');
  assert.ok(r.ok);

  assert.match(r.file.summary, /Выгрузка «водители»/);
  assert.equal(r.file.fileName, '2026-08-28_voditeli.xls');
});

test('выгрузка за несколько дней получает имя-диапазон', () => {
  const r = upload('2026-08-19_2026-08-24_vyhody.xls');
  assert.ok(r.ok);

  assert.equal(r.file.fileName, '2026-08-19_2026-08-24_vyhody.xls');
  assert.ok(r.file.dates.length > 1);
  assert.match(r.file.summary, /дней/);
});

test('новый формат 1С распознаётся так же, как старый, и различает роли сам', () => {
  // С 29.08.2026 выгрузка приходит с группировкой в две строки. Для человека,
  // который жмёт кнопку, разницы быть не должно.
  const employees = upload('2026-08-30_vyhody.xlsx');
  assert.ok(employees.ok);
  assert.match(employees.file.summary, /Выгрузка «выходы»/);
  assert.equal(employees.file.fileName, '2026-08-30_vyhody.xlsx');

  const drivers = upload('2026-08-30_voditeli.xls');
  assert.ok(drivers.ok);
  assert.match(drivers.file.summary, /Выгрузка «водители»/);
  assert.equal(drivers.file.fileName, '2026-08-30_voditeli.xls');
});

test('ночная смена не превращает выгрузку за день в выгрузку за два', () => {
  // В выгрузке за 29.08 две отметки ушли на 30.08 — это хвост ночной смены,
  // а не второй день: файл должен остаться «за 29-е».
  const r = upload('2026-08-29_vyhody.xls');
  assert.ok(r.ok);
  assert.equal(r.file.fileName, '2026-08-29_vyhody.xls');
  assert.deepEqual(r.file.dates, ['2026-08-29', '2026-08-30']);
  assert.match(r.file.summary, /после полуночи/);
});

test('незнакомая должность называется поимённо, а не прячется в счётчике', () => {
  // Её строки не попадают ни в один критерий, поэтому промолчать нельзя:
  // цифры на дашборде будут посчитаны без этих людей.
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Подразделение', 'Сотрудник', 'Должность', 'Подразделение сотрудника', 'Приход', 'Уход'],
      ['М1 Милютинский', 'Иванов И.И.', 'Флорист', 'М1 Милютинский', '31.08.2026 6:05:00', null],
      ['М1 Милютинский', 'Петров П.П.', 'Флорист', 'М1 Милютинский', '31.08.2026 6:07:00', null],
      ['М2 Покровка', 'Сидоров С.С.', 'Уборщик', 'М2 Покровка', '31.08.2026 6:10:00', null],
      ['М2 Покровка', 'Кузнецов К.К.', 'Повар', 'М2 Покровка', '31.08.2026 5:55:00', null],
    ]),
    'Лист1',
  );
  const r = inspectUpload(
    'выгрузка.xlsx',
    Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as ArrayBuffer),
    config,
  );
  assert.ok(r.ok);

  // Уборщик заведён как посторонняя должность — про него сообщать незачем.
  assert.deepEqual(r.file.unknownRoles, [{ role: 'Флорист', rows: 2 }]);
});

test('в реальных выгрузках незнакомых должностей не осталось', () => {
  // Если 1С заведёт новую должность, тест упадёт и напомнит завести её в конфиге.
  for (const name of ['2026-08-30_vyhody.xlsx', '2026-08-31_vyhody.xls', '2026-08-31_voditeli.xls']) {
    const r = upload(name);
    assert.ok(r.ok);
    assert.deepEqual(r.file.unknownRoles, [], `${name}: ${JSON.stringify(r.file.unknownRoles)}`);
  }
});

test('пропущенные строки объясняются словами, а не числом предупреждений', () => {
  const r = upload('2026-08-31_vyhody.xls');
  assert.ok(r.ok);

  const text = r.file.notes.join(' | ');
  assert.match(text, /без отметки времени/, text);
  assert.match(text, /не в своей лавке/, text);
});

test('легаси-книга и журнал отгрузок опознаются по своим листам', () => {
  const legacy = upload('vitriny.xlsx');
  assert.ok(legacy.ok);
  assert.equal(legacy.file.kind, 'legacy');
  assert.equal(legacy.file.fileName, 'vitriny.xlsx');
  assert.match(legacy.file.summary, /Книга «Витрины»/);

  const delivery = upload('vremya-postavki.xlsx');
  assert.ok(delivery.ok);
  assert.equal(delivery.file.kind, 'delivery');
  assert.equal(delivery.file.fileName, 'vremya-postavki.xlsx');
  assert.match(delivery.file.summary, /Время поставки/);
});

test('повторная загрузка того же дня заменяет файл, а не кладёт второй', () => {
  // Иначе отметки задвоились бы, а вторая легаси-книга молча не попала бы в снимок.
  const first = upload('2026-08-27_vyhody.xls');
  const again = inspectUpload(
    'выгрузка (1).xls',
    fs.readFileSync(path.join(FIXTURES, '2026-08-27_vyhody.xls')),
    config,
  );
  assert.ok(first.ok && again.ok);
  assert.equal(again.file.fileName, first.file.fileName);
});

test('легаси-книга в другом формате вытесняет прежнюю, а не ложится рядом', () => {
  assert.ok(isSupersededBy('vitriny.xlsx', 'vitriny.xls'));
  assert.ok(!isSupersededBy('vitriny.xlsx', 'vitriny.xlsx'), 'тот же файл просто перезаписывается');
  assert.ok(!isSupersededBy('2026-08-27_vyhody.xls', 'vitriny.xls'));
});

test('не-таблица и посторонняя книга отклоняются с понятной причиной', () => {
  const notATable = inspectUpload('отчёт.pdf', Buffer.from('%PDF-1.4'), config);
  assert.ok(!notATable.ok);
  assert.match(notATable.error, /\.xls/);

  const broken = inspectUpload('выгрузка.xls', Buffer.from('это просто текст'), config);
  assert.ok(!broken.ok);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Товар', 'Цена']]), 'Лист1');
  const foreign = inspectUpload(
    'продажи.xlsx',
    Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as ArrayBuffer),
    config,
  );
  assert.ok(!foreign.ok, 'книга без колонок отметок — не выгрузка');
  assert.match(foreign.error, /Подразделение/);
});

test('пустой и слишком большой файлы не доходят до парсера', () => {
  const empty = inspectUpload('выгрузка.xls', Buffer.alloc(0), config);
  assert.ok(!empty.ok);
  assert.match(empty.error, /пустой/);

  const huge = inspectUpload('выгрузка.xls', Buffer.alloc(MAX_UPLOAD_BYTES + 1), config);
  assert.ok(!huge.ok);
  assert.match(huge.error, /МБ/);
});

test('имя файла из браузера чистится от пути и управляющих символов', () => {
  assert.equal(safeDisplayName('C:\\Users\\ivan\\выходы.xls'), 'выходы.xls');
  assert.equal(safeDisplayName('/tmp/../выходы.xls'), 'выходы.xls');
  assert.equal(safeDisplayName('вы\u0000ходы.xls'), 'выходы.xls');
  assert.equal(safeDisplayName('  '), 'без имени');
});

test('каноническое имя не зависит от регистра расширения', () => {
  assert.equal(canonicalFixtureName('legacy', ['2026-08-28'], 'Витрины.XLSX'), 'vitriny.xlsx');
  assert.equal(
    canonicalFixtureName('attendance', ['2026-08-28'], 'ВЫХОДЫ.XLS', 'vyhody'),
    '2026-08-28_vyhody.xls',
  );
});

test('репозиторий для коммита берётся из окружения Vercel, если не задан явно', () => {
  assert.equal(githubTargetFromEnv({}), null, 'без токена загрузки нет');

  const fromVercel = githubTargetFromEnv({
    RADAR_GITHUB_TOKEN: 'x',
    VERCEL_GIT_REPO_OWNER: 'HR-analyze',
    VERCEL_GIT_REPO_SLUG: 'radar_otkrytki_',
    VERCEL_GIT_COMMIT_REF: 'main',
  });
  assert.deepEqual(
    { owner: fromVercel?.owner, repo: fromVercel?.repo, branch: fromVercel?.branch, dir: fromVercel?.dir },
    { owner: 'HR-analyze', repo: 'radar_otkrytki_', branch: 'main', dir: 'fixtures' },
  );

  const explicit = githubTargetFromEnv({
    GITHUB_TOKEN: 'x',
    RADAR_GITHUB_REPO: 'команда/радар',
    RADAR_GITHUB_BRANCH: 'data',
    VERCEL_GIT_REPO_OWNER: 'ignored',
  });
  assert.equal(explicit?.owner, 'команда');
  assert.equal(explicit?.repo, 'радар');
  assert.equal(explicit?.branch, 'data');
});
