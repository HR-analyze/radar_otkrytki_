import test from 'node:test';
import assert from 'node:assert/strict';
import {
  driverCookReportDefinition,
  driverCookReportFilename,
  renderDriverCookReport,
} from './driver-cook-pdf';
import { analyzeDriverCook } from './driver-cook';
import type { AttendanceRow, CriterionKey } from './types';

function mark(
  date: string,
  shopCode: string,
  criterion: CriterionKey,
  role: string,
  name: string,
  time: string,
): AttendanceRow {
  const [h, m] = time.split(':').map(Number);
  return {
    date,
    shopCode,
    shopName: `${shopCode} Тестовая`,
    employeeName: name,
    role,
    criterion,
    trainee: false,
    homeShopCode: null,
    arrivalMinutes: h * 60 + m,
    arrivalSource: 'mark',
    rawArrival: `${date.slice(8)}.${date.slice(5, 7)}.${date.slice(0, 4)} ${time}`,
    rawDeparture: null,
    status: 'green',
    note: null,
  };
}

const DATES = ['2026-09-01', '2026-09-02', '2026-09-03'];

function report(pairsPerDay = true) {
  const rows = DATES.flatMap((d) => [
    // М24: отметки сходятся секунда в секунду, лавка пустая.
    mark(d, 'М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '6:03:10'),
    mark(d, 'М24', 'cook', 'Повар', 'Повар Первый', '6:03:02'),
    // М30: обычный день — повар задолго до водителя.
    mark(d, 'М30', 'driver', 'Водитель-экспедитор', 'Смирнов Виктор', '7:20:00'),
    mark(d, 'М30', 'cook', 'Повар', 'Повар Второй', '6:00:00'),
    // М40: водитель приехал первым и заметно раньше.
    mark(d, 'М40', 'driver', 'Водитель-экспедитор', 'Лупинос Иван', '5:30:00'),
    ...(pairsPerDay ? [mark(d, 'М40', 'cook', 'Повар', 'Повар Третий', '6:10:00')] : []),
  ]);

  return analyzeDriverCook(rows, DATES[0], DATES[DATES.length - 1]);
}

const STAMP = new Date('2026-09-16T09:00:00Z');

/** Весь текст документа одной строкой — по нему и проверяем содержимое. */
function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>)
      .filter(([k]) => ['text', 'stack', 'columns', 'table', 'body', 'ul'].includes(k))
      .map(([, v]) => textOf(v))
      .join(' ');
  }
  return '';
}

test('в отчёте есть период, фильтры и время формирования', () => {
  const def = driverCookReportDefinition({
    report: report(),
    region: 'Осин Анатолий',
    shop: 'М24',
    generatedAt: STAMP,
  });
  const text = textOf(def.content);

  assert.match(text, /01\.09\.2026 — 03\.09\.2026/);
  assert.match(text, /РМ Осин Анатолий/);
  assert.match(text, /поиск «М24»/);
  assert.match(text, /Сформирован 16\.09\.2026/);
  assert.equal(def.info?.title, 'Сверка отметок 2026-09-01 — 2026-09-03');
});

test('вывод словами называет число совпадений и лавку-рекордсмена', () => {
  const text = textOf(
    driverCookReportDefinition({ report: report(), generatedAt: STAMP }).content,
  );

  // Три дня совпадений по М24 — и ни одного по остальным лавкам.
  assert.match(text, /Отметки сошлись на пустой лавке в 3 лавко-днях/);
  assert.match(text, /всех лавко-дней сверки/);
  assert.match(text, /М24 Тестовая — 3 из 3/);
  assert.match(text, /Осипов Сергей — 3/);
});

test('когда совпадений нет, отчёт говорит это прямо, а не пустой таблицей', () => {
  const rows = DATES.flatMap((d) => [
    mark(d, 'М30', 'driver', 'Водитель-экспедитор', 'Смирнов Виктор', '7:20:00'),
    mark(d, 'М30', 'cook', 'Повар', 'Повар Второй', '6:00:00'),
  ]);
  const text = textOf(
    driverCookReportDefinition({
      report: analyzeDriverCook(rows, DATES[0], DATES[2]),
      generatedAt: STAMP,
    }).content,
  );

  assert.match(text, /Совпадений не нашлось/);
  assert.match(text, /отметки водителя и повара нигде не сошлись/);
});

test('пустая сверка объясняет, каких выгрузок не хватает', () => {
  const text = textOf(
    driverCookReportDefinition({
      report: analyzeDriverCook([], DATES[0], DATES[2]),
      generatedAt: STAMP,
    }).content,
  );

  assert.match(text, /нужны и «выходы», и «водители»/);
});

test('счётчик подписан лавко-днями, а не днями', () => {
  // Единица счёта — «лавка + день»: 1451 в таблице случаев это не 1451 день.
  // Подпись «Дней» над этой колонкой уже путала читателя отчёта.
  const text = textOf(
    driverCookReportDefinition({ report: report(), generatedAt: STAMP }).content,
  );

  assert.match(text, /Лавко-дней/);
  assert.match(text, /Единица счёта — лавко-день/);
  // У водителя счётчик тоже в лавко-днях: за смену он объезжает несколько лавок.
  assert.doesNotMatch(text, /\| Дней \|/);
});

test('методика в отчёте остаётся: без неё цифрам нельзя верить', () => {
  const text = textOf(
    driverCookReportDefinition({ report: report(), generatedAt: STAMP }).content,
  );

  assert.match(text, /Как это считалось/);
  assert.match(text, /уход − 30 минут/);
  assert.match(text, /повод разобраться, а не приговор/);
});

test('пороги из отчёта попадают в подписи, а не зашиты числом', () => {
  const rows = DATES.flatMap((d) => [
    mark(d, 'М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '6:03:10'),
    mark(d, 'М24', 'cook', 'Повар', 'Повар Первый', '6:01:00'),
  ]);
  const text = textOf(
    driverCookReportDefinition({
      report: analyzeDriverCook(rows, DATES[0], DATES[2], {
        simultaneousSeconds: 20,
        closeMinutes: 3,
      }),
      generatedAt: STAMP,
    }).content,
  );

  assert.match(text, /± 20 сек/);
  assert.match(text, /разрыв до 3 мин/);
});

test('имя файла — латиницей и с периодом', () => {
  assert.equal(
    driverCookReportFilename('2026-09-01', '2026-09-16'),
    'sverka-otmetok-2026-09-01_2026-09-16.pdf',
  );
});

test('PDF действительно собирается', async () => {
  const pdf = await renderDriverCookReport({ report: report(), generatedAt: STAMP });

  assert.ok(pdf.length > 1000, `подозрительно маленький PDF: ${pdf.length} байт`);
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
});
