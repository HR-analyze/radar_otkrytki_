import pdfMake from 'pdfmake';
import robotoContainer from 'pdfmake/build/fonts/Roboto';
import type {
  CanvasRect,
  Column,
  Content,
  TDocumentDefinitions,
  TableCell,
} from 'pdfmake/interfaces';
import { averagePoints, formatPoints, type ContestScore } from './contest';
import type { ContestRegionRow, ContestRow } from './queries';
import { shortDate } from './time';
import type { Status } from './types';

/**
 * PDF-отчёт по конкурсу витрин.
 *
 * Считается на сервере: браузерная генерация тянула бы полтора мегабайта
 * шрифтов в бандл ради кнопки, которую нажимают раз в месяц. Отдаётся
 * роутом /api/contest/report — на странице это обычная ссылка, без JS.
 *
 * Эмодзи в PDF нет: Roboto их не содержит, и вместо 🟢 печатался бы пустой
 * прямоугольник. Поэтому цвет дня — нарисованный квадрат, а зоны в легенде и
 * заголовках подписаны словами.
 */

/** Цвета зон — те же, что на экране (globals.css). */
const COLOR: Record<'green' | 'yellow' | 'red', string> = {
  green: '#16a34a',
  yellow: '#eab308',
  red: '#dc2626',
};

const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const SOFT = '#f8fafc';

/**
 * Сколько пунктов остаётся под полосу дней в таблице лавок: ширина листа A4
 * в альбомной ориентации минус поля, фиксированные колонки, отступы ячеек и
 * минимум под фамилию РМ.
 */
export const DAYS_MAX_WIDTH = 842 - 28 * 2 - (14 + 120 + 52 + 38 + 34) - 7 * 8 - 90;

export interface ContestReportInput {
  from: string;
  to: string;
  region?: string;
  shop?: string;
  dates: string[];
  rows: ContestRow[];
  regions: ContestRegionRow[];
  total: ContestScore;
  /** Когда сформирован отчёт; параметром — чтобы тест был воспроизводим. */
  generatedAt?: Date;
}

/** Готовый PDF одним буфером. */
export async function renderContestReport(input: ContestReportInput): Promise<Buffer> {
  const printer = configuredPrinter();
  return printer.createPdf(contestReportDefinition(input)).getBuffer();
}

/** Имя файла: латиницей и с периодом — такие файлы потом лежат в почте. */
export function contestReportFilename(from: string, to: string): string {
  return `konkurs-vitriny-${from}_${to}.pdf`;
}

/**
 * Описание документа отдельно от рендера: так его видно в тестах, не собирая
 * PDF целиком.
 */
export function contestReportDefinition(input: ContestReportInput): TDocumentDefinitions {
  const { from, to, dates, rows, regions, total } = input;
  const generatedAt = input.generatedAt ?? new Date();
  const mean = averagePoints(total);

  const scope = [
    `${fullDate(from)} — ${fullDate(to)}`,
    input.region ? `РМ ${input.region}` : null,
    input.shop ? `поиск «${input.shop}»` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 30, 28, 34],
    info: {
      title: `Конкурс по витринам ${from} — ${to}`,
      author: 'Радар витрин',
    },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: INK },
    content: [
      header(scope, generatedAt),
      kpiRow(total, mean, rows.length, dates.length),
      legend(),
      { text: 'Рейтинг лавок', style: 'h2', margin: [0, 14, 0, 6] },
      shopsTable(rows, dates),
      // Разрез по РМ — с новой страницы: разорванный пополам, он читается как
      // хвост рейтинга лавок, а не как отдельный раздел.
      { text: 'Статистика по РМ', style: 'h2', pageBreak: 'before', margin: [0, 0, 0, 2] },
      {
        text:
          'День лавки идёт тому РМ, который вёл её в этот день. Сортировка — по среднему баллу: ' +
          'сумма у менеджера с двенадцатью лавками больше просто потому, что лавок больше.',
        fontSize: 7,
        color: MUTED,
        margin: [0, 0, 0, 6],
      },
      regionsTable(regions),
    ],
    styles: {
      h1: { fontSize: 16, bold: true },
      h2: { fontSize: 11, bold: true },
      th: { fontSize: 7, bold: true, color: MUTED },
    },
    footer: (page: number, pages: number): Content => ({
      margin: [28, 8, 28, 0],
      columns: [
        { text: 'Радар витрин · конкурс по наполнению витрин', fontSize: 7, color: MUTED },
        {
          text: `${page} из ${pages}`,
          fontSize: 7,
          color: MUTED,
          alignment: 'right',
        },
      ],
    }),
  };
}

