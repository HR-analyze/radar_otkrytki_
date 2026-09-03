import fs from 'node:fs';
import path from 'node:path';
import { readUploadLog, type UploadLogEntry } from '@/lib/upload-log';
import { fixturesDir } from '@/lib/upload-store';
import { readShowcase } from '@/lib/showcase-store';
import { regionTransitions } from '@/lib/queries';
import { shortDate } from '@/lib/time';
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
 * Три ответа на вопрос «откуда взялись эти цифры»: журнал загрузок с временем,
 * текущее состояние папки выгрузок и когда последний раз правили витрины.
 */
export default async function HistoryPage() {
  const log = await readUploadLog();
  const files = readFixtureFiles();
  const showcase = await readShowcase();
  const transitions = await regionTransitions();

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
            Папка выгрузок, {files.length} {plural(files.length, 'файл', 'файла', 'файлов')}. Время —
            когда файл последний раз менялся.
          </p>
          <table className="mt-3 w-full text-sm">
            <tbody>
              {files.map((f) => (
                <tr key={f.name} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-1.5 pr-3">{f.name}</td>
                  <td className="py-1.5 pr-3 text-right text-xs tabular-nums muted">{f.size} КБ</td>
                  <td className="py-1.5 text-right text-xs tabular-nums muted">{stamp(f.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="surface p-4">
          <h2 className="text-sm font-semibold">Правки наполнения витрин</h2>
          <p className="mt-0.5 text-xs muted">
            Витрины заполняются на вкладке «Витрины», а не файлом. Здесь — когда какой день трогали
            последний раз.
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
        <h2 className="text-sm font-semibold">Смены РМ</h2>
        <p className="mt-0.5 text-xs muted">
          Ушедший РМ из радара не пропадает: дни, где он реально отвечал за лавку, остаются под его
          именем — фильтр «РМ» в радаре и на дашборде находит и прежних менеджеров.
        </p>
        {transitions.length === 0 ? (
          <p className="mt-3 text-sm muted">Смен РМ пока не было.</p>
        ) : (
          <div className="mt-3 max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
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

function readFixtureFiles(): { name: string; size: number; mtime: string }[] {
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

function stamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
