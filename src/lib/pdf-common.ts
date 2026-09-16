import pdfMake from 'pdfmake';
import robotoContainer from 'pdfmake/build/fonts/Roboto';
import type { CanvasRect, Column } from 'pdfmake/interfaces';
import { RADAR_TZ } from './time';

/**
 * Общая оснастка серверных PDF-отчётов: шрифты, палитра, разлиновка таблиц.
 *
 * Отчётов уже два — конкурс по витринам и сверка отметок, — и раньше вся эта
 * мелочь жила в первом из них. Второй либо повторил бы её слово в слово, либо
 * разъехался с ним по цветам и отступам: два отчёта одной системы не должны
 * выглядеть как отчёты двух разных.
 *
 * Эмодзи здесь нет нигде: Roboto их не содержит, и вместо 🟢 печатается пустой
 * прямоугольник. Цвет в отчётах — нарисованная фигура, а не символ.
 */

/** Цвета зон радара — те же, что на экране (globals.css). */
export const COLOR: Record<'green' | 'yellow' | 'red', string> = {
  green: '#16a34a',
  yellow: '#eab308',
  red: '#dc2626',
};

export const INK = '#0f172a';
export const MUTED = '#64748b';
export const LINE = '#e2e8f0';
export const SOFT = '#f8fafc';

/** Только горизонтальные линейки: вертикальные превращают таблицу в решётку. */
export function rowsLayout() {
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

/** Рамка без внутренних отступов — под плитки-итоги. */
export function borderless() {
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

export function square(x: number, y: number, size: number, color: string): CanvasRect {
  return { type: 'rect', x, y, w: size, h: size, r: 1, color };
}

/** Плитка с крупным числом: заголовок, значение, подпись под ним. */
export function tile(
  title: string,
  value: string,
  hint?: string,
  /** Цвет числа. Не задан — обычные чернила. */
  valueColor?: string,
): Column {
  return {
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
              {
                text: value,
                fontSize: 15,
                bold: true,
                color: valueColor ?? INK,
                margin: [0, 2, 0, 1],
              },
              { text: hint ?? '', fontSize: 6.5, color: MUTED },
            ],
          },
        ],
      ],
    },
    layout: borderless(),
  };
}

/** «2026-08-19» → «19.08.2026»: в отчёте, который хранят, год нужен. */
export function fullDate(iso: string): string {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Время формирования — всегда московское: сервер на хостинге живёт в UTC, и
 * отчёт, собранный в 14:05 по Москве, был бы подписан «11:05».
 */
export function formatStamp(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: RADAR_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/**
 * Roboto из пакета pdfmake: у него есть кириллица, а грузить шрифт из сети
 * серверу незачем. Регистрируется один раз на процесс.
 */
let ready = false;

export function configuredPrinter(): typeof pdfMake {
  if (ready) return pdfMake;

  const container = robotoContainer as unknown as {
    vfs: Record<string, { data: string; encoding: string }>;
    fonts: Record<string, Record<string, string>>;
  };

  for (const [name, file] of Object.entries(container.vfs)) {
    pdfMake.virtualfs.writeFileSync(name, file.data, file.encoding);
  }
  pdfMake.setFonts(container.fonts);

  // Никаких внешних и локальных файлов: в отчётах только текст и фигуры,
  // а качать что-то по ссылке из документа сервер не должен вовсе.
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy(() => false);

  ready = true;
  return pdfMake;
}
