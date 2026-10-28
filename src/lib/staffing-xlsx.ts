import * as XLSX from 'xlsx';
import {
  MONTH_DAYS,
  STAFF_HOURLY_RATE,
  STAFF_ROLES,
  STAFF_ROLE_TITLE,
  pay,
  postsLabel,
  roleTotals,
  slotPersonHours,
  slotShortLabel,
  type StaffNorm,
} from './staffing';
import { formatMoment } from './time';

/**
 * «График пиков» книгой Excel. Четыре листа:
 *
 *   Люди           — как таблица на вкладке: лавка, по каждой должности окна,
 *                    FTE, человеко-часы в день и в месяц;
 *   Рубли          — та же сетка, в клетке заработок за окно, ₽;
 *   Данные         — длинная таблица «лавка × должность × окно» под сводные;
 *   Как считается  — откуда цифры и по каким формулам.
 *
 * Все числа — числа, а не текст: по ним работают сортировка, фильтр и формулы.
 * Шапка и колонки с лавкой закреплены — у таблицы сорок колонок и восемьдесят
 * строк, без этого на середине листа уже не понять, где какое окно.
 *
 * Цветов нет: SheetJS в бесплатной версии стилей не пишет. Красивая версия для
 * чтения и печати — PDF (staffing-pdf.ts).
 */

export interface StaffingXlsxInput {
  /** Лавки в выгрузке: вся сеть или одна выбранная. */
  shown: StaffNorm[];
  source: string;
  builtAt: string;
  /** Когда выгружено; параметром — чтобы тест был воспроизводим. */
  generatedAt?: Date;
}

export const STAFFING_XLSX_SHEETS = ['Люди', 'Рубли', 'Данные', 'Как считается'] as const;

/** Колонки перед окнами: код, название, грейд. Их и закрепляем слева. */
const LEAD = ['Код', 'Лавка', 'Грейд'] as const;

const RUB = '#,##0';

export function staffingXlsx(input: StaffingXlsxInput): Buffer {
  const { shown } = input;
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, gridSheet(shown, 'people'), STAFFING_XLSX_SHEETS[0]);
  XLSX.utils.book_append_sheet(book, gridSheet(shown, 'rub'), STAFFING_XLSX_SHEETS[1]);
  XLSX.utils.book_append_sheet(book, dataSheet(shown), STAFFING_XLSX_SHEETS[2]);
  XLSX.utils.book_append_sheet(book, notesSheet(input), STAFFING_XLSX_SHEETS[3]);

  const raw = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return freezePanes(raw, [
    { cols: LEAD.length, rows: 2 },
    { cols: LEAD.length, rows: 2 },
    { cols: 0, rows: 1 },
    null,
  ]);
}

/* ------------------------- Люди и Рубли: сетка -------------------------- */

type Grid = 'people' | 'rub';

/**
 * Сетка как на вкладке. Шапка в два этажа: над окнами — должность (ячейка
 * объединена на всю группу), под ней — окна и итоги. Фильтр — на втором
 * этаже, он и есть строка заголовков.
 */
