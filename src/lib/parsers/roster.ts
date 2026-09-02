import * as XLSX from 'xlsx';
import { parseShop } from '../shops';

/**
 * Справочник лавок «Лавки БК»: кто из региональных менеджеров за какую лавку
 * отвечает.
 *
 * Зачем отдельный источник. Раньше РМ брался из легаси-книги «Витрины» —
 * вместе с раскрашенными вручную статусами. Но люди меняются чаще, чем
 * перезаливают книгу: в ней остались менеджеры, которых в компании уже нет.
 * Справочник обновляют отдельно, поэтому и в радаре он отдельный: загрузили —
 * и РМ поменялся у всех дней сразу, включая уже загруженные.
 *
 * Две особенности реального файла:
 *
 *  - **объединённые ячейки.** Один менеджер отвечает за 9–11 лавок подряд, и
 *    в таблице это одна ячейка на весь блок. Excel отдаёт значение только в
 *    левом верхнем углу, остальные строки приходят пустыми — их надо развернуть
 *    по `!merges`, иначе 9 лавок из 10 останутся без РМ;
 *  - **в ячейке не только имя**, но и телефон с почтой:
 *    «Шевкун Виктория 8 (916) 253-08-23 v.shevkun@karavaevi.ru». В радаре
 *    нужно имя — по нему фильтруют.
 */

export const ROSTER_SHEET = 'Лавки БК';

export interface RosterRow {
  shopCode: string;
  /** Название лавки из справочника — без кода. */
  shopName: string;
  /** Региональный менеджер или null, если ячейка пустая либо это не имя. */
  manager: string | null;
  /** Территориальный директор — пока не используется, но в файле есть. */
  director: string | null;
}

export interface RosterParseResult {
  rows: RosterRow[];
  /** Действующие менеджеры — те, кто остался в справочнике. */
  managers: string[];
  warnings: string[];
}

const COL = {
  code: '№',
  name: 'Лавка',
  director: 'Территориальный директор',
  manager: 'Региональный менеджер',
} as const;

export function parseRoster(buffer: Buffer, sheetName = ROSTER_SHEET): RosterParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });

  // Лист называется «Лавки БК » — с хвостовым пробелом. Ищем по обрезанному имени.
  const actual = wb.SheetNames.find((n) => n.trim() === sheetName.trim());
  if (!actual) throw new Error(`В книге нет листа «${sheetName}»`);
  const sheet = wb.Sheets[actual];

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
  expandMerges(grid, sheet['!merges'] ?? []);

  const header = grid[0] ?? [];
  const at = {
    code: columnIndex(header, COL.code),
    name: columnIndex(header, COL.name),
    director: columnIndex(header, COL.director),
    manager: columnIndex(header, COL.manager),
  };
  if (at.code < 0 || at.manager < 0) {
    throw new Error(
      `В листе «${actual}» нет колонок «${COL.code}» и «${COL.manager}» — это не справочник лавок`,
    );
  }

  const rows: RosterRow[] = [];
  const warnings: string[] = [];
  const managers = new Set<string>();
  const seen = new Set<string>();

  for (let i = 1; i < grid.length; i++) {
    const raw = grid[i] ?? [];
    const shop = parseShop(raw[at.code]);
    if (!shop) continue;

    if (seen.has(shop.code)) {
      warnings.push(`Строка ${i + 1}: лавка ${shop.code} встречается второй раз — взята первая`);
      continue;
    }
    seen.add(shop.code);

    const rawManager = String(raw[at.manager] ?? '').trim();
    const manager = personName(rawManager);
    if (rawManager && !manager) {
      warnings.push(
        `Строка ${i + 1}: у лавки ${shop.code} в колонке РМ не имя, а «${rawManager.slice(0, 40)}» — РМ не проставлен`,
      );
    }
    if (manager) managers.add(manager);

    rows.push({
      shopCode: shop.code,
      shopName: String(raw[at.name] ?? '').trim(),
      manager,
      director: at.director >= 0 ? personName(String(raw[at.director] ?? '').trim()) : null,
    });
  }

  if (rows.length === 0) warnings.push(`В листе «${actual}» не нашлось ни одной лавки`);

  return { rows, managers: [...managers].sort(), warnings };
}

/**
 * Объединённая ячейка накрывает блок строк, а значение лежит только в её левом
 * верхнем углу. Раскладываем его по всему блоку — иначе у 9 лавок из 10 РМ
 * окажется пустым.
 */
function expandMerges(grid: unknown[][], merges: readonly XLSX.Range[]): void {
  for (const m of merges) {
    const value = grid[m.s.r]?.[m.s.c] ?? null;
    if (value == null) continue;
    for (let r = m.s.r; r <= m.e.r; r++) {
      if (!grid[r]) continue;
      for (let c = m.s.c; c <= m.e.c; c++) grid[r][c] = value;
    }
  }
}

function columnIndex(header: readonly unknown[], title: string): number {
  return header.findIndex((c) => String(c ?? '').trim().toLowerCase() === title.toLowerCase());
}

/**
 * Имя человека из ячейки с контактами: «Шевкун Виктория 8 (916) 253-08-23
 * v.shevkun@karavaevi.ru» → «Шевкун Виктория».
 *
 * Всё, что не похоже на «Фамилия Имя», отбрасывается: в колонке РМ попадаются
 * и пометки вроде «ЛАВКА ЗАКРЫТА !!!!!» — менеджером их считать нельзя.
 */
export function personName(raw: string): string | null {
  const head = raw.split(/[\d(<@\n,;]/)[0].replace(/\s+/g, ' ').trim();
  const words = head.split(' ').filter(Boolean);
  const isName = (w: string) => /^[А-ЯЁ][а-яё-]+$/.test(w);

  const name = words.slice(0, 3).filter(isName);
  return name.length >= 2 ? name.join(' ') : null;
}