function header(scope: string, generatedAt: Date): Content {
  return {
    columns: [
      [
        { text: 'Конкурс по витринам', style: 'h1' },
        { text: scope, fontSize: 9, color: MUTED, margin: [0, 2, 0, 0] },
      ],
      {
        width: 'auto',
        text: `Сформирован ${formatStamp(generatedAt)} мск`,
        fontSize: 7,
        color: MUTED,
        alignment: 'right',
        margin: [0, 4, 0, 0],
      },
    ],
    margin: [0, 0, 0, 12],
  };
}

/** Плитки как на вкладке: сумма, средний балл, лавки, дни. */
function kpiRow(
  total: ContestScore,
  mean: number | null,
  shops: number,
  days: number,
): Content {
  const tiles: [string, string, string][] = [
    ['Баллов у сети', formatPoints(total.points), `за ${total.rated} оценённых дней`],
    ['Средний балл за день', mean == null ? '—' : formatPoints(mean), 'сумма ÷ оценённые дни'],
    ['Лавок в конкурсе', String(shops), `дней с витриной: ${days}`],
  ];

  return {
    columns: tiles.map(([title, value, hint]) => ({
      width: '*',
      margin: [0, 0, 8, 0],
      table: {
        widths: ['*'],
        body: [
          [
            {
              border: [true, true, true, true],
              fillColor: SOFT,
              margin: [8, 6, 8, 6],
              stack: [
                { text: title, fontSize: 7, color: MUTED },
                { text: value, fontSize: 15, bold: true, margin: [0, 2, 0, 1] },
                { text: hint, fontSize: 6.5, color: MUTED },
              ],
            },
          ],
        ],
      },
      layout: borderless(),
    })),
  };
}

function legend(): Content {
  const item = (zone: 'green' | 'yellow' | 'red', label: string): Column => ({
    width: 'auto',
    columns: [
      { width: 10, canvas: [square(0, 2, 7, COLOR[zone])] },
      { width: 'auto', text: label, fontSize: 8, margin: [2, 0, 12, 0] },
    ],
  });

  return {
    margin: [0, 12, 0, 0],
    columns: [
      { width: 'auto', text: 'Балл за день:', fontSize: 8, color: MUTED, margin: [0, 0, 8, 0] },
      item('green', 'зелёная  +1'),
      item('yellow', 'жёлтая  0'),
      item('red', 'красная  −1'),
      {
        width: '*',
        text: 'Дни без заполненной витрины балла не имеют и в знаменатель не входят.',
        fontSize: 7,
        color: MUTED,
        alignment: 'right',
      },
    ],
  };
}

/** Рейтинг лавок: место, лавка, РМ, полоса дней, счёт по зонам, витрина, баллы. */
function shopsTable(rows: ContestRow[], dates: string[]): Content {
  // Шаг полосы дней подбирается под период: за две недели квадраты крупные,
  // за месяц — мельче, но в отведённую ширину влезают всегда.
  const step = Math.min(9, DAYS_MAX_WIDTH / Math.max(dates.length, 1));
  const daysWidth = step * Math.max(dates.length, 1);
  const size = Math.max(3, step - 1.6);

  // Заголовки счётчиков — словами: эмодзи Roboto не рисует.
  const head: TableCell[] = [
    { text: '#', style: 'th', alignment: 'right' },
    { text: 'Лавка', style: 'th' },
    { text: 'РМ', style: 'th' },
    { text: dayHeader(dates, step), style: 'th' },
    { text: 'кр / жл / зл', style: 'th', alignment: 'right' },
    { text: 'Витрина', style: 'th', alignment: 'right' },
    { text: 'Баллы', style: 'th', alignment: 'right' },
  ];

  const body: TableCell[][] = rows.map((r, i) => [
    { text: String(i + 1), alignment: 'right', color: MUTED },
    { text: r.shop.name, bold: true },
    { text: r.shop.region ?? '—', color: MUTED },
    { canvas: dayStripe(r, dates, step, size), margin: [0, 1.5, 0, 0] },
    {
      text: `${r.score.red} / ${r.score.yellow} / ${r.score.green}`,
      alignment: 'right',
      color: MUTED,
    },
    {
      text: r.avgFill == null ? '—' : `${Math.round(r.avgFill * 100)}%`,
      alignment: 'right',
      color: MUTED,
    },
    {
      text: formatPoints(r.score.points),
      alignment: 'right',
      bold: true,
      color: pointsColor(r.score.points),
    },
  ]);

  return {
    table: {
      headerRows: 1,
      // РМ — звёздочкой: лишнюю ширину лучше отдать длинным фамилиям, чем
      // оставить пустое поле у правого края.
      widths: [14, 120, '*', daysWidth, 52, 38, 34],
      body: [head, ...body],
    },
    layout: rowsLayout(),
  };
}

/** Подписи дней над полосой — только если они не сольются в кашу. */
function dayHeader(dates: string[], step: number): string {
  return step >= 12
    ? dates.map((d) => shortDate(d)).join(' ')
    : `Дни: ${shortDate(dates[0])} — ${shortDate(dates[dates.length - 1])}`;
}

