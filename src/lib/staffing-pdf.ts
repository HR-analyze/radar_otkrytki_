import type { CanvasRect, Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
import {
  INK,
  LINE,
  MUTED,
  SOFT,
  configuredPrinter,
  formatStamp,
  fullDate,
  tile,
} from './pdf-common';
import {
  MONTH_DAYS,
  STAFF_HOURLY_RATE,
  EXTRA_ROLES,
  STAFF_ROLES,
  TEMPLATE_ROLES,
  hasLayout,
  isExtraRole,
  offText,
  postsHeadcount,
  postsLabel,
  STAFF_ROLE_FORMS,
  STAFF_ROLE_TITLE,
  pay,
  rolePeak,
  roleTotals,
  slotLabel,
  slotPersonHours,
  slotShortLabel,
  staffAt,
  sumRoleTotals,
  type StaffNorm,
  type StaffRole,
  type StaffRoleTotals,
} from './staffing';
import { plural } from './plural';
import { formatClock } from './time';

/**
 * «График пиков» в PDF — для чтения и печати.
 *
 * Первая страница — сводка: итоги по сети (или по лавке), по каждой должности
 * пик, штат, человеко-часы и заработок. Дальше — по разделу на должность:
 * строка — лавка, колонки — окна этой должности. В одну таблицу, как на
 * вкладке, все четыре должности на лист A4 не влезают: сорок колонок по
 * полтора сантиметра — это мелкий шрифт и лупа. А окна у должностей свои,
 * поэтому раздел на должность ничего не теряет.
 *
 * В клетке окна сверху — сколько человек, снизу — их заработок за окно, ₽.
 * Заливка тем гуще, чем больше людей в окне: пики видно, не читая цифр.
 *
 * Считается на сервере, как отчёт конкурса (см. contest-pdf.ts). Эмодзи нет:
 * Roboto их не рисует.
 */

export interface StaffingReportInput {
  /** Лавки в отчёте: вся сеть или одна выбранная. */
  shown: StaffNorm[];
  source: string;
  builtAt: string;
  /** Когда сформирован; параметром — чтобы тест был воспроизводим. */
  generatedAt?: Date;
}

/** Готовый PDF одним буфером. */
export async function renderStaffingReport(input: StaffingReportInput): Promise<Buffer> {
  return configuredPrinter().createPdf(staffingReportDefinition(input)).getBuffer();
}

/** Цвет пика: тот же синий, что подсветка окна на вкладке. */
const PEAK = '#2563eb';

/**
 * Описание документа отдельно от рендера: так его видно в тестах, не собирая
 * PDF целиком.
 */
export function staffingReportDefinition(input: StaffingReportInput): TDocumentDefinitions {
  const { shown } = input;
  const one = shown.length === 1 ? shown[0] : null;
  const generatedAt = input.generatedAt ?? new Date();

  const byRole = STAFF_ROLES.map((role) => ({
    role,
    totals: sumRoleTotals(shown.map((n) => roleTotals(n.roles[role], role))),
    peak: rolePeak(shown, role),
  }));
  // Штат — по должностям шаблона: у замов и сборщика FTE в шаблоне нет, и
  // общий итог иначе стал бы неизвестным.
  const all = {
    ...sumRoleTotals(byRole.map((r) => r.totals)),
    fte: sumRoleTotals(byRole.filter((r) => !isExtraRole(r.role)).map((r) => r.totals)).fte,
  };

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 30, 28, 34],
    info: {
      title: one ? `График пиков — ${one.code} ${one.name}` : 'График пиков — все лавки',
      author: 'Радар витрин',
    },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: INK },
    content: [
      header(shown, one, generatedAt),
      {
        text: [
          'Норма выхода сотрудников по часовым окнам и заработок смен. Источник — ',
          { text: input.source, bold: true },
          `, собран ${fullDate(input.builtAt)}. ${rateText()}; месяц — ${MONTH_DAYS} ${plural(MONTH_DAYS, 'день', 'дня', 'дней')}, как в шаблоне.`,
        ],
        fontSize: 8,
        color: MUTED,
        margin: [0, 0, 0, 10],
      },
      kpiRow(all, shown.length, one),
      dayChart(shown),
      { text: 'Итого по должностям', style: 'h2', margin: [0, 12, 0, 6] },
      summaryTable(byRole, all),
      legend(),
      // Вся сеть — каждая должность с нового листа: разорванная посередине,
      // таблица поваров читалась бы как хвост кассиров. Одна лавка — все четыре
      // подряд на втором листе: по строке на должность листы были бы пустыми.
      ...TEMPLATE_ROLES.map((role, i) => roleSection(shown, role, one == null || i === 0)),
      extrasSection(shown, one == null),
      ...(one && hasLayout(one) ? [layoutSection(one)] : []),
    ],
    styles: {
      h1: { fontSize: 16, bold: true },
      h2: { fontSize: 11, bold: true },
      th: { fontSize: 7, bold: true, color: MUTED },
    },
    footer: (page: number, pages: number): Content => ({
      margin: [28, 8, 28, 0],
      columns: [
        { text: 'Радар витрин · график пиков', fontSize: 7, color: MUTED },
        { text: `${page} из ${pages}`, fontSize: 7, color: MUTED, alignment: 'right' },
      ],
    }),
  };
}

