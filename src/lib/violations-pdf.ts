import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
import {
  formatLate,
  kindsOf,
  type DeparturesReport,
  type ShopDay,
  type ViolationsGroup,
  type ViolationsReport,
} from './violations';
import { plural } from './plural';
import { shortDate } from './time';
import {
  COLOR,
  INK,
  MUTED,
  configuredPrinter,
  formatStamp,
  fullDate,
  rowsLayout,
  tile,
} from './pdf-common';

/**
 * PDF-отчёт по нарушениям открытия: те же четыре раздела, что на вкладке.
 *
 * Вкладку смотрят, отчёт пересылают — поэтому здесь есть то, чего нет на
 * экране: вывод словами в начале, методика в конце и полные списки вместо
 * первых сорока строк. Человек, открывший файл без контекста, должен понять
 * его без автора.
 *
 * Отчёт ничего не обвиняет: он показывает, что разошлось с нормативом, и
 * насколько. Разбирается в причинах человек.
 */

export interface ViolationsReportInput {
  report: ViolationsReport;
  departures: DeparturesReport;
  region?: string;
  shop?: string;
  /** Когда сформирован отчёт; параметром — чтобы тест был воспроизводим. */
  generatedAt?: Date;
}

export async function renderViolationsReport(input: ViolationsReportInput): Promise<Buffer> {
  const printer = configuredPrinter();
  return printer.createPdf(violationsReportDefinition(input)).getBuffer();
}

/** Имя файла: латиницей и с периодом — такие файлы потом лежат в почте. */
export function violationsReportFilename(from: string, to: string): string {
  return `narusheniya-otkrytiya-${from}_${to}.pdf`;
}

export function violationsReportDefinition(input: ViolationsReportInput): TDocumentDefinitions {
  const { report, departures } = input;
  const generatedAt = input.generatedAt ?? new Date();
  const s = report.summary;

  const noStaff = report.days.filter((d) => kindsOf(d).includes('driver_on_time_no_staff'));
  const noStaffLate = report.days.filter((d) => kindsOf(d).includes('no_staff_driver_late'));
  const driverLate = [...report.days.filter((d) => kindsOf(d).includes('driver_late'))].sort(
    (a, b) => (b.driverLateBy ?? 0) - (a.driverLateBy ?? 0),
  );
  const lateCooks = report.days
    .filter((d) => !d.skipped)
    .flatMap((d) => d.lateCooks.map((cook) => ({ day: d, cook })))
    .sort((a, b) => b.cook.lateBy - a.cook.lateBy);

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
      title: `Нарушения открытия ${report.from} — ${report.to}`,
      author: 'Радар витрин',
    },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: INK },
    content: [
      header(scope, generatedAt),
      kpiRow(report, departures),

      section('1. Выезд с РЦ позже установленного времени', [
        'Норматив выезда свой у каждой лавки («Выезд с РЦ» в справочнике) и берётся по первой ' +
          'лавке маршрута водителя за этот день. Где связать не вышло, применяется сетевое ' +
          `правило — до ${departures.greenUntil}. Строка — один выезд водителя с РЦ.`,
      ]),
      departuresTable(departures),

      section('2. Водитель приехал вовремя, а встретить его было некому', [
        'Водитель уложился в норму своей лавки, а первый сотрудник отметился уже после него: ' +
          'в колонке «Разрыв» видно, на сколько позже. Уборщик встречающим не считается — он ' +
          'приходит к своей уборке и товар не принимает.',
        `Пометка «вместе» — отметки разошлись меньше чем на ${report.options.staffGapSeconds} секунд: ` +
          'два человека у одного терминала так не попадают.',
      ]),
      dayTable(noStaff, 'За период таких дней нет.'),
      ...(noStaffLate.length > 0
        ? [
            {
              text: `Отдельно: сотрудника не было, и водитель при этом опоздал — ${noStaffLate.length}`,
              fontSize: 8,
              bold: true,
              margin: [0, 10, 0, 2] as [number, number, number, number],
            },
            {
              text: 'Вынесено из счёта пункта 2, чтобы один день не попал в две категории сразу.',
              fontSize: 7,
              color: MUTED,
              margin: [0, 0, 0, 4] as [number, number, number, number],
            },
            dayTable(noStaffLate, ''),
          ]
        : []),

      section('3. Сотрудник есть — водитель опоздал', [
        'Сотрудник отметился сам, отдельно от водителя, а водитель приехал позже нормы своей ' +
          'лавки. Сортировка — по величине опоздания.',
      ]),
      dayTable(driverLate, 'За период таких дней нет.'),

      section('4. Повар нарушил тайминг прихода', [
        'Каждый повар сравнивается со своей нормой: «1 с 6:00, 2 с 6:30» значит, что к 6:00 ' +
          'лавку открывает первый, а к 6:30 она укомплектована. Строка — один человек за один день.',
      ]),
      cooksTable(lateCooks),

      { text: 'Повторяемость', style: 'h2', pageBreak: 'before', margin: [0, 0, 0, 2] },
      {
        text:
          'Сумма нарушений по пунктам 2–4. У лавки счётчик — её дни, у водителя — лавко-дни: ' +
          'за смену он объезжает несколько лавок.',
        fontSize: 7,
        color: MUTED,
        margin: [0, 0, 0, 6],
      },
      groupTable(report.byShop.filter((g) => g.total > 0), 'Лавка', 'Дней'),
      { text: '', margin: [0, 8, 0, 0] },
      groupTable(report.byDriver.filter((g) => g.total > 0), 'Водитель', 'Лавко-дней'),

      method(report, s.noDriverMark),
    ],
    styles: {
      h1: { fontSize: 16, bold: true },
      h2: { fontSize: 11, bold: true },
      th: { fontSize: 7, bold: true, color: MUTED },
    },
    footer: (page: number, pages: number): Content => ({
      margin: [32, 8, 32, 0],
      columns: [
        { text: 'Радар витрин · нарушения открытия', fontSize: 7, color: MUTED },
        { text: `${page} из ${pages}`, fontSize: 7, color: MUTED, alignment: 'right' },
      ],
    }),
  };
}

