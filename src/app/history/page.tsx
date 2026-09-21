import fs from 'node:fs';
import path from 'node:path';
import { readUploadLog, type UploadLogEntry } from '@/lib/upload-log';
import { fixturesDir } from '@/lib/upload-store';
import { readShowcase } from '@/lib/showcase-store';
import {
  formatAuditValue,
  readShowcaseAudit,
  showcaseAuditCount,
  SOURCE_TITLE,
  type ShowcaseAuditEntry,
} from '@/lib/showcase-audit';
import { regionTransitions } from '@/lib/queries';
import { normalizeCode } from '@/lib/shops';
import { formatMoment, shortDate } from '@/lib/time';
import { plural } from '@/lib/plural';

export const dynamic = 'force-dynamic';

const KIND_TITLE: Record<string, string> = {
  attendance: 'Выгрузка отметок',
  legacy: 'Книга «Витрины»',
  delivery: 'Журнал отгрузок',
  roster: 'Справочник лавок',
};

/**
 * История: что и когда попало в радар.
 *
 * Ответы на вопрос «откуда взялись эти цифры»: журнал загрузок с временем,
 * текущее состояние папки выгрузок, журнал правок витрин «было → стало» и
 * когда последний раз правили витрины.
 */
export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Фильтр журнала живёт в ссылке: «посмотри, меняли ли М22 за 21.09» должно
  // передаваться ссылкой, а не пересказом, куда что ввести.
  const shopFilter = typeof sp.shop === 'string' ? sp.shop.trim().slice(0, 8) : '';
  const dateFilter = typeof sp.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sp.date)
    ? sp.date
    : '';

  const log = await readUploadLog();
  const files = readFixtureFiles();
  const showcase = await readShowcase();
  const transitions = await regionTransitions();
  const audit = await readShowcaseAudit({
    shopCode: shopFilter || undefined,
    date: dateFilter || undefined,
  });
  // Пустая лента под фильтром и пустой журнал вообще — разные ответы:
  // первое значит «не меняли», второе — «спросить не у кого».
  const auditTotal = await showcaseAuditCount();

  const showcaseDays = Object.entries(showcase.touched)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, 12);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">История</h1>
        <p className="mt-1 text-sm muted">
          Что загружали в радар и когда. Журнал ведётся автоматически при каждой загрузке.
        </p>
      </div>

      <section className="surface p-4">
        <h2 className="text-sm font-semibold">Загрузки</h2>
        {log.length === 0 ? (
          <p className="mt-3 text-sm muted">
            Журнал пуст: он начинает заполняться с первой загрузки через кнопку «Загрузить
            выгрузки». Файлы, попавшие в радар раньше, видно ниже — по папке выгрузок.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {log.map((e, i) => (
              <li
                key={`${e.at}-${e.fileName}-${i}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t py-2.5 first:border-0"
                style={{ borderColor: 'var(--border)' }}
              >
                <span className="w-36 shrink-0 text-xs tabular-nums muted">{stamp(e.at)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <b>{KIND_TITLE[e.kind] ?? e.kind}</b>
                    {e.dates.length > 0 && (
                      <span className="ml-2 tabular-nums">{describeDates(e.dates)}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs muted">{e.summary}</p>
                  <p className="mt-0.5 text-xs muted">
                    {e.originalName} → {e.fileName}
                    {e.mode === 'github' && ' · коммитом в репозиторий'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="surface p-4">
          <h2 className="text-sm font-semibold">Файлы, из которых сейчас считается радар</h2>
          <p className="mt-0.5 text-xs muted">
            Папка выгрузок, {files.length} {plural(files.length, 'файл', 'файла', 'файлов')}.
          </p>
          {/*
            Время у всех файлов сплошь и рядом одинаковое — это отметка не о
            загрузке, а о последней записи на диск: при выкладке сайта файлы
            переписываются разом. Без этой оговорки таблица читается как «всё
            загрузили в одну минуту», и на неё начинают ссылаться как на
            журнал загрузок, хотя журнал — блок выше.
          */}
          <p className="mt-1 text-xs muted">
            Время — когда файл последний раз записан на диск, а не когда его загрузили:
            при выкладке сайта все файлы переписываются разом. Кто и когда загружал —
            в «Загрузках» выше.
          </p>
          {files.length === 0 ? (
            <p className="mt-3 text-sm muted">
              Папка выгрузок пуста — радар считается по закоммиченному снимку.
            </p>
          ) : (
            <FileList files={files} />
          )}
        </section>

        <section className="surface p-4">
          <h2 className="text-sm font-semibold">Правки наполнения витрин</h2>
          <p className="mt-0.5 text-xs muted">
            Витрины заполняются на вкладке «Витрины», а не файлом. Здесь — когда какой день трогали
            последний раз; что именно в нём меняли — в журнале правок ниже.
          </p>
          {showcaseDays.length === 0 ? (
            <p className="mt-3 text-sm muted">Пока ни один день не правили на сайте.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <tbody>
                {showcaseDays.map(([date, at]) => (
                  <tr key={date} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1.5 tabular-nums">{shortDate(date)}</td>
                    <td className="py-1.5 text-xs muted">
                      {countShops(showcase.days[date])}
                    </td>
                    <td className="py-1.5 text-right text-xs tabular-nums muted">{stamp(at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="surface p-4">
        <h2 className="text-sm font-semibold">Журнал правок витрин</h2>
        <p className="mt-0.5 text-xs muted">
          Каждое изменение наполнения и комментария: что было, что стало и откуда пришла правка.
          Сводка выше говорит только «день трогали в 13:40», а здесь видно, что именно поменялось.
        </p>
        {/*
          Автора в журнале нет намеренно: вход на «Витрины» — один общий пароль
          на команду, отдельных пользователей в радаре не заведено (см. auth.ts).
          Приписать правке выдуманного автора хуже, чем честно его не показывать,
          поэтому пишется только источник: страница или залитая книга.
        */}
        <p className="mt-0.5 text-xs muted">
          Кто именно правил, радар не знает: вход общий, отдельных пользователей нет.
        </p>

        <AuditFilter shop={shopFilter} date={dateFilter} />

        {auditTotal === 0 ? (
          <p className="mt-3 text-sm muted">
            Журнал пуст: он начинает заполняться с первой правки после обновления. Что правили
            раньше, в нём не отражено — прежние значения нигде не сохранялись.
          </p>
        ) : audit.length === 0 ? (
          <p className="mt-3 text-sm">
            Под этот отбор правок нет — значит, {describeFilter(shopFilter, dateFilter)} не меняли.
            Проверьте, что цвет не изменился по другой причине: пороги критерия правятся
            в <code>config/thresholds.json</code>, а пустая ячейка и зелёная — разные вещи.
          </p>
        ) : (
          <AuditTable entries={audit} />
        )}
      </section>

      <section className="surface p-4">
        <h2 className="text-sm font-semibold">Смены РМ</h2>
        <p className="mt-0.5 text-xs muted">
          Ушедший РМ из радара не пропадает: дни, где он реально отвечал за лавку, остаются под его
          именем — фильтр «РМ» в радаре и на дашборде находит и прежних менеджеров.
        </p>
        {transitions.length === 0 ? (
          <p className="mt-3 text-sm muted">Смен РМ пока не было.</p>
        ) : (
          /* Список прокручивается внутри себя, поэтому заголовок обязан
             липнуть: иначе к середине не понять, где «было», а где «стало» —
             а перепутать их значит перепутать, кого спрашивать за день. */
          <div
            className="mt-3 max-h-96 overflow-y-auto"
            style={{ overscrollBehavior: 'contain' }}
          >
            <table className="norms-table w-full text-sm">
              <thead>
                <tr className="text-xs muted">
                  <th className="pb-1.5 text-left font-medium">Лавка</th>
                  <th className="pb-1.5 text-left font-medium">Было</th>
                  <th className="pb-1.5 text-left font-medium">Стало</th>
                  <th className="pb-1.5 text-right font-medium">С какого числа</th>
                </tr>
              </thead>
              <tbody>
                {transitions.map((t) => (
                  <tr
                    key={`${t.shopCode}-${t.since}`}
                    className="border-t"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <td className="py-1.5 pr-3 whitespace-nowrap">{t.shopName}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap muted">{t.from}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{t.to}</td>
                    <td className="py-1.5 text-right text-xs tabular-nums muted">
                      {shortDate(t.since)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const FIELD_STYLE = {
  borderColor: 'var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
} as const;

/**
 * Отбор по лавке и дню обычной формой: страница серверная, и GET-форма
 * работает без скриптов, с клавиатуры и ссылкой, которую можно переслать.
 */
function AuditFilter({ shop, date }: { shop: string; date: string }) {
  return (
    <form method="get" className="mt-3 flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs muted">
        Лавка
        <input
          name="shop"
          defaultValue={shop}
          placeholder="М22"
          className="rounded-lg border px-3 py-2 text-sm"
          style={{ ...FIELD_STYLE, width: '7rem' }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs muted">
        День витрины
        <input
          type="date"
          name="date"
          defaultValue={date}
          className="rounded-lg border px-3 py-2 text-sm"
          style={FIELD_STYLE}
        />
      </label>
      <button type="submit" className="rounded-lg border px-3 py-2 text-sm" style={FIELD_STYLE}>
        Показать
      </button>
      {(shop || date) && (
        <a href="/history" className="px-1 py-2 text-sm underline muted">
          сбросить
        </a>
      )}
    </form>
  );
}

const FIELD_TITLE: Record<ShowcaseAuditEntry['field'], string> = {
  fill: 'Наполнение',
  note: 'Комментарий',
};

/** Свежие правки сверху; остальные — под раскрытием, как и файлы выгрузок. */
const AUDIT_SHOWN = 15;

function AuditTable({ entries }: { entries: ShowcaseAuditEntry[] }) {
  const head = entries.slice(0, AUDIT_SHOWN);
  const rest = entries.slice(AUDIT_SHOWN);

  return (
    <>
      <AuditRows entries={head} />
      {rest.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs muted">
            Ещё {rest.length} {plural(rest.length, 'правка', 'правки', 'правок')} постарше
          </summary>
          <AuditRows entries={rest} />
        </details>
      )}
    </>
  );
}

function AuditRows({ entries }: { entries: ShowcaseAuditEntry[] }) {
  return (
    <div className="radar-scroll">
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-xs muted">
            <th className="pb-1.5 pr-3 text-left font-medium">Когда правили</th>
            <th className="pb-1.5 pr-3 text-left font-medium">День</th>
            <th className="pb-1.5 pr-3 text-left font-medium">Лавка</th>
            <th className="pb-1.5 pr-3 text-left font-medium">Что</th>
            <th className="pb-1.5 pr-3 text-left font-medium">Было</th>
            <th className="pb-1.5 pr-3 text-left font-medium">Стало</th>
            <th className="pb-1.5 text-right font-medium">Откуда</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr
              key={`${e.at}-${e.date}-${e.shopCode}-${e.field}-${i}`}
              className="border-t"
              style={{ borderColor: 'var(--border)' }}
            >
              <td className="py-1.5 pr-3 text-xs tabular-nums whitespace-nowrap muted">
                {stamp(e.at)}
              </td>
              <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{shortDate(e.date)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{e.shopCode}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap muted">{FIELD_TITLE[e.field]}</td>
              <td className="py-1.5 pr-3 muted">{formatAuditValue(e.field, e.from)}</td>
              <td className="py-1.5 pr-3">{formatAuditValue(e.field, e.to)}</td>
              <td className="py-1.5 text-right text-xs whitespace-nowrap muted">
                {SOURCE_TITLE[e.source]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * «М22 за 21.09» — так пустой отбор читается как ответ, а не как сбой. Код
 * показываем нормализованным: искали-то по нему, и «M70» латиницей в ответе
 * заставило бы гадать, не в раскладке ли дело.
 */
function describeFilter(shop: string, date: string): string {
  const parts = [shop && normalizeCode(shop), date && `за ${shortDate(date)}`].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'витрины';
}

interface FixtureFile {
  name: string;
  size: number;
  mtime: string;
}

/**
 * Список файлов выгрузок.
 *
 * Файлов прибавляется по паре в день и они не удаляются: через полгода их
 * триста, и «Правки витрин» справа оказываются напротив пустоты, а сама
 * страница — длиной в экран прокрутки. Показываем свежие, остальные — под
 * раскрытием: <details> работает без скриптов и с клавиатуры.
 */
const FILES_SHOWN = 12;

function FileList({ files }: { files: FixtureFile[] }) {
  const head = files.slice(0, FILES_SHOWN);
  const rest = files.slice(FILES_SHOWN);

  return (
    <>
      <FileTable files={head} />
      {rest.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs muted">
            Ещё {rest.length} {plural(rest.length, 'файл', 'файла', 'файлов')} постарше
          </summary>
          <FileTable files={rest} />
        </details>
      )}
    </>
  );
}

function FileTable({ files }: { files: FixtureFile[] }) {
  return (
    <table className="mt-3 w-full text-sm">
      {/* Раньше подписей не было вовсе: три колонки, и что за число «154» и
          что за дата рядом — приходилось угадывать. */}
      <thead>
        <tr className="text-xs muted">
          <th className="pb-1.5 pr-3 text-left font-medium">Файл</th>
          <th className="pb-1.5 pr-3 text-right font-medium">Размер</th>
          <th className="pb-1.5 text-right font-medium">Записан</th>
        </tr>
      </thead>
      <tbody>
        {files.map((f) => (
          <tr key={f.name} className="border-t" style={{ borderColor: 'var(--border)' }}>
            <td className="py-1.5 pr-3 break-all">{f.name}</td>
            <td className="py-1.5 pr-3 text-right text-xs tabular-nums muted">{f.size} КБ</td>
            <td className="py-1.5 text-right text-xs tabular-nums muted">{stamp(f.mtime)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function readFixtureFiles(): FixtureFile[] {
  try {
    const dir = fixturesDir();
    return fs
      .readdirSync(/* turbopackIgnore: true */ dir)
      .filter((n) => !n.startsWith('.'))
      .map((name) => {
        const s = fs.statSync(/* turbopackIgnore: true */ path.join(dir, name));
        return { name, size: Math.round(s.size / 1024), mtime: new Date(s.mtimeMs).toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

function countShops(day: Record<string, number> | undefined): string {
  const n = Object.keys(day ?? {}).length;
  return `${n} ${plural(n, 'лавка', 'лавки', 'лавок')}`;
}

function describeDates(dates: readonly string[]): string {
  const sorted = [...dates].sort();
  if (sorted.length === 1) return `за ${shortDate(sorted[0])}`;
  return `за ${shortDate(sorted[0])} — ${shortDate(sorted[sorted.length - 1])}`;
}

/** Когда загрузили — по Москве: сервер живёт в UTC, а человек — нет. */
function stamp(iso: string): string {
  return `${formatMoment(iso)} МСК`;
}
