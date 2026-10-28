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

test('PDF по лавке: шапка, итоги, пик дня и все четыре должности', () => {
  const doc = staffingReportDefinition(input(['М50']));
  const text = JSON.stringify(doc);
  assert.match(text, /График пиков/);
  assert.match(text, /М50 Волгоградка · грейд 22-99 млн · с кофемашиной/);
  assert.match(text, /Сформирован 28\.10\.2026, 11:00 мск/);
  assert.match(text, /месяц — 31 день,/);
  // 4 кассира + 4 повара + 2 бариста + 3 уборщика в 11–16.
  assert.match(text, /Пик — 13 человек, 11:00–16:00/);
  assert.match(text, /55\u00a0645 ₽/, 'заработок в день: разряды — неразрывным пробелом');
  assert.match(text, /1\u00a0724\u00a0995 ₽/, 'заработок в месяц: 5564,5 × 310');
  for (const role of ['Кассир', 'Повар', 'Бариста', 'Уборщик']) assert.match(text, new RegExp(role));
  // Одна лавка: сводка на первом листе, все должности — одним вторым.
  assert.equal(pageBreaks(doc.content), 1);
});

test('PDF по сети: каждая должность с нового листа, лавки без должности — списком', () => {
  const doc = staffingReportDefinition(input());
  const text = JSON.stringify(doc);
  assert.match(text, /Все лавки сети · 82 лавки/);
  assert.equal(pageBreaks(doc.content), 4);
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