function header(scope: string, generatedAt: Date): Content {
  return {
    columns: [
      [
        { text: 'Нарушения открытия', style: 'h1' },
        {
          text: 'Выезд с РЦ, приезд водителя и приход поваров — против норматива',
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

function kpiRow(report: ViolationsReport, departures: DeparturesReport): Content {
  const s = report.summary;
  return {
    columns: [
      tile(
        '1. Выезд с РЦ позже нормы',
        departures.hasData ? String(departures.yellow + departures.red) : '—',
        departures.hasData
          ? `из ${departures.checked} · красных: ${departures.red} · по норме лавки: ${departures.byShopNorm}`
          : 'выгрузки по РЦ нет',
        departures.red > 0 ? COLOR.red : undefined,
      ),
      tile(
        '2. Сотрудника не было',
        String(s.byKind.driver_on_time_no_staff),
        `ещё ${s.byKind.no_staff_driver_late} — и водитель опоздал`,
        s.byKind.driver_on_time_no_staff > 0 ? COLOR.red : undefined,
      ),
      tile(
        '3. Водитель опоздал',
        String(s.byKind.driver_late),
        `из ${s.checked} · красная зона: ${s.driverLateRed}`,
        s.byKind.driver_late > 0 ? COLOR.red : undefined,
      ),
      tile(
        '4. Повар опоздал',
        String(s.lateCooks),
        `в ${s.byKind.cook_late} ${plural(s.byKind.cook_late, 'лавко-дне', 'лавко-днях', 'лавко-днях')} · красных ${s.lateCooksRed}`,
        s.lateCooks > 0 ? COLOR.red : undefined,
      ),
    ],
  };
}

function section(title: string, notes: readonly string[]): Content {
  return {
    stack: [
      { text: title, style: 'h2', margin: [0, 0, 0, 2] },
      ...notes.map((text) => ({
        text,
        fontSize: 7,
        color: MUTED,
        margin: [0, 0, 0, 6] as [number, number, number, number],
      })),
    ],
    margin: [0, 16, 0, 0],
  };
}

function departuresTable(departures: DeparturesReport): Content {
  if (!departures.hasData) {
    return {
      text:
        'За период нет выгрузки по РЦ. Радар читает её отдельным файлом («РЦ Свобода»), и без ' +
        'него выезды не считаются — ни вовремя, ни с опозданием.',
      fontSize: 8,
      color: MUTED,
    };
  }
  if (departures.late.length === 0) {
    return {
      text: `Все ${departures.checked} ${plural(departures.checked, 'выезд', 'выезда', 'выездов')} за период — в норме.`,
      fontSize: 8,
      color: MUTED,
    };
  }

  const head: TableCell[] = [
    { text: 'Дата', style: 'th' },
    { text: 'Водитель', style: 'th' },
    { text: 'Первая лавка', style: 'th' },
    { text: 'Норма', style: 'th', alignment: 'right' },
    { text: 'Выехал', style: 'th', alignment: 'right' },
    { text: 'Позже нормы', style: 'th', alignment: 'right' },
    { text: 'Зона', style: 'th', alignment: 'right' },
  ];

  const body: TableCell[][] = departures.late.map((l) => [
    { text: shortDate(l.date), color: MUTED },
    { text: l.employeeName, fontSize: 7 },
    // Сетевой норматив подписан прямо в строке: иначе непонятно, почему у
    // одного водителя норма 03:50, а у другого 04:59.
    { text: l.shop ?? 'не определена', fontSize: 7, color: l.shop ? INK : MUTED },
    {
      text: l.normSource === 'shop' ? l.norm : `${l.norm} (сеть)`,
      alignment: 'right',
      color: MUTED,
    },
    { text: l.time, alignment: 'right' },
    {
      text: formatLate(l.lateBy),
      alignment: 'right',
      bold: true,
      color: l.status === 'red' ? COLOR.red : COLOR.yellow,
    },
    { text: l.status === 'red' ? 'красная' : 'жёлтая', alignment: 'right', color: MUTED },
  ]);

  return {
    table: { headerRows: 1, widths: [34, '*', 96, 48, 40, 54, 42], body: [head, ...body] },
    layout: rowsLayout(),
  };
}

function dayTable(days: readonly ShopDay[], empty: string): Content {
  if (days.length === 0) return { text: empty, fontSize: 8, color: MUTED };

  const head: TableCell[] = [
    { text: 'Дата', style: 'th' },
    { text: 'Лавка', style: 'th' },
    { text: 'Норма', style: 'th', alignment: 'right' },
    { text: 'Водитель', style: 'th', alignment: 'right' },
    { text: 'Опоздание', style: 'th', alignment: 'right' },
    { text: 'Первый сотрудник', style: 'th' },
    { text: 'Разрыв', style: 'th', alignment: 'right' },
  ];

  const body: TableCell[][] = days.map((d) => [
    { text: shortDate(d.date), color: MUTED },
    { text: d.shopName, bold: true },
    { text: d.driverNorm ?? '—', alignment: 'right', color: MUTED },
    { text: d.driver?.time ?? '—', alignment: 'right' },
    d.driverLateBy != null && d.driverLateBy > 0
      ? { text: formatLate(d.driverLateBy), alignment: 'right', bold: true, color: COLOR.red }
      : { text: 'в норме', alignment: 'right', color: MUTED },
    { text: d.staff ? `${d.staff.role}: ${d.staff.time}` : '—', fontSize: 7 },
    {
      text: formatGap(d),
      alignment: 'right',
      color: d.staffMarkedTogether ? COLOR.red : MUTED,
    },
  ]);

  return {
    table: { headerRows: 1, widths: [34, 96, 34, 44, 50, '*', 38], body: [head, ...body] },
    layout: rowsLayout(),
  };
}

/**
 * Разрыв человеку: «+17 мин» — сотрудник отметился настолько позже водителя,
 * «вместе» — отметки легли друг на друга, «−9 мин» — смена уже была на месте.
 */
function formatGap(day: ShopDay): string {
  if (day.staffGapSeconds == null) return '—';
  if (day.staffMarkedTogether) return `вместе · ${Math.abs(day.staffGapSeconds)} сек`;
  const minutes = Math.round(day.staffGapSeconds / 60);
  return formatLate(minutes);
}

function cooksTable(
  rows: readonly { day: ShopDay; cook: ShopDay['lateCooks'][number] }[],
): Content {
  if (rows.length === 0) {
    return { text: 'За период опозданий поваров нет.', fontSize: 8, color: MUTED };
  }

  const head: TableCell[] = [
    { text: 'Дата', style: 'th' },
    { text: 'Лавка', style: 'th' },
    { text: 'Повар', style: 'th' },
    { text: 'Норма', style: 'th', alignment: 'right' },
    { text: 'Пришёл', style: 'th', alignment: 'right' },
    { text: 'Опоздание', style: 'th', alignment: 'right' },
  ];

  const body: TableCell[][] = rows.map(({ day, cook }) => [
    { text: shortDate(day.date), color: MUTED },
    { text: day.shopName, bold: true },
    { text: cook.name, fontSize: 7 },
    { text: cook.norm, alignment: 'right', color: MUTED },
    { text: cook.time, alignment: 'right' },
    {
      text: formatLate(cook.lateBy),
      alignment: 'right',
      bold: true,
      color: cook.status === 'red' ? COLOR.red : COLOR.yellow,
    },
  ]);

  return {
    table: { headerRows: 1, widths: [34, 96, '*', 34, 44, 50], body: [head, ...body] },
    layout: rowsLayout(),
  };
}

function groupTable(
  groups: readonly ViolationsGroup[],
  head: string,
  /** У лавки счётчик — её дни, у водителя — лавко-дни. */
  unit: string,
): Content {
  if (groups.length === 0) {
    return { text: `Нарушений в разрезе «${head}» за период нет.`, fontSize: 8, color: MUTED };
  }

  const headRow: TableCell[] = [
    { text: '#', style: 'th', alignment: 'right' },
    { text: head, style: 'th' },
    { text: unit, style: 'th', alignment: 'right' },
    { text: '№2', style: 'th', alignment: 'right' },
    { text: '№3', style: 'th', alignment: 'right' },
    { text: '№4', style: 'th', alignment: 'right' },
    { text: 'Всего', style: 'th', alignment: 'right' },
  ];

  const body: TableCell[][] = groups.map((g, i) => [
    { text: String(i + 1), alignment: 'right', color: MUTED },
    { text: g.title, bold: true },
    { text: String(g.days), alignment: 'right', color: MUTED },
    {
      text: String(g.byKind.driver_on_time_no_staff + g.byKind.no_staff_driver_late),
      alignment: 'right',
      color: MUTED,
    },
    { text: String(g.byKind.driver_late), alignment: 'right', color: MUTED },
    { text: String(g.byKind.cook_late), alignment: 'right', color: MUTED },
    { text: String(g.total), alignment: 'right', bold: true },
  ]);

  return {
    table: { headerRows: 1, widths: [14, '*', 50, 30, 30, 30, 40], body: [headRow, ...body] },
    layout: rowsLayout(),
  };
}

function method(report: ViolationsReport, noDriverMark: number): Content {
  const items = [
    'Единица счёта в пунктах 2–4 — лавко-день: одна лавка за один день. В пункте 1 — выезд ' +
      'водителя с РЦ, а в пункте 4 — человек: два опоздавших повара в одной лавке дают две строки.',
    'Норматив выезда с РЦ свой у каждой лавки и берётся по первой лавке маршрута водителя за ' +
      'этот день: в выгрузке по РЦ лавки нет, и связать её больше не по чему. Где водитель в ' +
      'лавках не отмечался, применяется сетевое правило, и в таблице это подписано «(сеть)».',
    'Нормы берутся из справочника лавок и видны на вкладке «Пороги»: у каждой лавки свой час ' +
      'приезда водителя и свои смены поваров. Лавка без нормы считается по сетевому порогу.',
    'Считаются только живые отметки face id. Время из журнала отгрузок и досчёт «уход − 30 ' +
      'минут» пропущены: они восстановлены, а не отмечены.',
    'Встретить водителя было некому — первая отметка сотрудника лавки (повара, кассира, ' +
      'директора) позже отметки водителя. Уборщик встречающим не считается: он приходит к ' +
      'своей уборке и товар не принимает. Список исключённых должностей — в конфиге ' +
      '(rules.violations.openingRolesExclude).',
    'Дни «другого графика» — вторая смена, а не опоздание: в счёт не идут. Лавко-дней без ' +
      `отметки водителя за период: ${noDriverMark}.`,
    'Отчёт не меняет ни статусы лавок, ни итог радара и не выносит вердикт: он показывает, что ' +
      'разошлось с нормативом и насколько.',
  ];

  return {
    margin: [0, 16, 0, 0],
    stack: [
      { text: 'Как это считалось', style: 'h2', margin: [0, 0, 0, 4] },
      { ul: items, fontSize: 7.5, color: MUTED },
    ],
  };
}
