import test from 'node:test';
import assert from 'node:assert/strict';
import type { Content } from 'pdfmake/interfaces';
import { readStaffing } from './staffing-store';
import { renderStaffingReport, staffingReportDefinition, type StaffingReportInput } from './staffing-pdf';

const seed = readStaffing();
const input = (codes?: string[]): StaffingReportInput => ({
  shown: codes ? seed.norms.filter((n) => codes.includes(n.code)) : seed.norms,
  source: seed.source,
  builtAt: seed.builtAt,
  generatedAt: new Date('2026-10-28T08:00:00Z'),
});

const pageBreaks = (content: Content): number => JSON.stringify(content).split('"pageBreak":"before"').length - 1;

test('PDF по лавке: шапка, итоги, пик дня, должности и расстановка', () => {
  const doc = staffingReportDefinition(input(['М50']));
  const text = JSON.stringify(doc);
  assert.match(text, /График пиков/);
  assert.match(text, /М50 Волгоградка · грейд 22-99 млн · с кофемашиной/);
  assert.match(text, /Сформирован 28\.10\.2026, 11:00 мск/);
  assert.match(text, /месяц — 31 день,/);
  // 6 кассиров + 4 повара + 2 бариста + 3 уборщика + 2 зама + сборщик в 11–16
  // (финальная книга 30.10.2026; су-шефа у М50 по ШР нет).
  assert.match(text, /Пик — 18 человек, 11:00–16:00/);
  assert.match(text, /77\u00a0265 ₽/, 'заработок в день: разряды — неразрывным пробелом');
  assert.match(text, /2\u00a0395\u00a0215 ₽/, 'заработок в месяц: день × 31');
  for (const role of ['Кассир', 'Повар', 'Бариста', 'Уборщик', 'ЗД по бару', 'ЗД по залу', 'Су-шеф', 'Сборщик заказов']) {
    assert.match(text, new RegExp(role));
  }
  // Расстановка — отдельным листом, с пометкой, где расписали не всех.
  assert.match(text, /Расстановка по дислокациям/);
  // 7:30–11 по правилу: сборщик на смене — доставка на нём, кассиры все официанты.
  assert.match(text, /6 официант/);
  assert.match(text, /сборка заказов \+ доставка/);
  assert.match(text, /расписано 5 из 6/);
  // Расстановка графиком: окно — блок на свои получасы (11–16 — десять колонок),
  // под графиком — то же списком.
  assert.match(text, /"colSpan":10/);
  assert.match(text, /То же списком/);
  // Сводка, должности, расстановка — три листа, два разрыва.
  assert.equal(pageBreaks(doc.content), 2);
});

test('PDF по сети: каждая должность с нового листа, лавки без должности — списком', () => {
  const doc = staffingReportDefinition(input());
  const text = JSON.stringify(doc);
  assert.match(text, /Все лавки сети · 82 лавки/);
  // Четыре должности шаблона и лист замов со сборщиками.
  assert.equal(pageBreaks(doc.content), 5);
  assert.match(text, /Сборщик заказов есть в 24 лавках/);
  // Су-шеф по ШР: 17 лавок по одному, М35 и М68 — по половине.
  assert.match(text, /Су-шеф есть в 19 лавках/);
  assert.match(text, /М35 \(0,5\)/);
  assert.doesNotMatch(text, /Расстановка по дислокациям/, 'по сети расстановки нет — она у каждой лавки своя');
  assert.match(text, /Итого по сети/);
  assert.match(text, /Без бариста по шаблону — \d+ лав/);
});

test('PDF: должности нет в лавке — так и написано, без пустой таблицы', () => {
  const text = JSON.stringify(staffingReportDefinition(input(['М1'])));
  assert.match(text, /В этой лавке бариста по шаблону нет\./);
});

test('PDF собирается в файл', async () => {
  const pdf = await renderStaffingReport(input(['М50']));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 10_000, `${pdf.length} байт`);
});