function header(shown: StaffNorm[], one: StaffNorm | null, generatedAt: Date): Content {
  const scope = one
    ? [
        `${one.code} ${one.name}`,
        one.grade ? `грейд ${one.grade}` : null,
        one.coffeeMachine == null ? null : one.coffeeMachine ? 'с кофемашиной' : 'без кофемашины',
      ]
        .filter(Boolean)
        .join(' · ')
    : `Все лавки сети · ${shown.length} ${plural(shown.length, 'лавка', 'лавки', 'лавок')}`;

  return {
    columns: [
      [
        { text: 'График пиков', style: 'h1' },
        { text: scope, fontSize: 10, margin: [0, 2, 0, 0] },
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
    margin: [0, 0, 0, 6],
  };
}

function kpiRow(all: StaffRoleTotals, shops: number, one: StaffNorm | null): Content {
  const tiles: [string, string, string][] = [
    ['Человеко-часов в день', num(all.day), `в месяц — ${num(all.month)}`],
    ['Заработок в день', `${num(all.dayPay)} ₽`, 'по ставкам должностей'],
    ['Заработок в месяц', `${num(all.monthPay)} ₽`, `день × ${MONTH_DAYS}`],
    ['Штат, FTE', num(all.fte), one ? 'без замов и сборщика' : `на ${shops} ${plural(shops, 'лавку', 'лавки', 'лавок')}, без замов и сборщиков`],
  ];
  return { columns: tiles.map(([title, value, hint]) => tile(title, value, hint)) };
}

/** Должности строками: пик, штат, часы и заработок за день и месяц. */
function summaryTable(
  byRole: { role: StaffRole; totals: StaffRoleTotals; peak: ReturnType<typeof rolePeak> }[],
  all: StaffRoleTotals,
): Content {
  const head: TableCell[] = [
    { text: 'Должность', style: 'th' },
    { text: 'Пик: человек · окно', style: 'th' },
    { text: 'FTE', style: 'th', alignment: 'right' },
    { text: 'Чел.-ч в день', style: 'th', alignment: 'right' },
    { text: '₽ в день', style: 'th', alignment: 'right' },
    { text: 'Чел.-ч в месяц', style: 'th', alignment: 'right' },
    { text: '₽ в месяц', style: 'th', alignment: 'right' },
  ];
  const line = (title: string, t: StaffRoleTotals, peak: string, bold = false, fillColor?: string): TableCell[] => [
    { text: title, bold: true, fillColor },
    { text: peak, color: bold ? INK : MUTED, fillColor },
    { text: num(t.fte), alignment: 'right', bold, fillColor },
    { text: num(t.day), alignment: 'right', bold, fillColor },
    { text: num(t.dayPay), alignment: 'right', bold, fillColor },
    { text: num(t.month), alignment: 'right', bold, fillColor },
    { text: num(t.monthPay), alignment: 'right', bold: true, fillColor },
  ];

  const body = byRole.map(({ role, totals, peak }) =>
    line(STAFF_ROLE_TITLE[role], totals, peak ? `${num(peak.count)} · ${slotLabel(peak.slot)}` : 'нет по шаблону'),
  );
  const total = line('Итого', all, '', true, SOFT);

  return {
    table: { headerRows: 1, widths: [70, '*', 40, 62, 70, 66, 80], body: [head, ...body, total] },
    layout: gridLayout(1, 0, true),
  };
}

/** Шкала заливки и что лежит в клетке. */
function legend(): Content {
  const steps = [0, 0.25, 0.5, 0.75, 1];
  const scale: CanvasRect[] = steps.map((t, i) => ({
    type: 'rect',
    x: i * 13,
    y: 1,
    w: 12,
    h: 8,
    r: 1,
    color: heat(t),
    lineColor: LINE,
    lineWidth: 0.4,
  }));
  return {
    margin: [0, 10, 0, 0],
    columns: [
      { width: 'auto', text: 'мало людей', fontSize: 7, color: MUTED, margin: [0, 1, 4, 0] },
      { width: steps.length * 13, canvas: scale },
      { width: 'auto', text: 'пик', fontSize: 7, color: MUTED, margin: [4, 1, 16, 0] },
      {
        width: '*',
        text: 'В клетке окна: сверху — сколько человек должно быть на смене, снизу — их заработок за окно, ₽. ' +
          'Окно: начало включительно, конец — нет.',
        fontSize: 7,
        color: MUTED,
        margin: [0, 1, 0, 0],
      },
    ],
  };
}

/* ----------------------------- график дня ------------------------------ */

/** Цвета должностей на графике: различимы и в цвете, и по яркости в ч/б печати. */
const ROLE_COLOR: Record<StaffRole, string> = {
  cashier: '#2563eb',
  cook: '#f59e0b',
  barista: '#a855f7',
  cleaner: '#14b8a6',
  barDeputy: '#e11d48',
  hallDeputy: '#0ea5e9',
  picker: '#84cc16',
};

/** Ширина полосы набора: A4 альбомом минус поля. */
const CONTENT_WIDTH = 842 - 28 * 2;

/** Шаг графика. Все границы окон в шаблоне — на целых и половинах часа. */
const STEP = 30;

/**
 * Сам «график пиков»: сколько людей на смене в каждые полчаса, столбиком по
 * должностям. По сети — сумма по лавкам. Текста на холсте pdfmake не умеет,
 * поэтому цифры осей — обычный текст с relativePosition поверх холста.
 */
function dayChart(shown: StaffNorm[]): Content {
  const slots = shown.flatMap((n) => STAFF_ROLES.flatMap((r) => n.roles[r].slots));
  const start = Math.floor(Math.min(...slots.map((s) => s.from ?? s.to - STEP)) / STEP) * STEP;
  const end = Math.ceil(Math.max(...slots.map((s) => s.to)) / STEP) * STEP;
  const count = Math.max(1, (end - start) / STEP);

  // staffAt берёт окно, в которое попадает начало получаса: границы окон
  // кратны 30 минутам, так что внутри получаса норма не меняется.
  const stacks = Array.from({ length: count }, (_, i) => {
    const at = shown.map((n) => staffAt(n, start + i * STEP));
    return STAFF_ROLES.map((_, k) => at.reduce((sum, a) => sum + a[k].count, 0));
  });
  const totals = stacks.map((st) => st.reduce((a, b) => a + b, 0));
  const peak = Math.max(0, ...totals);
  const top = niceCeil(peak);

  const axis = 26;
  const plotW = CONTENT_WIDTH - axis;
  const plotH = 140;
  const barW = plotW / count;
  const gap = Math.min(3, barW * 0.18);
  const y = (v: number) => plotH - (v / top) * plotH;

  const grid = [0, top / 2, top].map((v) => ({
    type: 'line' as const,
    x1: axis,
    y1: y(v),
    x2: axis + plotW,
    y2: y(v),
    lineWidth: v === 0 ? 0.8 : 0.4,
    lineColor: v === 0 ? MUTED : LINE,
  }));
  const bars = stacks.flatMap((st, i) => {
    let base = 0;
    return st.flatMap((v, k) => {
      if (v === 0) return [];
      const rect = {
        type: 'rect' as const,
        x: axis + i * barW + gap / 2,
        y: y(base + v),
        w: barW - gap,
        h: (v / top) * plotH,
        color: ROLE_COLOR[STAFF_ROLES[k]],
      };
      base += v;
      return [rect];
    });
  });
  // Пунктир на уровне пика — глазу есть за что зацепиться.
  const peakLine =
    peak > 0
      ? [{ type: 'line' as const, x1: axis, y1: y(peak), x2: axis + plotW, y2: y(peak), lineWidth: 0.6, lineColor: INK, dash: { length: 2, space: 2 } }]
      : [];

  // Середина оси — только целым числом: «7,5 человека» на оси читается странно.
  const yLabels = [0, top / 2, top]
    .filter(Number.isInteger)
    .map((v): Content => ({ text: num(v), fontSize: 6.5, color: MUTED, relativePosition: { x: 0, y: y(v) - 4 } }));
  const xLabels: Content[] = [];
  for (let i = 0; i <= count; i++) {
    const t = start + i * STEP;
    if (t % 60 !== 0) continue;
    const label = `${t / 60}:00`;
    xLabels.push({
      text: label,
      fontSize: 6.5,
      color: MUTED,
      // Подпись — по центру под границей часа: цифра Roboto 6,5 pt ≈ 3,6 pt.
      relativePosition: { x: axis + i * barW - label.length * 1.6, y: plotH + 3 },
    });
  }

  return {
    margin: [0, 14, 0, 0],
    stack: [
      {
        columns: [
          { width: 'auto', text: 'Сколько людей на смене в течение дня', style: 'h2' },
          { width: '*', text: peakText(totals, peak, start), fontSize: 8, alignment: 'right', margin: [0, 3, 0, 0] },
        ],
      },
      {
        margin: [0, 4, 0, 6],
        columns: STAFF_ROLES.map((role) => ({
          width: 'auto',
          columns: [
            { width: 10, canvas: [{ type: 'rect', x: 0, y: 2, w: 7, h: 7, r: 1, color: ROLE_COLOR[role] }] },
            { width: 'auto', text: STAFF_ROLE_TITLE[role], fontSize: 7.5, margin: [0, 0, 12, 0] },
          ],
        })),
      },
      { stack: [...yLabels, ...xLabels, { canvas: [...grid, ...bars, ...peakLine] }], margin: [0, 0, 0, 12] },
    ],
  };
}

/** «Пик — 266 человек, 11:00–16:00»: первый отрезок, где людей больше всего. */
function peakText(totals: number[], peak: number, start: number): string {
  if (peak === 0) return 'По шаблону на смене никого';
  const from = totals.indexOf(peak);
  let to = from;
  while (to + 1 < totals.length && totals[to + 1] === peak) to++;
  const span = `${formatClock(start + from * STEP)}–${formatClock(start + (to + 1) * STEP)}`;
  return `Пик — ${num(peak)} ${plural(peak, 'человек', 'человека', 'человек')}, ${span}`;
}

/** Верх оси: круглое число не меньше пика — 266 → 300, 13 → 15. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/* --------------------------- раздел должности --------------------------- */

function roleSection(shown: StaffNorm[], role: StaffRole, breakBefore: boolean): Content {
  const title = STAFF_ROLE_TITLE[role];
  const rate = STAFF_HOURLY_RATE[role];
  // Лавки, где должности нет по шаблону (бариста без кофемашины), строкой
  // нулей таблицу не засоряют — перечислены под ней.
  const rows = shown.filter((n) => n.roles[role].slots.some((s) => s.count > 0));
  const empty = shown.filter((n) => !rows.includes(n));
  const pageBreak = breakBefore ? ('before' as const) : undefined;

  if (rows.length === 0) {
    const [, , many] = STAFF_ROLE_FORMS[role];
    return {
      stack: [
        { text: title, style: 'h2' },
        {
          text: shown.length === 1 ? `В этой лавке ${many} по шаблону нет.` : `Ни в одной лавке ${many} по шаблону нет.`,
          color: MUTED,
          margin: [0, 2, 0, 0],
        },
      ],
      pageBreak,
      margin: [0, breakBefore ? 0 : 16, 0, 0],
    };
  }

  const slots = rows[0].roles[role].slots;
  const max = Math.max(1, ...rows.flatMap((n) => n.roles[role].slots.map((s) => s.count)));
  const columns = 1 + slots.length + 5;

  // Заголовок раздела — строкой таблицы, а не текстом над ней: таблица
  // поваров на 82 лавки занимает четыре листа, и шапка с должностью
  // повторяется на каждом — иначе на третьем листе не понять, чьи это окна.
  const peak = rolePeak(rows, role);
  const caption: TableCell[] = [
    {
      colSpan: columns,
      border: [false, false, false, false],
      margin: [-4, 0, -4, 4],
      columns: [
        { width: 'auto', text: title, fontSize: 12, bold: true },
        {
          width: '*',
          text: [
            `ставка ${rate} ₽/ч`,
            shown.length > 1 ? ` · ${rows.length} из ${shown.length} ${plural(shown.length, 'лавки', 'лавок', 'лавок')}` : '',
            peak && shown.length > 1 ? ` · пик по сети — ${num(peak.count)} чел., окно ${slotLabel(peak.slot)}` : '',
          ].join(''),
          fontSize: 8,
          color: MUTED,
          margin: [8, 3, 0, 0],
        },
      ],
    },
    ...Array.from({ length: columns - 1 }, () => ({})),
  ];

  const head: TableCell[] = [
    { text: 'Лавка', style: 'th' },
    ...slots.map((s): TableCell => ({ text: slotShortLabel(s), style: 'th', alignment: 'center' })),
    { text: 'FTE', style: 'th', alignment: 'center' },
    { text: 'Чел.-ч\nв день', style: 'th', alignment: 'right' },
    { text: '₽\nв день', style: 'th', alignment: 'right' },
    { text: 'Чел.-ч\nв месяц', style: 'th', alignment: 'right' },
    { text: '₽\nв месяц', style: 'th', alignment: 'right' },
  ];

  const body: TableCell[][] = rows.map((n) => {
    const r = n.roles[role];
    const t = roleTotals(r, role);
    return [
      {
        stack: [
          { text: `${n.code} ${n.name}`, bold: true },
          { text: n.grade ?? '', fontSize: 6.5, color: MUTED },
        ],
      },
      ...r.slots.map((s) => windowCell(s.count, pay(slotPersonHours(s), rate), s.count > 0 ? heat(s.count / max) : undefined)),
      ...totalsCells(t),
    ];
  });

  if (rows.length > 1) {
    const sum = sumRoleTotals(rows.map((n) => roleTotals(n.roles[role], role)));
    body.push([
      { text: 'Итого по сети', bold: true, fillColor: SOFT },
      ...slots.map((_, i) => {
        const count = rows.reduce((s, n) => s + n.roles[role].slots[i].count, 0);
        const money = rows.reduce<number | null>((s, n) => {
          const p = pay(slotPersonHours(n.roles[role].slots[i]), rate);
          return s == null || p == null ? null : s + p;
        }, 0);
        return windowCell(count, money, SOFT);
      }),
      ...totalsCells(sum, true, SOFT),
    ]);
  }

  const parts: Content[] = [
    {
      table: {
        headerRows: 2,
        dontBreakRows: true,
        widths: [122, ...slots.map(() => '*' as const), 26, 38, 50, 44, 56],
        body: [caption, head, ...body],
      },
      layout: gridLayout(2, slots.length, rows.length > 1),
      pageBreak,
      margin: [0, breakBefore ? 0 : 16, 0, 0],
    },
  ];

  if (empty.length > 0) {
    const [, , many] = STAFF_ROLE_FORMS[role];
    parts.push({
      text: [
        { text: `Без ${many} по шаблону — ${empty.length} ${plural(empty.length, 'лавка', 'лавки', 'лавок')}: `, bold: true },
        empty.map((n) => n.code).join(', '),
      ],
      fontSize: 7,
      color: MUTED,
      margin: [0, 6, 0, 0],
    });
  }

  return { stack: parts };
}

/** Клетка окна: люди крупно, рубли мелко. Заливку (по доле от пика) считает вызывающий. */
function windowCell(count: number, money: number | null, fillColor?: string): TableCell {
  if (count === 0) return { text: '0', alignment: 'center', color: MUTED, margin: [0, 3, 0, 0], fillColor };
  return {
    stack: [
      { text: num(count), bold: true, fontSize: 9.5 },
      { text: num(money), fontSize: 6.5, color: MUTED },
    ],
    alignment: 'center',
    fillColor,
  };
}

function totalsCells(t: StaffRoleTotals, bold = false, fillColor?: string): TableCell[] {
  const cell = (text: string, opts: { strong?: boolean; color?: string } = {}): TableCell => ({
    text,
    alignment: 'right',
    bold: bold || opts.strong,
    color: opts.color ?? INK,
    margin: [0, 3, 0, 0],
    fillColor,
  });
  return [
    { text: num(t.fte), alignment: 'center', color: MUTED, bold, margin: [0, 3, 0, 0], fillColor },
    cell(num(t.day)),
    cell(num(t.dayPay), { strong: true }),
    cell(num(t.month), { color: MUTED }),
    cell(num(t.monthPay), { strong: true }),
  ];
}

/* --------------------------- замы и сборщик ---------------------------- */

/**
 * Замы и сборщик — одной таблицей, а не разделом на должность: окно у них
 * одно на весь день, и по сети таблица из 82 строк «1» ничего бы не сказала.
 * По сети — сколько их и во что обходятся, плюс где есть сборщик.
 */
function extrasSection(shown: StaffNorm[], breakBefore: boolean): Content {
  const many = shown.length > 1;
  const head: TableCell[] = [
    { text: 'Должность', style: 'th' },
    { text: 'Окно', style: 'th' },
    { text: 'Ставка', style: 'th', alignment: 'right' },
    ...(many ? [{ text: 'Лавок', style: 'th', alignment: 'right' } as TableCell] : []),
    { text: 'Человек', style: 'th', alignment: 'right' },
    { text: 'Чел.-ч в день', style: 'th', alignment: 'right' },
    { text: '₽ в день', style: 'th', alignment: 'right' },
    { text: '₽ в месяц', style: 'th', alignment: 'right' },
  ];
  const body: TableCell[][] = EXTRA_ROLES.map((role) => {
    const t = sumRoleTotals(shown.map((n) => roleTotals(n.roles[role], role)));
    const people = shown.reduce((s, n) => s + n.roles[role].slots[0].count, 0);
    const shops = shown.filter((n) => n.roles[role].slots[0].count > 0).length;
    return [
      { text: STAFF_ROLE_TITLE[role], bold: true },
      { text: slotLabel(shown[0].roles[role].slots[0]), color: MUTED },
      { text: `${STAFF_HOURLY_RATE[role]} ₽/ч`, alignment: 'right', color: MUTED },
      ...(many ? [{ text: `${shops} из ${shown.length}`, alignment: 'right', color: MUTED } as TableCell] : []),
      { text: num(people), alignment: 'right', bold: true },
      { text: num(t.day), alignment: 'right' },
      { text: num(t.dayPay), alignment: 'right' },
      { text: num(t.monthPay), alignment: 'right', bold: true },
    ];
  });

  const pickers = shown.filter((n) => n.roles.picker.slots[0].count > 0).map((n) => n.code);
  return {
    pageBreak: breakBefore ? 'before' : undefined,
    margin: [0, breakBefore ? 0 : 16, 0, 0],
    stack: [
      { text: 'Замы и сборщик заказов', style: 'h2' },
      {
        text:
          'Замы — всегда по одному в лавке: по бару 6:30–18:00, по залу 6:30–23:00. Сборщик — там, где он есть ' +
          'в «ШР по лавкам», 7:00–16:00.',
        fontSize: 7.5,
        color: MUTED,
        margin: [0, 2, 0, 6],
      },
      {
        table: { headerRows: 1, widths: [90, 70, 50, ...(many ? [50] : []), 50, '*', '*', '*'], body: [head, ...body] },
        layout: gridLayout(1, 0, false),
      },
      ...(many
        ? [
            {
              text: [
                { text: `Сборщик заказов есть в ${pickers.length} ${plural(pickers.length, 'лавке', 'лавках', 'лавках')}: `, bold: true },
                pickers.join(', ') || '—',
              ],
              fontSize: 7,
              color: MUTED,
              margin: [0, 6, 0, 0],
            } as Content,
          ]
        : []),
    ],
  };
}

/* ------------------------- расстановка лавки --------------------------- */

/**
 * Кто где стоит: по каждой должности окна, норма и посты из шаблона. Не
 * сходится расстановка с нормой («расписано 2 из 4») — так и
 * пишем: это вопрос к тому, кто расписывал, а не опечатка в отчёте.
 */
function layoutSection(norm: StaffNorm): Content {
  const head: TableCell[] = [
    { text: 'Должность', style: 'th' },
    { text: 'Окно', style: 'th' },
    { text: 'По норме', style: 'th', alignment: 'right' },
    { text: 'Где стоят', style: 'th' },
  ];
  const body: TableCell[][] = [];
  // Замы сверху, сборщик внизу — как на вкладке.
  for (const role of ['barDeputy', 'hallDeputy', ...TEMPLATE_ROLES, 'picker'] as const) {
    const r = norm.roles[role];
    const rows = r.slots
      .map((slot, i) => ({ slot, posts: r.posts?.[i] ?? [] }))
      .filter(({ slot, posts }) => slot.count > 0 || posts.length > 0);
    rows.forEach(({ slot, posts }, i) => {
      const counted = postsHeadcount(posts, role);
      const off = counted != null && counted !== slot.count;
      body.push([
        i === 0
          ? { text: STAFF_ROLE_TITLE[role], bold: true, rowSpan: rows.length }
          : {},
        { text: slotLabel(slot), color: MUTED },
        { text: num(slot.count), alignment: 'right', bold: true },
        {
          text: [
            { text: posts.length ? postsLabel(posts) : 'не расписано', color: posts.length ? INK : MUTED },
            off ? { text: `   ${offText(counted!, slot.count)}`, color: '#dc2626', bold: true, fontSize: 7 } : '',
          ],
        },
      ]);
    });
  }

  const layout = norm.layout;
  return {
    pageBreak: 'before',
    stack: [
      { text: 'Расстановка по дислокациям', style: 'h2' },
      {
        text: `${norm.code} ${norm.name}: кто где стоит в каждом окне — как расписано в шаблоне. Кондитерка и кулинария — одно место.`,
        fontSize: 7.5,
        color: MUTED,
        margin: [0, 2, 0, 6],
      },
      ...(layout?.stations.length
        ? [{ text: [{ text: 'Рабочие места: ', bold: true }, postsLabel(layout.stations)], margin: [0, 0, 0, 3] } as Content]
        : []),
      ...(layout?.remarks.length
        ? [{ text: [{ text: 'Пометки: ', bold: true }, layout.remarks.join('; ')], margin: [0, 0, 0, 6] } as Content]
        : []),
      {
        table: { headerRows: 1, dontBreakRows: true, widths: [90, 70, 44, '*'], body: [head, ...body] },
        layout: gridLayout(1, 0, false),
      },
    ],
  };
}

/* -------------------------------- мелочи -------------------------------- */

/**
 * Линейки: горизонтальные тонкие, под шапкой и над итогом — потолще;
 * вертикальные — только отделить лавку от окон и окна от итогов.
 */
function gridLayout(headerRows: number, windows: number, totalsRow: boolean) {
  return {
    hLineWidth: (i: number, node: { table: { body: unknown[] } }) => {
      const n = node.table.body.length;
      if (i < headerRows - 1) return 0;
      if (i === headerRows || i === n || (totalsRow && i === n - 1)) return 0.8;
      return 0.4;
    },
    vLineWidth: (i: number) => (windows > 0 && (i === 1 || i === 1 + windows) ? 0.6 : 0),
    hLineColor: (i: number) => (i === headerRows ? MUTED : LINE),
    vLineColor: () => LINE,
    paddingTop: () => 2,
    paddingBottom: () => 2,
    paddingLeft: () => 4,
    paddingRight: () => 4,
  };
}

/**
 * Заливка клетки: от еле заметной до насыщенной, смешением с белым. Кривая
 * выпуклая (степень 1,5): обычные окна остаются светлыми, а пик заметно темнее —
 * при линейной вся таблица выходила одинаково голубой.
 */
function heat(share: number): string {
  const alpha = 0.05 + 0.4 * Math.min(1, Math.max(0, share)) ** 1.5;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(PEAK.slice(i, i + 2), 16));
  const mix = (c: number) => Math.round(255 + (c - 255) * alpha).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

/**
 * 39.5 → «39,5», 595820 → «595 820», четырёхзначные слитно — как на вкладке.
 * Разряды — обычным неразрывным пробелом: узкого (U+202F) в Roboto нет.
 */
function num(n: number | null): string {
  if (n == null) return '—';
  const [int, frac] = String(Math.round(n * 10) / 10).split('.');
  const grouped = Math.abs(n) < 10_000 ? int : int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac ? `${grouped},${frac}` : grouped;
}

/** «Ставки: 310 ₽/ч — кассир, повар…; 350 ₽/ч — ЗД по бару, ЗД по залу». */
function rateText(): string {
  const rates = [...new Set(STAFF_ROLES.map((r) => STAFF_HOURLY_RATE[r]))];
  if (rates.length === 1) return `Ставка ${rates[0]} ₽/ч у всех должностей`;
  const groups = rates.map((rate) => {
    const roles = STAFF_ROLES.filter((r) => STAFF_HOURLY_RATE[r] === rate).map((r) => STAFF_ROLE_TITLE[r].replace(/^[А-Я][а-я]/, (w) => w.toLowerCase()));
    return `${rate} ₽/ч — ${roles.join(', ')}`;
  });
  return `Ставки: ${groups.join('; ')}`;
}
