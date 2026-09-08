import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAYS_MAX_WIDTH,
  contestReportDefinition,
  contestReportFilename,
  renderContestReport,
  type ContestReportInput,
} from './contest-pdf';
import { scoreOf, sumScores } from './contest';
import type { ContestRow } from './queries';

const DATES = ['2026-09-01', '2026-09-02', '2026-09-03'];

function row(code: string, name: string, region: string | null, statuses: string[]): ContestRow {
  const cells: ContestRow['cells'] = {};
  statuses.forEach((s, i) => {
    if (s === '·') return;
    const status = s === 'g' ? 'green' : s === 'y' ? 'yellow' : 'red';
    cells[DATES[i]] = { status, fill: 0.9, points: status === 'green' ? 1 : status === 'red' ? -1 : 0 };
  });
  const score = scoreOf(Object.values(cells).map((c) => c.status));
  return { shop: { code, name, region }, cells, score, avgFill: score.rated ? 0.9 : null };
}

function input(): ContestReportInput {
  const rows = [
    row('М4', 'М4 Спиридоновка', 'Лясецкая Юлия', ['g', 'g', 'y']),
    row('М13', 'М13 Ордынка', 'Осин Анатолий', ['r', 'r', '·']),
  ];
  const total = sumScores(rows.map((r) => r.score));

  return {
    from: DATES[0],
    to: DATES[2],
    dates: DATES,
    rows,
    regions: [
      { region: 'Лясецкая Юлия', shops: 1, score: rows[0].score, avgFill: 0.9 },
      { region: 'Осин Анатолий', shops: 1, score: rows[1].score, avgFill: 0.9 },
    ],
    total,
    generatedAt: new Date('2026-09-08T09:41:00Z'),
  };
}

test('в отчёте есть период, лавки и РМ', () => {
  const doc = contestReportDefinition(input());
  const text = JSON.stringify(doc);

  assert.match(text, /Конкурс по витринам/);
  assert.match(text, /01\.09\.2026 — 03\.09\.2026/);
  assert.match(text, /М4 Спиридоновка/);
  assert.match(text, /Осин Анатолий/);
  assert.match(text, /\+2/, 'балл лавки должен быть со знаком');
});

test('эмодзи и стрелок в отчёте нет — Roboto их не рисует', () => {
  const text = JSON.stringify(contestReportDefinition(input()));

  // Пустой прямоугольник вместо символа — то, что видит человек, открывший PDF.
  assert.doesNotMatch(text, /[🔴🟡🟢⬜⚪]/u, 'эмодзи в PDF не рисуются');
  assert.doesNotMatch(text, /[→←↑↓✓✔•]/u, 'стрелки и галочки в Roboto тоже пустые');
});

test('фильтры видны в шапке отчёта — иначе непонятно, чьи это цифры', () => {
  const doc = contestReportDefinition({ ...input(), region: 'Осин Анатолий', shop: 'М13' });
  const text = JSON.stringify(doc);

  assert.match(text, /РМ Осин Анатолий/);
  assert.match(text, /поиск «М13»/);
});

test('день без витрины не рисуется квадратом', () => {
  const doc = contestReportDefinition(input());
  const text = JSON.stringify(doc);
  const squares = text.match(/"type":"rect"/g) ?? [];

  // 3 квадрата легенды + 3 дня первой лавки + 2 дня второй: третий у неё пуст.
  assert.equal(squares.length, 3 + 3 + 2);
});

test('за месяц полоса дней сжимается, а не вылезает за поля листа', () => {
  const dates = Array.from({ length: 31 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
  const doc = contestReportDefinition({ ...input(), from: dates[0], to: dates[30], dates });

  const table = (doc.content as { table?: { widths?: unknown[] } }[]).find(
    (c) => Array.isArray(c.table?.widths) && c.table.widths.length === 7,
  );
  const daysWidth = table?.table?.widths?.[3] as number;

  assert.ok(daysWidth > 0, 'колонка дней потерялась');
  assert.ok(daysWidth <= DAYS_MAX_WIDTH, `полоса на ${daysWidth}pt шире отведённых ${DAYS_MAX_WIDTH}`);
});

test('время формирования — московское, а не серверное UTC', () => {
  // Хостинг живёт в UTC: без явной зоны отчёт, собранный в 12:41 по Москве,
  // подписывался бы «09:41».
  const text = JSON.stringify(contestReportDefinition(input()));
  assert.match(text, /Сформирован 08\.09\.2026, 12:41 мск/);
});

test('имя файла с периодом, латиницей', () => {
  assert.equal(
    contestReportFilename('2026-09-01', '2026-09-03'),
    'konkurs-vitriny-2026-09-01_2026-09-03.pdf',
  );
});

test('PDF собирается и открывается как PDF', async () => {
  const pdf = await renderContestReport(input());

  assert.ok(pdf.length > 1000, `подозрительно маленький файл: ${pdf.length} байт`);
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', 'это не PDF');
  assert.match(pdf.subarray(-1024).toString('latin1'), /%%EOF/, 'файл оборван');
});