/** Полоса дней лавки: квадрат на день, пропуск — пустое место. */
function dayStripe(
  row: ContestRow,
  dates: string[],
  step: number,
  size: number,
): CanvasRect[] {
  const marks: CanvasRect[] = [];
  dates.forEach((date, i) => {
    const cell = row.cells[date];
    const zone = zoneOf(cell?.status);
    if (!zone) return;
    marks.push(square(i * step, 0, size, COLOR[zone]));
  });
  return marks;
}

function regionsTable(regions: ContestRegionRow[]): Content {
  if (regions.length === 0) {
    return { text: 'За период РМ не определились — справочник пуст.', fontSize: 8, color: MUTED };
  }

  const head: TableCell[] = [
    { text: 'РМ', style: 'th' },
    { text: 'Лавок', style: 'th', alignment: 'right' },
    { text: 'кр / жл / зл', style: 'th', alignment: 'right' },
    { text: 'Дней с оценкой', style: 'th', alignment: 'right' },
    { text: 'Витрина', style: 'th', alignment: 'right' },
    { text: 'Ср. балл', style: 'th', alignment: 'right' },
    { text: 'Баллы', style: 'th', alignment: 'right' },
  ];

  const body: TableCell[][] = regions.map((r) => {
    const mean = averagePoints(r.score);
    return [
      { text: r.region, bold: true },
      { text: String(r.shops), alignment: 'right', color: MUTED },
      {
        text: `${r.score.red} / ${r.score.yellow} / ${r.score.green}`,
        alignment: 'right',
        color: MUTED,
      },
      { text: String(r.score.rated), alignment: 'right', color: MUTED },
      {
        text: r.avgFill == null ? '—' : `${Math.round(r.avgFill * 100)}%`,
        alignment: 'right',
        color: MUTED,
      },
      { text: mean == null ? '—' : formatPoints(mean), alignment: 'right' },
      {
        text: formatPoints(r.score.points),
        alignment: 'right',
        bold: true,
        color: pointsColor(r.score.points),
      },
    ];
  });

  return {
    table: {
      headerRows: 1,
      // Имя РМ — звёздочкой: считать остаток вручную нельзя, к ширинам
      // прибавляются отступы ячеек, и последняя колонка уезжала за край листа.
      widths: ['*', 40, 70, 74, 50, 50, 44],
      body: [head, ...body],
    },
    layout: rowsLayout(),
  };
}

/* ------------------------------ мелочи ----------------------------------- */

function square(x: number, y: number, size: number, color: string): CanvasRect {
  return { type: 'rect', x, y, w: size, h: size, r: 1, color };
}

function zoneOf(status: Status | undefined): 'green' | 'yellow' | 'red' | null {
  if (status === 'green' || status === 'yellow' || status === 'red') return status;
  return null;
}

function pointsColor(points: number): string {
  if (points > 0) return COLOR.green;
  if (points < 0) return COLOR.red;
  return INK;
}

/** Только горизонтальные линейки: вертикальные превращают таблицу в решётку. */
function rowsLayout() {
  return {
    hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
      i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.4,
    vLineWidth: () => 0,
    hLineColor: (i: number) => (i === 1 ? MUTED : LINE),
    paddingTop: () => 3,
    paddingBottom: () => 3,
    paddingLeft: () => 4,
    paddingRight: () => 4,
  };
}

function borderless() {
  return {
    hLineWidth: () => 0.6,
    vLineWidth: () => 0.6,
    hLineColor: () => LINE,
    vLineColor: () => LINE,
    paddingTop: () => 0,
    paddingBottom: () => 0,
    paddingLeft: () => 0,
    paddingRight: () => 0,
  };
}

/** «2026-08-19» → «19.08.2026»: в отчёте, который хранят, год нужен. */
function fullDate(iso: string): string {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Время формирования — всегда московское: сервер на хостинге живёт в UTC, и
 * отчёт, собранный в 14:05 по Москве, был бы подписан «11:05».
 */
function formatStamp(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/* --------------------------- шрифты и печать ----------------------------- */

/**
 * Roboto из пакета pdfmake: у него есть кириллица, а грузить шрифт из сети
 * серверу незачем. Регистрируется один раз на процесс.
 */
let ready = false;

function configuredPrinter(): typeof pdfMake {
  if (ready) return pdfMake;

  const container = robotoContainer as unknown as {
    vfs: Record<string, { data: string; encoding: string }>;
    fonts: Record<string, Record<string, string>>;
  };

  for (const [name, file] of Object.entries(container.vfs)) {
    pdfMake.virtualfs.writeFileSync(name, file.data, file.encoding);
  }
  pdfMake.setFonts(container.fonts);

  // Никаких внешних и локальных файлов: в отчёте только текст и фигуры,
  // а качать что-то по ссылке из документа сервер не должен вовсе.
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy(() => false);

  ready = true;
  return pdfMake;
}