function gridSheet(shown: StaffNorm[], kind: Grid): XLSX.WorkSheet {
  const head = shown[0];
  const tail = kind === 'people' ? ['FTE', 'Чел.-ч в день', 'Чел.-ч в месяц'] : ['₽ в день', '₽ в месяц'];

  const top: (string | null)[] = LEAD.map(() => null);
  const sub: string[] = [...LEAD];
  const merges: XLSX.Range[] = [];
  for (const role of STAFF_ROLES) {
    const width = head.roles[role].slots.length + tail.length;
    const title = kind === 'people' ? STAFF_ROLE_TITLE[role] : `${STAFF_ROLE_TITLE[role]}, ₽ (${STAFF_HOURLY_RATE[role]} ₽/ч)`;
    merges.push({ s: { r: 0, c: sub.length }, e: { r: 0, c: sub.length + width - 1 } });
    top.push(title, ...Array<null>(width - 1).fill(null));
    sub.push(...head.roles[role].slots.map(slotShortLabel), ...tail);
  }

  const rows = shown.map((n) => [
    n.code,
    n.name,
    n.grade ?? '',
    ...STAFF_ROLES.flatMap((role) => {
      const r = n.roles[role];
      const t = roleTotals(r, role);
      return kind === 'people'
        ? [...r.slots.map((s) => s.count), t.fte, t.day, t.month]
        : [...r.slots.map((s) => pay(slotPersonHours(s), STAFF_HOURLY_RATE[role])), t.dayPay, t.monthPay];
    }),
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([top, sub, ...rows]);
  const last = sub.length - 1;
  const firstData = 2;
  const lastData = firstData + rows.length - 1;

  if (kind === 'rub') {
    for (let r = firstData; r <= lastData; r++) {
      for (let c = LEAD.length; c <= last; c++) numberFormat(sheet, r, c, RUB);
    }
  }

  // «Итого» — ПРОМЕЖУТОЧНЫЕ.ИТОГИ, а не СУММ: включил фильтр по грейду — и
  // итог считается по видимым лавкам. Значение кладём сразу: без него файл,
  // открытый в просмотрщике без пересчёта, показал бы пустую строку.
  if (rows.length > 1) {
    const r = lastData + 1;
    sheet[XLSX.utils.encode_cell({ r, c: 1 })] = { t: 's', v: 'Итого по сети' };
    for (let c = LEAD.length; c <= last; c++) {
      const col = XLSX.utils.encode_col(c);
      const sum = rows.reduce((s, row) => s + (typeof row[c] === 'number' ? (row[c] as number) : 0), 0);
      sheet[XLSX.utils.encode_cell({ r, c })] = {
        t: 'n',
        v: Math.round(sum * 10) / 10,
        f: `SUBTOTAL(109,${col}${firstData + 1}:${col}${lastData + 1})`,
        ...(kind === 'rub' && { z: RUB }),
      };
    }
    sheet['!ref'] = XLSX.utils.encode_range({ r: 0, c: 0 }, { r, c: last });
  }

  sheet['!merges'] = merges;
  sheet['!cols'] = sub.map((_, c) => ({ wch: c === 0 ? 7 : c === 1 ? 28 : c === 2 ? 11 : kind === 'rub' ? 11 : 10 }));
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 1, c: 0 }, { r: lastData, c: last }) };
  return sheet;
}

/* ------------------------ Данные: под сводные ---------------------------- */

const DATA_HEADER = [
  'Код',
  'Лавка',
  'Грейд',
  'Кофемашина',
  'Должность',
  'Окно',
  'Начало',
  'Конец',
  'Часов в окне',
  'Человек',
  'Чел.-ч',
  'Ставка, ₽/ч',
  'Заработок, ₽',
  'Где стоят',
] as const;

/**
 * Строка — одно окно одной должности в одной лавке, с расстановкой: кто где
 * стоит («1 касса · 2 прием»). Неудобно читать глазами,
 * зато сводная таблица по такой строится в два клика: «заработок по грейдам»,
 * «сколько поваров в сети в 11–16» и что угодно ещё.
 */
function dataSheet(shown: StaffNorm[]): XLSX.WorkSheet {
  const rows: (string | number | null)[][] = [];
  for (const n of shown) {
    for (const role of STAFF_ROLES) {
      const rate = STAFF_HOURLY_RATE[role];
      for (const [i, s] of n.roles[role].slots.entries()) {
        rows.push([
          n.code,
          n.name,
          n.grade ?? '',
          n.coffeeMachine == null ? '' : n.coffeeMachine ? 'да' : 'нет',
          STAFF_ROLE_TITLE[role],
          slotShortLabel(s),
          // Время — доля суток: так его понимает Excel, с форматом «ч:мм».
          s.from == null ? null : s.from / 1440,
          s.to / 1440,
          s.from == null ? null : (s.to - s.from) / 60,
          s.count,
          slotPersonHours(s),
          rate,
          pay(slotPersonHours(s), rate),
          // Дислокации окна, «кондитерка» уже приведена к «кулинарии».
          postsLabel(n.roles[role].posts?.[i] ?? []),
        ]);
      }
    }
  }

  const sheet = XLSX.utils.aoa_to_sheet([[...DATA_HEADER], ...rows]);
  for (let r = 1; r <= rows.length; r++) {
    numberFormat(sheet, r, 6, 'h:mm');
    numberFormat(sheet, r, 7, 'h:mm');
    numberFormat(sheet, r, 11, RUB);
    numberFormat(sheet, r, 12, RUB);
  }
  sheet['!cols'] = [7, 28, 11, 11, 16, 11, 8, 8, 12, 9, 8, 11, 13, 60].map((wch) => ({ wch }));
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: rows.length, c: DATA_HEADER.length - 1 }) };
  return sheet;
}

/* ------------------------- Как считается ------------------------------ */

