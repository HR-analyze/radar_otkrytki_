import * as XLSX from 'xlsx';
import { detectFixtureKind, peekGrid, SUPPORTED, type FixtureKind } from './fixtures';
import { parseAttendanceBuffer, type ParseWarning } from './parsers/attendance';
import { parseDeliveryTimes } from './parsers/delivery';
import { parseDepartures } from './parsers/departure';
import { parseLegacyVitriny } from './parsers/legacy-vitriny';
import { parseRoster } from './parsers/roster';
import { parseShowcaseSheets, type ShowcaseSheetCell } from './parsers/showcase-sheets';
import { parseShopNorms } from './parsers/shop-norms';
import { normsSeedJson, readNormsSeed } from './shop-norms-store';
import type { ShopNorms } from './types';
import { plural } from './plural';
import { isIgnoredRole } from './status';
import { formatDuration, shortDate } from './time';
import type { ThresholdConfig } from './types';

/**
 * Разбор файла, пришедшего кнопкой «Загрузить» с дашборда.
 *
 * Файл никуда не кладётся, пока его не удалось прочитать теми же парсерами,
 * которыми собирается снимок: приняли — значит данные из него точно доедут.
 * Отсюда же берётся фраза «файл распознан» для UI: человек должен увидеть,
 * что именно система поняла — тип выгрузки, дни и объём, — а не просто «ок».
 */

/**
 * Больше 4.5 МБ serverless-функция Vercel не принимает вовсе (413 ещё до нашего
 * кода), поэтому режем раньше и с внятным текстом. Самая большая реальная
 * выгрузка — шесть дней «выходов» — весит 744 КБ, запас десятикратный.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface UploadInspection {
  /** Имя файла как его дал пользователь. */
  originalName: string;
  kind: FixtureKind;
  /** Имя, под которым файл ляжет в fixtures/ — см. canonicalFixtureName. */
  fileName: string;
  /** Готовая строка для UI: «Выгрузка „водители“ · 28.08 · 76 отметок». */
  summary: string;
  dates: string[];
  rows: number;
  shops: number;
  /**
   * Должности, которых радар не знает: их нет ни среди критериев, ни в списке
   * заведомо посторонних. Строки по ним разбираются, но ни на что не влияют —
   * поэтому их видно в панели поимённо, а не общим счётчиком предупреждений.
   */
  unknownRoles: { role: string; rows: number }[];
  /**
   * Наполнение витрин — у kind='legacy' (книга «Все данные») и 'showcase'
   * (Google-таблица). Роут загрузки применяет их в базу ручных данных тем же
   * способом, что и правка на вкладке «Витрины» (см. saveShowcaseEdits):
   * поле, которого нет, в базе не трогается.
   */
  showcase: ShowcaseUploadEdit[];
  /**
   * Файлы, которые кладутся рядом с загруженным, — у справочника норм это
   * разобранный shop-norms.json: снимок читает нормы из него.
   */
  extraFiles?: { fileName: string; buffer: Buffer }[];
  /** Что парсер пропустил или посчитал странным — короткими фразами для UI. */
  notes: string[];
  /** Предупреждения парсера целиком — для логов и отладки. */
  warnings: string[];
}

export interface ShowcaseUploadEdit {
  date: string;
  shopCode: string;
  /** Замер на 08:00, доля 0–1. */
  fill?: number;
  /** Замер на 16:00, доля 0–1. */
  afternoonFill?: number;
  /** Комментарий дня — текст, который вписали в ячейку вместо числа. */
  note?: string;
}

export type InspectResult =
  | { ok: true; file: UploadInspection }
  | { ok: false; originalName: string; error: string };

/** Подмножество выгрузки отметок: только водители, только сотрудники или всё вместе. */
export type AttendanceFlavor = 'voditeli' | 'vyhody' | 'otmetki';

export function isSupportedFileName(name: string): boolean {
  return SUPPORTED.test(name);
}

/**
 * Имя файла из браузера — недоверенная строка: в ней бывают пути (Safari отдаёт
 * полный путь), кавычки и управляющие символы. На диск и в репозиторий уходит
 * не она, а каноническое имя, но человеку её показываем — поэтому чистим.
 */
export function safeDisplayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'без имени';
}

function extensionOf(name: string): string {
  const m = /\.(xls|xlsx)$/i.exec(name);
  return m ? m[1].toLowerCase() : 'xls';
}

