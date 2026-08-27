import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { readFixtures } from './fixtures';

const FIXTURES = path.join(process.cwd(), 'fixtures');

test('в fixtures находятся легаси-книга и выгрузки отметок', () => {
  const f = readFixtures(FIXTURES);
  // Число выгрузок не фиксируем: файлы за новые дни добавляются регулярно,
  // и тест не должен краснеть от того, что данных стало больше.
  assert.equal(f.legacy?.name, 'vitriny.xlsx');
  assert.ok(f.attendance.length >= 2, 'должны быть хотя бы выходы и водители');
  assert.ok(
    f.attendance.every((x) => /\.(xls|xlsx)$/i.test(x.name)),
    'все выгрузки — таблицы',
  );
  assert.deepEqual(f.warnings, []);
});

test('тип файла определяется по листам, а не по имени', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-fx-'));
  try {
    // Имя ничего не говорит о содержимом — важен лист «Все данные».
    write(dir, 'какой-то файл.xlsx', ['Все данные']);
    write(dir, 'vitriny-но-не-легаси.xlsx', ['Лист_1']);

    const f = readFixtures(dir);
    assert.equal(f.legacy?.name, 'какой-то файл.xlsx');
    assert.deepEqual(f.attendance.map((x) => x.name), ['vitriny-но-не-легаси.xlsx']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('новые выгрузки подхватываются без правки кода, имя любое', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-fx-'));
  try {
    write(dir, '26.08 выходы (новая выгрузка).xlsx', ['Лист_1']);
    write(dir, 'водители 27-08.xlsx', ['Лист_1']);
    write(dir, 'Витрины.xlsx', ['Все данные']);

    const f = readFixtures(dir);
    assert.equal(f.attendance.length, 2);
    assert.ok(f.legacy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('посторонние файлы и временные файлы Excel игнорируются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-fx-'));
  try {
    write(dir, 'выгрузка.xlsx', ['Лист_1']);
    write(dir, '~$выгрузка.xlsx', ['Лист_1']); // временный файл открытого Excel
    fs.writeFileSync(path.join(dir, 'README.txt'), 'не таблица');
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');

    const f = readFixtures(dir);
    assert.deepEqual(f.attendance.map((x) => x.name), ['выгрузка.xlsx']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('вторая легаси-книга не подменяет первую, а попадает в предупреждения', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-fx-'));
  try {
    write(dir, 'a-витрины.xlsx', ['Все данные']);
    write(dir, 'b-витрины.xlsx', ['Все данные']);

    const f = readFixtures(dir);
    assert.equal(f.legacy?.name, 'a-витрины.xlsx');
    assert.equal(f.attendance.length, 0);
    assert.match(f.warnings.join('\n'), /вторая легаси-книга/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('пустая и отсутствующая папка не роняют сборку', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-fx-'));
  try {
    const empty = readFixtures(dir);
    assert.equal(empty.legacy, null);
    assert.deepEqual(empty.attendance, []);
    assert.equal(empty.warnings.length, 1);

    const missing = readFixtures(path.join(dir, 'нет-такой-папки'));
    assert.equal(missing.legacy, null);
    assert.match(missing.warnings.join(), /нет/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Минимальная книга с заданными листами. */
function write(dir: string, name: string, sheets: string[]): void {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Подразделение']]), s);
  }
  XLSX.writeFile(wb, path.join(dir, name));
}