function notesSheet({ shown, source, builtAt, generatedAt = new Date() }: StaffingXlsxInput): XLSX.WorkSheet {
  const rates = [...new Set(STAFF_ROLES.map((r) => STAFF_HOURLY_RATE[r]))];
  const scope =
    shown.length === 1 ? `${shown[0].code} ${shown[0].name}` : `вся сеть — ${shown.length} лавок`;

  const aoa: string[][] = [
    ['График пиков', ''],
    ['Что в файле', scope],
    ['Источник', `${source}, собран ${builtAt.split('-').reverse().join('.')}`],
    ['Выгружено', `${formatMoment(generatedAt.toISOString())} мск`],
    ['', ''],
    ['Человек в окне', 'Норма из шаблона: сколько человек должности должно быть на смене в это окно.'],
    ['Окно', 'Начало включительно, конец — нет: в 11:00 действует уже окно «11–16».'],
    ['FTE', 'Штатных единиц на должность — из шаблона как есть.'],
    ['Чел.-ч в день', 'Сумма по окнам: человек в окне × длина окна в часах.'],
    ['Чел.-ч в месяц', `Чел.-ч в день × ${MONTH_DAYS}, как в шаблоне.`],
    [
      'Ставка',
      rates.length === 1
        ? `${rates[0]} ₽ в час у всех должностей.`
        : STAFF_ROLES.map((r) => `${STAFF_ROLE_TITLE[r]} — ${STAFF_HOURLY_RATE[r]} ₽/ч`).join(', ') + '.',
    ],
    ['Заработок, ₽', 'Человеко-часы × ставка. За окно, за день и за месяц; окна в сумме дают ровно день.'],
    ['Итого по сети', 'Функция ПРОМЕЖУТОЧНЫЕ.ИТОГИ: при включённом фильтре — только по видимым лавкам.'],
    ['Замы', 'Всегда по одному в каждой лавке: ЗД по бару 6:30–18:00, ЗД по залу 6:30–23:00.'],
    ['Сборщик заказов', 'Там, где он есть в «ШР по лавкам», 7:00–16:00.'],
    ['Где стоят', 'Дислокации из строк под лавкой в шаблоне. Кондитерка и кулинария — одно место.'],
    [
      '«ЧЕЛ-КО часы»',
      'Колонка шаблона не используется: она посчитана от строки М1, а не от длины окон, и с днём не сходится.',
    ],
  ];

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!cols'] = [{ wch: 18 }, { wch: 100 }];
  return sheet;
}

/* ------------------------------- мелочи --------------------------------- */

function numberFormat(sheet: XLSX.WorkSheet, r: number, c: number, z: string): void {
  const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  if (cell?.t === 'n') cell.z = z;
}

interface Pane {
  /** Сколько колонок слева закрепить. */
  cols: number;
  /** Сколько строк сверху закрепить. */
  rows: number;
}

/**
 * Закрепить шапку и колонки с лавкой.
 *
 * SheetJS в бесплатной версии закрепление не пишет: лист у него всегда
 * с пустым <sheetView/>. Поэтому дописываем стандартный <pane state="frozen">
 * прямо в XML готовой книги — её zip SheetJS умеет и читать, и собирать.
 * Не нашёлся <sheetView/> — оставляем лист как есть: без закрепления, но
 * целым.
 */
function freezePanes(book: Buffer, panes: (Pane | null)[]): Buffer {
  const zip = XLSX.CFB.read(book, { type: 'buffer' });
  panes.forEach((pane, i) => {
    if (!pane) return;
    const entry = XLSX.CFB.find(zip, `/xl/worksheets/sheet${i + 1}.xml`);
    if (!entry?.content) return;
    const xml = Buffer.from(entry.content).toString('utf8');
    const topLeft = XLSX.utils.encode_cell({ r: pane.rows, c: pane.cols });
    const active = pane.cols > 0 ? 'bottomRight' : 'bottomLeft';
    const attrs = [
      pane.cols > 0 ? `xSplit="${pane.cols}"` : null,
      pane.rows > 0 ? `ySplit="${pane.rows}"` : null,
      `topLeftCell="${topLeft}"`,
      `activePane="${active}"`,
      'state="frozen"',
    ]
      .filter(Boolean)
      .join(' ');
    entry.content = Buffer.from(
      xml.replace(/<sheetView ([^>]*?)\/>/, `<sheetView $1><pane ${attrs}/><selection pane="${active}"/></sheetView>`),
      'utf8',
    );
  });
  return XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip', compression: true }) as Buffer;
}