/**
 * Имя файла в `fixtures/` выводится из содержимого, а не из того, как файл
 * назвали на диске.
 *
 * Иначе повторная загрузка того же дня («выгрузка (1).xls») положила бы рядом
 * второй файл: отметки задвоились бы, а вторая легаси-книга и вовсе молча не
 * попала бы в снимок — `readFixtures` берёт только первую. С каноническим
 * именем повторная загрузка заменяет файл, как и ожидает человек.
 */
export function canonicalFixtureName(
  kind: FixtureKind,
  dates: readonly string[],
  originalName: string,
  flavor: AttendanceFlavor = 'otmetki',
): string {
  const ext = extensionOf(originalName);
  if (kind === 'legacy') return `vitriny.${ext}`;
  // В fixtures/ не кладётся: имя нужно только журналу загрузок.
  if (kind === 'showcase') return `vitriny-google.${ext}`;
  // Тот же стебель, что у прежнего normy-lavok.csv: новый справочник его вытесняет.
  if (kind === 'norms') return `normy-lavok.${ext}`;
  if (kind === 'delivery') return `vremya-postavki.${ext}`;
  if (kind === 'roster') return `spravochnik-lavok.${ext}`;
  if (kind === 'departure') {
    const sorted = [...dates].sort();
    const span =
      sorted.length > 1 && sorted[0] !== sorted[sorted.length - 1]
        ? `${sorted[0]}_${sorted[sorted.length - 1]}`
        : (sorted[0] ?? 'bez-daty');
    return `${span}_vyezd-rc.${ext}`;
  }

  const sorted = [...dates].sort();
  const span =
    sorted.length > 1 && sorted[0] !== sorted[sorted.length - 1]
      ? `${sorted[0]}_${sorted[sorted.length - 1]}`
      : sorted[0];
  return `${span}_${flavor}.${ext}`;
}

/** Тот же файл, но с другим расширением: vitriny.xls рядом с vitriny.xlsx. */
export function isSupersededBy(existingName: string, newName: string): boolean {
  // csv — ради справочника норм: прежний normy-lavok.csv вытесняется загруженным
  // normy-lavok.xlsx, иначе в fixtures/ лежали бы два исходника одних норм.
  const stem = (n: string) => n.replace(/\.(xls|xlsx|csv)$/i, '').toLowerCase();
  return existingName !== newName && stem(existingName) === stem(newName);
}

