import type { CanvasElement, Column, Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
import {
  formatDelta,
  isSuspicious,
  type DriverCookBucket,
  type DriverCookGroup,
  type DriverCookPair,
  type DriverCookReport,
} from './driver-cook';
import { plural } from './plural';
import { shortDate } from './time';
import {
  INK,
  LINE,
  MUTED,
  configuredPrinter,
  formatStamp,
  fullDate,
  rowsLayout,
  square,
  tile,
} from './pdf-common';

/**
 * PDF-отчёт по сверке отметок водителя и первого повара.
 *
 * Зачем он отдельно от вкладки: вкладку смотрят, отчёт — пересылают. Поэтому
 * здесь есть то, чего на экране нет: короткий вывод словами, динамика по дням
 * и методика в конце. Человек, открывший файл без контекста, должен понять,
 * что перед ним, не спрашивая автора.
 *
 * Отчёт ничего не обвиняет. Он показывает совпадения и их повторяемость —
 * вывод делает тот, кто читает.
 */

/**
 * Цвет по случаю — шкала «насколько отметки близки», а не палитра радара.
 *
 * Зелёный здесь не «лавка молодец», а «обычный день»: повар пришёл раньше
 * водителя с нормальным разрывом. Дальше по нарастающей — синий (водитель
 * приехал первым, рабочая ситуация), жёлтый (отметки почти сошлись), красный
 * (сошлись в один момент). Пары проверены на различимость при дальтонизме,
 * и рядом с каждым цветом всегда стоит подпись и число: цветом одним ничего
 * не закодировано.
 */
const BUCKET_COLOR: Record<DriverCookBucket, string> = {
  cook_before: '#16a34a',
  driver_before: '#2563eb',
  cook_before_close: '#ca8a04',
  simultaneous: '#dc2626',
};

/** Серый контекста: величина, на фоне которой читают красное. */
const CONTEXT = '#94a3b8';

/** Порядок разделов и легенды: от обычного дня к самому подозрительному. */
const BUCKET_ORDER: DriverCookBucket[] = [
  'cook_before',
  'driver_before',
  'cook_before_close',
  'simultaneous',
];

export interface DriverCookReportInput {
  report: DriverCookReport;
  region?: string;
  shop?: string;
  /** Когда сформирован отчёт; параметром — чтобы тест был воспроизводим. */
  generatedAt?: Date;
}

/** Готовый PDF одним буфером. */
export async function renderDriverCookReport(input: DriverCookReportInput): Promise<Buffer> {
  const printer = configuredPrinter();
  return printer.createPdf(driverCookReportDefinition(input)).getBuffer();
}

/** Имя файла: латиницей и с периодом — такие файлы потом лежат в почте. */
export function driverCookReportFilename(from: string, to: string): string {
  return `sverka-otmetok-${from}_${to}.pdf`;
}

/**
 * Описание документа отдельно от рендера: так его видно в тестах, не собирая
 * PDF целиком.
 */
export function driverCookReportDefinition(input: DriverCookReportInput): TDocumentDefinitions {
  const { report } = input;
  const generatedAt = input.generatedAt ?? new Date();
  const suspicious = report.pairs.filter(isSuspicious);
  const shops = report.byShop.filter((g) => g.alone > 0);
  const drivers = report.byDriver.filter((g) => g.alone > 0);

  const scope = [
    `${fullDate(report.from)} — ${fullDate(report.to)}`,
    input.region ? `РМ ${input.region}` : null,
    input.shop ? `поиск «${input.shop}»` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    pageSize: 'A4',
    pageMargins: [32, 32, 32, 36],
    info: {
      title: `Сверка отметок ${report.from} — ${report.to}`,
      author: 'Радар витрин',
    },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: INK },
    content: [
      header(scope, generatedAt),
      kpiRow(report, suspicious.length),
      verdict(report, suspicious, shops, drivers),
      { text: 'Как разошлись отметки', style: 'h2', margin: [0, 16, 0, 2] },
      {
        text:
          `Знаменатель — ${report.summary.pairs} ` +
          `${plural(report.summary.pairs, 'лавко-день', 'лавко-дня', 'лавко-дней')}, ` +
          'где живая отметка face id есть и у водителя, и у повара.',
        fontSize: 7,
        color: MUTED,
        margin: [0, 0, 0, 6],
      },
      bucketBar(report),
      bucketLegend(),
      bucketTable(report),
      byDayChart(report),
      { text: 'Лавки', style: 'h2', margin: [0, 16, 0, 2] },
      {
        text:
          'Только лавки, где совпадение случилось хотя бы раз. Одно совпадение — ' +
          'случайность; семь дней из семи — нет.',
        fontSize: 7,
        color: MUTED,
        margin: [0, 0, 0, 6],
      },
      groupTable(shops, 'Лавка', 'Совпадений по лавкам за период нет.'),
      { text: 'Водители', style: 'h2', pageBreak: 'before', margin: [0, 0, 0, 2] },
      {
        text:
          'Тот же счёт, но по человеку за рулём: водитель за смену объезжает несколько ' +
          'лавок, и повторяемость видно только здесь.',
        fontSize: 7,
        color: MUTED,
        margin: [0, 0, 0, 6],
      },
      groupTable(drivers, 'Водитель', 'Совпадений по водителям за период нет.'),
      { text: 'Совпавшие дни', style: 'h2', margin: [0, 16, 0, 2] },
      {
        text:
          'Отметки сошлись, и до этой пары в лавке не отмечался никто. Разрыв со знаком ' +
          '«+» — водитель отметился раньше повара, «−» — позже.',
        fontSize: 7,
        color: MUTED,
        margin: [0, 0, 0, 6],
      },
      pairsTable(suspicious),
      method(report),
    ],
    styles: {
      h1: { fontSize: 16, bold: true },
      h2: { fontSize: 11, bold: true },
      th: { fontSize: 7, bold: true, color: MUTED },
    },
    footer: (page: number, pages: number): Content => ({
      margin: [32, 8, 32, 0],
      columns: [
        {
          text: 'Радар витрин · сверка отметок водителя и первого повара',
          fontSize: 7,
          color: MUTED,
        },
        { text: `${page} из ${pages}`, fontSize: 7, color: MUTED, alignment: 'right' },
      ],
    }),
  };
}