export function inspectUpload(
  originalName: string,
  buffer: Buffer,
  config: ThresholdConfig,
): InspectResult {
  const displayName = safeDisplayName(originalName);
  const reject = (error: string): InspectResult => ({ ok: false, originalName: displayName, error });

  if (!isSupportedFileName(displayName)) {
    return reject('Нужен файл .xls или .xlsx — как приходит выгрузка из 1С.');
  }
  if (buffer.length === 0) return reject('Файл пустой.');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return reject(
      `Файл весит ${Math.round(buffer.length / 1024 / 1024)} МБ, а больше ` +
        `${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ загрузить нельзя. ` +
        'Выгрузите период покороче.',
    );
  }

  let sheetNames: string[];
  try {
    // bookSheets: сначала только имена листов — по ним и определяется тип.
    sheetNames = XLSX.read(buffer, { type: 'buffer', bookSheets: true }).SheetNames;
  } catch (e) {
    return reject(
      `Не удалось прочитать книгу Excel (${e instanceof Error ? e.message : String(e)}). ` +
        'Похоже, это не выгрузка из 1С.',
    );
  }

  try {
    // Выгрузка по РЦ по именам листов неотличима от отметок — смотрим содержимое.
    const byName = detectFixtureKind(sheetNames);
    const kind = byName === 'attendance' ? detectFixtureKind(sheetNames, peekGrid(buffer)) : byName;

    if (kind === 'showcase') return inspectShowcaseBook(displayName, buffer);
    if (kind === 'norms') return inspectNorms(displayName, buffer);
    if (kind === 'legacy') return inspectLegacy(displayName, buffer, config);
    if (kind === 'delivery') return inspectDelivery(displayName, buffer);
    if (kind === 'roster') return inspectRoster(displayName, buffer);
    if (kind === 'departure') return inspectDeparture(displayName, buffer, config);
    return inspectAttendance(displayName, buffer, config);
  } catch (e) {
    return reject(`Разбор не удался: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Выгрузка по распределительному центру: во сколько водители выехали со склада.
 *
 * Лавок в ней нет, поэтому в панели честно пишем, что это сетевой показатель,
 * а не оценка конкретных лавок, — иначе человек ждал бы, что после загрузки
 * поменяются цифры по водителю у лавок, а они не поменяются.
 */
function inspectDeparture(name: string, buffer: Buffer, config: ThresholdConfig): InspectResult {
  const parsed = parseDepartures(buffer);

  if (parsed.rows.length === 0) {
    return {
      ok: false,
      originalName: name,
      error:
        'Похоже на выгрузку по РЦ, но ни одной строки с сотрудником и отметками в ней нет.',
    };
  }

  const withDeparture = parsed.rows.filter((r) => r.departureMinutes != null).length;
  const people = new Set(parsed.rows.map((r) => r.employeeName)).size;
  const missing = parsed.rows.length - withDeparture;

  const notes: string[] = [
    'Выезд с РЦ — сетевой показатель: лавок в этой выгрузке нет, поэтому статусы ' +
      'по водителю у лавок она не меняет.',
  ];
  if (missing > 0) {
    notes.push(
      `${missing} ${plural(missing, 'строка', 'строки', 'строк')} без ухода — выезд по ним неизвестен.`,
    );
  }

  const rule = config.rules.driverDeparture;
  if (rule) {
    const z = config.rules.scoreZones;
    notes.push(
      `Баллы за выезд: 🟢 до ${rule.greenUntil} — ${z.green}, ` +
        `🟡 до ${rule.yellowUntil} — ${z.yellow}, 🔴 позже — ${z.red}.`,
    );
  }

  // Время на фабрике — справочное: в балл не входит, но это второе, что
  // спрашивают по этой выгрузке, поэтому видно уже в предпросмотре.
  const stays = parsed.rows
    .map((r) =>
      r.arrivalMinutes != null && r.departureMinutes != null && r.departureMinutes >= r.arrivalMinutes
        ? r.departureMinutes - r.arrivalMinutes
        : null,
    )
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  if (stays.length > 0) {
    notes.push(
      `Время на фабрике (приезд → выезд), медиана ${formatDuration(stays[Math.floor(stays.length / 2)])} ` +
        `по ${stays.length} ${plural(stays.length, 'выезду', 'выездам', 'выездам')} — справочно.`,
    );
  }

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'departure',
      fileName: canonicalFixtureName('departure', parsed.dates, name),
      summary:
        `Выезд с ${parsed.units.join(', ') || 'РЦ'} · ${describeDates(parsed.dates)} · ` +
        `${people} ${plural(people, 'водитель', 'водителя', 'водителей')}, ` +
        `${withDeparture} ${plural(withDeparture, 'выезд', 'выезда', 'выездов')}`,
      dates: parsed.dates,
      rows: parsed.rows.length,
      shops: 0,
      unknownRoles: [],
      showcase: [],
      notes,
      warnings: parsed.warnings,
    },
  };
}

function inspectAttendance(name: string, buffer: Buffer, config: ThresholdConfig): InspectResult {
  const parsed = parseAttendanceBuffer(buffer, config);

  if (parsed.rows.length === 0) {
    return {
      ok: false,
      originalName: name,
      error:
        'Ни одной строки с лавкой и сотрудником. Для выгрузки отметок нужны колонки ' +
        '«Подразделение», «Сотрудник», «Должность», «Приход».',
    };
  }
  if (parsed.dates.length === 0) {
    return {
      ok: false,
      originalName: name,
      error: 'В файле нет ни одной даты — по колонкам «Приход»/«Уход» день определить не вышло.',
    };
  }

  const drivers = parsed.rows.filter((r) => r.criterion === 'driver').length;
  const flavor: AttendanceFlavor =
    drivers === parsed.rows.length ? 'voditeli' : drivers === 0 ? 'vyhody' : 'otmetki';
  const title =
    flavor === 'voditeli'
      ? 'Выгрузка «водители»'
      : flavor === 'vyhody'
        ? 'Выгрузка «выходы»'
        : 'Выгрузка отметок: водители и сотрудники вместе';

  const shops = new Set(parsed.rows.map((r) => r.shopCode)).size;

  // Смена, которая кончилась после полуночи, даёт одну-две отметки следующим
  // днём. Днями выгрузки они не считаются: иначе файл за 29-е назывался бы
  // «29–30 августа» из-за двух уборщиков, ушедших в 4 утра.
  const main = mainDates(parsed.rows.map((r) => r.date));
  const strays = parsed.rows.filter((r) => !main.includes(r.date)).length;

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'attendance',
      fileName: canonicalFixtureName('attendance', main, name, flavor),
      summary:
        `${title} · ${describeDates(main)} · ${parsed.rows.length} ` +
        `${plural(parsed.rows.length, 'отметка', 'отметки', 'отметок')}, ` +
        `${shops} ${plural(shops, 'лавка', 'лавки', 'лавок')}` +
        (strays > 0
          ? ` · ещё ${strays} ${plural(strays, 'отметка', 'отметки', 'отметок')} после полуночи ` +
            `(${parsed.dates.filter((d) => !main.includes(d)).map(shortDate).join(', ')})`
          : ''),
      dates: parsed.dates,
      rows: parsed.rows.length,
      shops,
      unknownRoles: unknownRoles(parsed.rows, config),
      showcase: [],
      notes: describeWarnings(parsed.warnings),
      warnings: parsed.warnings.map((w) => w.message),
    },
  };
}

/**
 * Должности, по которым строки разобраны, но ни один критерий их не считает.
 * Заведомо посторонние (уборщик, директор) сюда не попадают — они в
 * `ignoredRoles`, и говорить о них каждый раз незачем.
 */
function unknownRoles(
  rows: readonly { role: string; criterion: unknown }[],
  config: ThresholdConfig,
): { role: string; rows: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.criterion || isIgnoredRole(r.role, config)) continue;
    const role = r.role.trim() || 'без должности';
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([role, n]) => ({ role, rows: n }));
}

/** Предупреждения парсера — в короткие фразы, понятные без чтения кода. */
function describeWarnings(warnings: readonly ParseWarning[]): string[] {
  const counts = new Map<ParseWarning['kind'], number>();
  for (const w of warnings) counts.set(w.kind, (counts.get(w.kind) ?? 0) + 1);

  const notes: string[] = [];
  const n = (kind: ParseWarning['kind']) => counts.get(kind) ?? 0;

  if (n('no_stamps') > 0) {
    notes.push(
      `${n('no_stamps')} ${plural(n('no_stamps'), 'человек', 'человека', 'человек')} без отметки ` +
        'времени — эти строки пропущены',
    );
  }
  if (n('no_date') > 0) {
    notes.push(`${n('no_date')} строк без даты — пропущены`);
  }
  if (n('no_shop') > 0) {
    notes.push(`${n('no_shop')} строк без лавки — пропущены`);
  }
  if (n('previous_shift') > 0) {
    notes.push(
      `${n('previous_shift')} ${plural(n('previous_shift'), 'ночной уход', 'ночных ухода', 'ночных уходов')} ` +
        'без прихода — конец вчерашней смены, не учитываются',
    );
  }
  if (n('shop_mismatch') > 0) {
    notes.push(
      `${n('shop_mismatch')} ${plural(n('shop_mismatch'), 'отметка', 'отметки', 'отметок')} ` +
        'не в своей лавке — считаем по месту отметки',
    );
  }
  return notes;
}

/**
 * Что сказать про наполнение витрин из книги. Человек заливает её именно ради
 * процентов, поэтому в панели должно быть видно, сколько значений и за какие
 * дни радар из неё взял, — «файл распознан» без этого выглядит как «ничего не
 * произошло».
 */
function showcaseNote(rows: readonly { date: string; fill: number }[]): string[] {
  if (rows.length === 0) {
    return [
      'Наполнения витрин в книге нет: строки «Наполнение витрины» пустые. ' +
        'Заполнить можно на вкладке «Витрины».',
    ];
  }

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  return [
    `Наполнение витрин: ${rows.length} ` +
      `${plural(rows.length, 'значение', 'значения', 'значений')} за ${describeDates(dates)} — ` +
      'уходит в базу, как если бы их вписали на вкладке «Витрины».',
  ];
}

function inspectLegacy(name: string, buffer: Buffer, config: ThresholdConfig): InspectResult {
  const parsed = parseLegacyVitriny(buffer, config);

  if (parsed.shops.length === 0 || parsed.dates.length === 0) {
    return {
      ok: false,
      originalName: name,
      error: 'Лист «Все данные» есть, но лавок или дат в нём не нашлось.',
    };
  }

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'legacy',
      fileName: canonicalFixtureName('legacy', parsed.dates, name),
      summary:
        `Книга «Витрины» · ${describeDates(parsed.dates)} · ` +
        `${parsed.shops.length} ${plural(parsed.shops.length, 'лавка', 'лавки', 'лавок')}, ` +
        `${parsed.showcase.length} ${plural(parsed.showcase.length, 'значение', 'значения', 'значений')} наполнения витрин, ` +
        `${parsed.people.length} раскрашенных вручную статусов сотрудников`,
      dates: parsed.dates,
      rows: parsed.people.length + parsed.showcase.length,
      shops: parsed.shops.length,
      unknownRoles: [],
      // Проценты из книги — те же правки, что и на вкладке «Витрины»: роут
      // загрузки кладёт их в базу ручных данных. Так книгу можно вести в
      // Excel и заливать целиком, не перещёлкивая 80 лавок руками.
      showcase: parsed.showcase.map((s) => ({
        date: s.date,
        shopCode: s.shopCode,
        fill: s.fill,
      })),
      notes: showcaseNote(parsed.showcase),
      warnings: parsed.warnings,
    },
  };
}

/** Сколько строк про ячейки показывать в панели: дальше — «и ещё N». */
const MAX_CELL_NOTES = 40;

/**
 * Книга витрин из Google-таблицы (см. parsers/showcase-sheets.ts).
 *
 * В fixtures/ она не кладётся: снимок её не читает, а коммит на каждую
 * заливку перезапускал бы деплой ради данных, которые и так уходят в базу.
 * Поэтому в панели — не «сохранён как», а что именно радар понял из ячеек:
 * каждая ячейка с текстом названа поимённо, чтобы её можно было сверить.
 */
function inspectShowcaseBook(name: string, buffer: Buffer): InspectResult {
  const parsed = parseShowcaseSheets(buffer);
  const edits = showcaseEditsFromCells(parsed.cells);

  if (edits.length === 0) {
    return {
      ok: false,
      originalName: name,
      error:
        'Листы «Витрины 0800» / «Витрины 1600» есть, но заполненных ячеек в них не нашлось.' +
        (parsed.warnings.length ? ` ${parsed.warnings.slice(0, 3).join('; ')}` : ''),
    };
  }

  const count = (slot: ShowcaseSheetCell['slot']) =>
    parsed.cells.filter((c) => c.slot === slot && c.fill != null).length;
  const morning = count('morning');
  const afternoon = count('afternoon');
  const values = (n: number) => `${n} ${plural(n, 'значение', 'значения', 'значений')}`;
  const shops = new Set(edits.map((e) => e.shopCode)).size;

  const texts = parsed.cells.filter((c) => c.text);
  const lines = [
    ...texts.map(
      (c) =>
        `${c.cell} · ${c.shopCode} · ${shortDate(c.date)}: «${c.text}» → ` +
        (c.fill == null ? 'процента нет, только комментарий' : `${Math.round(c.fill * 100)}% и комментарий`),
    ),
    ...parsed.warnings,
  ];

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'showcase',
      fileName: canonicalFixtureName('showcase', parsed.dates, name),
      summary:
        `Витрины из Google-таблицы · ${describeDates(parsed.dates)} · ` +
        `${shops} ${plural(shops, 'лавка', 'лавки', 'лавок')}: ` +
        `на 08:00 — ${values(morning)}, на 16:00 — ${values(afternoon)}`,
      dates: parsed.dates,
      rows: morning + afternoon,
      shops,
      unknownRoles: [],
      showcase: edits,
      notes: [
        'Значения уходят в базу, как правка на вкладке «Витрины»; пустые ячейки ничего не затирают. ' +
          'Сам файл в репозиторий не кладётся.',
        ...(texts.length
          ? [
              `В ${texts.length} ${plural(texts.length, 'ячейке', 'ячейках', 'ячейках')} текст вместо числа — ` +
                'процент взят, только если он однозначен (со знаком «%» или первым словом), текст сохранён комментарием дня:',
            ]
          : []),
        ...lines.slice(0, MAX_CELL_NOTES),
        ...(lines.length > MAX_CELL_NOTES ? [`…и ещё ${lines.length - MAX_CELL_NOTES}`] : []),
      ],
      warnings: parsed.warnings,
    },
  };
}

/**
 * Ячейки листов → правки базы: одна на лавку и день, оба замера вместе.
 * Тексты обоих замеров сливаются в один комментарий дня — он в базе один.
 */
export function showcaseEditsFromCells(cells: readonly ShowcaseSheetCell[]): ShowcaseUploadEdit[] {
  const byKey = new Map<string, ShowcaseUploadEdit & { texts: string[] }>();
  for (const c of cells) {
    const key = `${c.date}|${c.shopCode}`;
    let edit = byKey.get(key);
    if (!edit) byKey.set(key, (edit = { date: c.date, shopCode: c.shopCode, texts: [] }));
    if (c.fill != null) {
      if (c.slot === 'morning') edit.fill = c.fill;
      else edit.afternoonFill = c.fill;
    }
    if (c.text) edit.texts.push(c.slot === 'afternoon' ? `16:00: ${c.text}` : c.text);
  }
  return [...byKey.values()].map(({ texts, ...edit }) => (texts.length ? { ...edit, note: texts.join('; ') } : edit));
}

/**
 * Справочник нормативов лавок (лист «Лавки»): приезд водителя, тайминг
 * поваров, выезд с РЦ.
 *
 * Кладётся в fixtures/ вместе с пересобранным shop-norms.json — так же, как
 * `npm run norms:build`, — и действует со следующей сборки снимка. В панели —
 * не просто «принято», а что именно поменяется по сравнению с действующими
 * нормами: справочник правят руками, и опечатку в часе видно сразу.
 *
 * Правки с вкладки «Пороги» главнее справочника: лавки с ними роут перечислит
 * отдельно (см. normsOverrideNote).
 */
function inspectNorms(name: string, buffer: Buffer): InspectResult {
  const { norms, warnings } = parseShopNorms(buffer);
  if (norms.length === 0) {
    return { ok: false, originalName: name, error: 'Справочник норм опознан, но лавок в нём не нашлось.' };
  }

  const fileName = canonicalFixtureName('norms', [], name);
  const { lines: changes, changed } = normsChanges(readNormsSeed(), norms);
  const count = (pick: (n: ShopNorms) => boolean) => norms.filter(pick).length;
  const shops = (n: number) => `${n} ${plural(n, 'лавка', 'лавки', 'лавок')}`;

  const lines = [
    ...changes,
    ...warnings,
    ...norms.flatMap((n) => n.warnings.map((w) => `${n.code}: ${w}`)),
  ];

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'norms',
      fileName,
      summary:
        `Нормы лавок · ${shops(norms.length)}: приезд водителя у ${count((n) => !!n.driverAt)}, ` +
        `повара у ${count((n) => n.cookAt.length > 0)}, выезд с РЦ у ${count((n) => !!n.departureAt)}`,
      dates: [],
      rows: norms.length,
      shops: norms.length,
      unknownRoles: [],
      showcase: [],
      extraFiles: [{ fileName: 'shop-norms.json', buffer: Buffer.from(normsSeedJson(norms, fileName), 'utf8') }],
      notes: [
        changes.length === 0
          ? 'Нормы совпадают с теми, по которым радар считает сейчас, — ничего не поменяется.'
          : `Поменяется у ${shops(changed)} — действует со следующей сборки снимка:`,
        ...lines.slice(0, MAX_CELL_NOTES),
        ...(lines.length > MAX_CELL_NOTES ? [`…и ещё ${lines.length - MAX_CELL_NOTES}`] : []),
      ],
      warnings,
    },
  };
}

/**
 * «М13: повара 06:30 → 06:20» — по строке на лавку, где норма меняется, и
 * строка про лавки, которых в новом справочнике нет. `changed` — сколько
 * лавок затронуто.
 */
export function normsChanges(
  before: readonly ShopNorms[],
  after: readonly ShopNorms[],
): { lines: string[]; changed: number } {
  const old = new Map(before.map((n) => [n.code, n]));
  const fields: [string, (n: ShopNorms) => string][] = [
    ['водитель', (n) => n.driverAt ?? '—'],
    ['повара', (n) => (n.cookAt.length ? n.cookAt.join(', ') : '—')],
    ['выезд с РЦ', (n) => n.departureAt ?? '—'],
  ];

  const out: string[] = [];
  for (const n of after) {
    const o = old.get(n.code);
    const diff = fields
      .filter(([, get]) => !o || get(o) !== get(n))
      .filter(([, get]) => o || get(n) !== '—')
      .map(([title, get]) => (o ? `${title} ${get(o)} → ${get(n)}` : `${title} ${get(n)}`));
    if (diff.length) out.push(`${n.code}${o ? '' : ' (новая)'}: ${diff.join(', ')}`);
  }
  const gone = before.filter((o) => !after.some((n) => n.code === o.code)).map((o) => o.code);
  const changed = out.length + gone.length;
  if (gone.length) out.push(`Нет в справочнике — нормы снимутся: ${gone.join(', ')}`);
  return { lines: out, changed };
}

function inspectRoster(name: string, buffer: Buffer): InspectResult {
  const parsed = parseRoster(buffer);

  if (parsed.rows.length === 0) {
    return {
      ok: false,
      originalName: name,
      error: 'Лист «Лавки БК» есть, но лавок в нём не нашлось.',
    };
  }
  if (parsed.managers.length === 0) {
    return {
      ok: false,
      originalName: name,
      error: 'В справочнике не нашлось ни одного регионального менеджера — проверьте колонку «Региональный менеджер».',
    };
  }

  const withoutManager = parsed.rows.filter((r) => !r.manager).length;

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'roster',
      fileName: canonicalFixtureName('roster', [], name),
      summary:
        `Справочник лавок · ${parsed.rows.length} ${plural(parsed.rows.length, 'лавка', 'лавки', 'лавок')}, ` +
        `${parsed.managers.length} ${plural(parsed.managers.length, 'региональный менеджер', 'региональных менеджера', 'региональных менеджеров')}: ` +
        parsed.managers.join(', '),
      dates: [],
      rows: parsed.rows.length,
      shops: parsed.rows.length,
      unknownRoles: [],
      showcase: [],
      notes: withoutManager
        ? [
            `${withoutManager} ${plural(withoutManager, 'лавка', 'лавки', 'лавок')} без РМ — ` +
              'у них фильтр по менеджеру будет пустым',
          ]
        : [],
      warnings: parsed.warnings,
    },
  };
}

function inspectDelivery(name: string, buffer: Buffer): InspectResult {
  const parsed = parseDeliveryTimes(buffer);

  if (parsed.rows.length === 0) {
    return {
      ok: false,
      originalName: name,
      error: 'Лист «Время поставки» есть, но времени отгрузки в нём не нашлось.',
    };
  }

  const shops = new Set(parsed.rows.map((r) => r.shopCode)).size;

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'delivery',
      fileName: canonicalFixtureName('delivery', parsed.dates, name),
      summary:
        `Журнал «Время поставки» · ${describeDates(parsed.dates)} · ` +
        `${parsed.rows.length} ${plural(parsed.rows.length, 'отгрузка', 'отгрузки', 'отгрузок')}, ` +
        `${shops} ${plural(shops, 'лавка', 'лавки', 'лавок')}`,
      dates: parsed.dates,
      rows: parsed.rows.length,
      shops,
      unknownRoles: [],
      showcase: [],
      notes: [],
      warnings: parsed.warnings,
    },
  };
}

/**
 * Дни, за которые выгрузка сделана, в отличие от дней, которые в ней просто
 * упомянуты. Отсечка по доле строк: за настоящий день их сотни, за «хвост»
 * ночной смены — единицы.
 */
function mainDates(dates: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(d, (counts.get(d) ?? 0) + 1);
  if (counts.size === 0) return [];

  const max = Math.max(...counts.values());
  return [...counts]
    .filter(([, n]) => n >= max * 0.1)
    .map(([d]) => d)
    .sort();
}

function describeDates(dates: readonly string[]): string {
  const sorted = [...dates].sort();
  if (sorted.length === 0) return 'дат нет';
  if (sorted.length === 1) return shortDate(sorted[0]);
  return (
    `${shortDate(sorted[0])} — ${shortDate(sorted[sorted.length - 1])} ` +
    `(${sorted.length} ${plural(sorted.length, 'день', 'дня', 'дней')})`
  );
}