function header(scope: string, generatedAt: Date): Content {
  return {
    columns: [
      [
        { text: 'Сверка отметок', style: 'h1' },
        {
          text: 'Водитель и первый повар лавки',
          fontSize: 9,
          color: MUTED,
          margin: [0, 1, 0, 0],
        },
        { text: scope, fontSize: 9, margin: [0, 2, 0, 0] },
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

function kpiRow(report: DriverCookReport, suspicious: number): Content {
  const { summary: s } = report;
  return {
    columns: [
      tile('Лавко-дней в сверке', String(s.pairs), `пропущено: ${s.skipped}`),
      tile(
        'Водитель раньше повара',
        String(s.byBucket.driver_before),
        `${share(s.byBucket.driver_before, s.pairs)} · лавку открыл водитель: ${s.aloneByBucket.driver_before}`,
      ),
      tile(
        'Отметились одновременно',
        String(s.byBucket.simultaneous),
        `${share(s.byBucket.simultaneous, s.pairs)} · лавка пустая: ${s.aloneByBucket.simultaneous}`,
        BUCKET_COLOR.simultaneous,
      ),
      tile(
        'Совпало на пустой лавке',
        String(suspicious),
        `${share(suspicious, s.pairs)} от всех дней`,
        BUCKET_COLOR.simultaneous,
      ),
    ],
  };
}

/**
 * Вывод словами — единственное место в отчёте, где что-то утверждается.
 *
 * Собирается из тех же цифр, что и таблицы: пересланный файл читают без
 * автора, и «что тут главное» должно быть написано, а не выведено читателем
 * из шести таблиц.
 */
function verdict(
  report: DriverCookReport,
  suspicious: readonly DriverCookPair[],
  shops: readonly DriverCookGroup[],
  drivers: readonly DriverCookGroup[],
): Content {
  const { summary: s } = report;
  const lines: string[] = [];

  if (s.pairs === 0) {
    lines.push(
      'За период нет ни одного дня, где face id есть и у водителя, и у повара одной лавки. ' +
        'Скорее всего, загружены не обе выгрузки: нужны и «выходы», и «водители».',
    );
  } else if (suspicious.length === 0) {
    lines.push(
      `Совпадений не нашлось: во всех ${s.pairs} лавко-днях отметки водителя и повара ` +
        'расходятся достаточно, либо к моменту их отметок в лавке уже был кто-то ещё.',
    );
  } else {
    lines.push(
      `Отметки сошлись на пустой лавке в ${suspicious.length} ` +
        `${plural(suspicious.length, 'лавко-дне', 'лавко-днях', 'лавко-днях')} — ` +
        `${share(suspicious.length, s.pairs)} всех дней сверки. Из них ` +
        `${s.aloneByBucket.simultaneous} ${plural(s.aloneByBucket.simultaneous, 'день', 'дня', 'дней')} ` +
        `с разрывом меньше ${report.options.simultaneousSeconds} секунд: ` +
        'два человека у одного терминала так не попадают.',
    );

    const topShops = shops.slice(0, 3);
    if (topShops.length > 0) {
      lines.push(
        'Чаще других: ' +
          topShops
            .map((g) => `${g.title} — ${g.alone} из ${g.pairs} ${plural(g.pairs, 'дня', 'дней', 'дней')}`)
            .join('; ') +
          '.',
      );
    }

    const topDrivers = drivers.slice(0, 3);
    if (topDrivers.length > 0) {
      lines.push(
        'По водителям: ' +
          topDrivers.map((g) => `${g.title} — ${g.alone}`).join('; ') +
          '. Повторяемость у одного человека или одной лавки — то, с чего стоит начать разбор.',
      );
    }
  }

  return {
    margin: [0, 12, 0, 0],
    table: {
      widths: ['*'],
      body: [
        [
          {
            border: [false, false, false, false],
            fillColor: '#fef2f2',
            margin: [10, 8, 10, 8],
            stack: [
              { text: 'Коротко', fontSize: 7, bold: true, color: MUTED },
              ...lines.map((text, i) => ({
                text,
                fontSize: 8.5,
                margin: [0, i === 0 ? 3 : 2, 0, 0] as [number, number, number, number],
              })),
            ],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
      paddingLeft: () => 0,
      paddingRight: () => 0,
    },
  };
}

/** Состав дней одной полосой: доли всех четырёх случаев в ширину листа. */
function bucketBar(report: DriverCookReport): Content {
  const width = 531; // A4 минус поля
  const height = 16;
  const total = Math.max(report.summary.pairs, 1);

  const marks: CanvasElement[] = [];
  let x = 0;
  for (const bucket of BUCKET_ORDER) {
    const count = report.summary.byBucket[bucket];
    if (count === 0) continue;
    // Зазор в 2 пункта между сегментами: без него соседние доли слипаются
    // в одну полосу и границу видно только по цвету.
    const w = Math.max((count / total) * width - 2, 1);
    marks.push({ type: 'rect', x, y: 0, w, h: height, r: 2, color: BUCKET_COLOR[bucket] });
    x += w + 2;
  }

  return { canvas: marks, margin: [0, 0, 0, 6] };
}

function bucketLegend(): Content {
  return {
    columns: [
      legendItem(BUCKET_COLOR.cook_before, 'обычный день'),
      legendItem(BUCKET_COLOR.driver_before, 'водитель раньше'),
      legendItem(BUCKET_COLOR.cook_before_close, 'почти сошлись'),
      legendItem(BUCKET_COLOR.simultaneous, 'одновременно'),
    ],
    margin: [0, 0, 0, 8],
  };
}

/** Квадрат цвета и подпись рядом: цветом одним в отчёте ничего не закодировано. */
function legendItem(color: string, label: string): Column {
  return {
    width: 'auto',
    columns: [
      { width: 10, canvas: [square(0, 1.5, 7, color)] },
      { width: 'auto', text: label, fontSize: 7.5, margin: [2, 0, 12, 0] },
    ],
  };
}

function bucketTable(report: DriverCookReport): Content {
  const { summary: s, options: o } = report;
  const title: Record<DriverCookBucket, string> = {
    driver_before: `Водитель раньше повара (> ${o.simultaneousSeconds} сек)`,
    simultaneous: `Одновременно (± ${o.simultaneousSeconds} сек)`,
    cook_before_close: `Повар раньше, разрыв до ${o.closeMinutes} мин`,
    cook_before: 'Повар раньше водителя — обычный день',
  };

  const head: TableCell[] = [
    { text: '', style: 'th' },
    { text: 'Случай', style: 'th' },
    { text: 'Дней', style: 'th', alignment: 'right' },
    { text: 'Доля', style: 'th', alignment: 'right' },
    { text: 'До пары никого', style: 'th', alignment: 'right' },
  ];

  const order: DriverCookBucket[] = [
    'driver_before',
    'simultaneous',
    'cook_before_close',
    'cook_before',
  ];

  const body: TableCell[][] = order.map((bucket) => [
    { canvas: [square(0, 1.5, 7, BUCKET_COLOR[bucket])] },
    { text: title[bucket] },
    { text: String(s.byBucket[bucket]), alignment: 'right', bold: true },
    { text: share(s.byBucket[bucket], s.pairs), alignment: 'right', color: MUTED },
    {
      // У обычного дня колонка неприменима: там разрыв большой, и «никого до
      // пары» ничего не значит.
      text: bucket === 'cook_before' ? '—' : String(s.aloneByBucket[bucket]),
      alignment: 'right',
    },
  ]);

  return {
    table: { headerRows: 1, widths: [10, '*', 40, 40, 74], body: [head, ...body] },
    layout: rowsLayout(),
  };
}

/**
 * Совпадения по дням: контекст серым, совпадения красным поверх.
 *
 * Только красные столбики врали бы формой: «одиннадцать» в день, когда пар
 * было шестьдесят, и «одиннадцать» в день, когда их было пятнадцать, — это
 * разные новости. Обе величины в одних единицах (лавко-дни), поэтому ось одна
 * и шкала общая.
 *
 * Ось идёт по календарю, а не по дням с данными: выходные без выгрузки должны
 * быть видны провалом, а не исчезнуть, сдвинув соседей.
 */
function byDayChart(report: DriverCookReport): Content {
  const days = calendarDays(report.from, report.to);
  if (days.length < 2) return { text: '' };

  const byDate = new Map(report.byDate.map((g) => [g.key, g]));
  const width = 531;
  const height = 56;
  const step = width / days.length;
  // Столбик не шире 10 пунктов: за неделю широкие бары сливаются в заливку,
  // и график перестаёт читаться как график.
  const barWidth = Math.min(Math.max(step - 2, 1.5), 10);
  const offset = (step - barWidth) / 2;
  const max = Math.max(...days.map((d) => byDate.get(d)?.pairs ?? 0), 1);

  const marks: CanvasElement[] = [
    // Базовая линия: без неё столбики висят в воздухе.
    { type: 'line', x1: 0, y1: height, x2: width, y2: height, lineWidth: 0.6, lineColor: LINE },
  ];

  days.forEach((date, i) => {
    const day = byDate.get(date);
    if (!day) return;
    const x = i * step + offset;

    const hAll = Math.max((day.pairs / max) * height, 1);
    marks.push({ type: 'rect', x, y: height - hAll, w: barWidth, h: hAll, r: 1, color: CONTEXT });

    if (day.alone === 0) return;
    const hAlone = Math.max((day.alone / max) * height, 1.2);
    marks.push({
      type: 'rect',
      x,
      y: height - hAlone,
      w: barWidth,
      h: hAlone,
      r: 1,
      color: BUCKET_COLOR.simultaneous,
    });
  });

  const peak = report.byDate.reduce((best, d) => (d.alone > (best?.alone ?? 0) ? d : best), report.byDate[0]);

  return {
    margin: [0, 16, 0, 0],
    stack: [
      { text: 'Совпадения по дням', style: 'h2', margin: [0, 0, 0, 2] },
      {
        columns: [
          {
            width: '*',
            text:
              peak && peak.alone > 0
                ? `Худший день — ${shortDate(peak.key)}: ${peak.alone} из ${peak.pairs} лавок.`
                : 'Совпадений за период не было.',
            fontSize: 7,
            color: MUTED,
          },
          legendItem(CONTEXT, 'пар за день'),
          legendItem(BUCKET_COLOR.simultaneous, 'из них совпало'),
        ],
        margin: [0, 0, 0, 6],
      },
      { canvas: marks },
      { columns: dayAxis(days), margin: [0, 2, 0, 0] },
    ],
  };
}

/** Все дни периода подряд, включая те, за которые выгрузок нет. */
function calendarDays(from: string, to: string): string[] {
  const days: string[] = [];
  // UTC: сдвиг часового пояса в полночь давал бы день туда-сюда.
  for (let d = new Date(`${from}T00:00:00Z`); ; d = new Date(d.getTime() + 86400000)) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > to) break;
    days.push(iso);
    // Страховка от бесконечного цикла на кривом периоде.
    if (days.length > 400) break;
  }
  return days;
}

/** Подписи оси: первый день, последний и сколько середины влезет без каши. */
function dayAxis(days: readonly string[]): Column[] {
  const marks = Math.min(5, days.length);
  const picked = Array.from({ length: marks }, (_, i) =>
    Math.round((i * (days.length - 1)) / Math.max(marks - 1, 1)),
  ).filter((v, i, a) => a.indexOf(v) === i);

  return picked.map((index, i) => ({
    width: '*',
    text: shortDate(days[index]),
    fontSize: 6.5,
    color: MUTED,
    alignment: i === 0 ? 'left' : i === picked.length - 1 ? 'right' : 'center',
  }));
}

/** Лавки и водители: одна разметка на обе таблицы — цифры в них одни и те же. */
function groupTable(
  groups: readonly DriverCookGroup[],
  head: string,
  empty: string,
): Content {
  if (groups.length === 0) return { text: empty, fontSize: 8, color: MUTED };

  const max = Math.max(...groups.map((g) => g.alone), 1);

  const headRow: TableCell[] = [
    { text: '#', style: 'th', alignment: 'right' },
    { text: head, style: 'th' },
    { text: 'Дней', style: 'th', alignment: 'right' },
    { text: 'Одновр.', style: 'th', alignment: 'right' },
    { text: 'Рядом', style: 'th', alignment: 'right' },
    { text: 'Совпало', style: 'th', alignment: 'right' },
    { text: '', style: 'th' },
  ];

  const body: TableCell[][] = groups.map((g, i) => [
    { text: String(i + 1), alignment: 'right', color: MUTED },
    { text: g.title, bold: true },
    { text: String(g.pairs), alignment: 'right', color: MUTED },
    { text: String(g.simultaneous), alignment: 'right', color: MUTED },
    { text: String(g.cookBeforeClose), alignment: 'right', color: MUTED },
    { text: String(g.alone), alignment: 'right', bold: true },
    {
      canvas: [
        {
          type: 'rect',
          x: 0,
          y: 1.5,
          w: Math.max((g.alone / max) * 90, 1),
          h: 5,
          r: 1,
          color: BUCKET_COLOR.simultaneous,
        },
      ],
    },
  ]);

  return {
    table: { headerRows: 1, widths: [12, '*', 30, 38, 32, 40, 92], body: [headRow, ...body] },
    layout: rowsLayout(),
  };
}

function pairsTable(pairs: readonly DriverCookPair[]): Content {
  if (pairs.length === 0) {
    return {
      text: 'За период таких дней нет: отметки водителя и повара нигде не сошлись на пустой лавке.',
      fontSize: 8,
      color: MUTED,
    };
  }

  const head: TableCell[] = [
    { text: 'Дата', style: 'th' },
    { text: 'Лавка', style: 'th' },
    { text: 'Водитель', style: 'th', alignment: 'right' },
    { text: 'Повар', style: 'th', alignment: 'right' },
    { text: 'Разрыв', style: 'th', alignment: 'right' },
    { text: 'Кто за рулём', style: 'th' },
    { text: 'Кто на кухне', style: 'th' },
  ];

  const body: TableCell[][] = pairs.map((p) => [
    { text: shortDate(p.date), color: MUTED },
    { text: p.shopName, bold: true },
    { text: p.driverTime, alignment: 'right' },
    { text: p.cookTime, alignment: 'right' },
    {
      text: formatDelta(p.deltaMinutes),
      alignment: 'right',
      color: BUCKET_COLOR[p.bucket],
      bold: true,
    },
    { text: p.driverName, fontSize: 7 },
    { text: p.cookName, fontSize: 7 },
  ]);

  return {
    table: { headerRows: 1, widths: [30, 86, 38, 38, 42, '*', '*'], body: [head, ...body] },
    layout: rowsLayout(),
  };
}

/** Методика: что считалось и что осталось за рамками. */
function method(report: DriverCookReport): Content {
  const o = report.options;
  const items = [
    'Пара за день — первая отметка водителя и первая отметка повара в одной лавке. ' +
      'Второй и третий повар смены в сверку не входят.',
    'Считаются только живые отметки face id. Время из журнала отгрузок и досчёт ' +
      '«уход − 30 минут» пропущены: они восстановлены, а не отмечены, и разница в ' +
      'минутах у них ничего не значит. Такие дни — в строке «пропущено».',
    `«Одновременно» — разрыв не больше ${o.simultaneousSeconds} секунд, «почти сошлись» — ` +
      `не больше ${o.closeMinutes} минут. Секунды взяты из выгрузки, а не из округлённых минут.`,
    '«До пары никого» — в этот день до водителя и повара в лавке не отмечался никто: ' +
      'считаются все должности, включая уборщика и директора.',
    'Совпадение отметок — повод разобраться, а не приговор. Отчёт не меняет ни статусы ' +
      'лавок, ни итог радара.',
  ];

  return {
    margin: [0, 16, 0, 0],
    stack: [
      { text: 'Как это считалось', style: 'h2', margin: [0, 0, 0, 4] },
      {
        ul: items,
        fontSize: 7.5,
        color: MUTED,
      },
    ],
  };
}

function share(n: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((n / total) * 1000) / 10}%`;
}
