import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { contest, listRegions, listShops } from '@/lib/queries';
import { averagePoints, formatPoints } from '@/lib/contest';
import { shortDate } from '@/lib/time';
import { Filters } from '@/components/Filters';
import { plural } from '@/lib/plural';
import { StatusLegend } from '@/components/Status';
import { ContestTable } from '@/components/ContestTable';
import { Hint } from '@/components/Hint';

export const dynamic = 'force-dynamic';

/**
 * Конкурс по наполнению витрин.
 *
 * Устроен как радар по лавкам, но нарочно проще: единственный критерий —
 * витрина, поэтому фильтров по критерию и статусу здесь нет, а в итоге стоят
 * баллы (🟢 +1, 🟡 0, 🔴 −1), а не число красных. Правило — в contest.ts.
 *
 * Почему баллы, а не красные: в конкурсе зелёный день компенсирует красный.
 * Лавка с тремя жёлтыми, одной красной и одной зелёной набирает 0 — по радару
 * у неё «1 из 5», и это про другое.
 */
export default async function ContestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = await resolveParams(sp);
  const config = loadConfig();
  const [regions, shops] = await Promise.all([listRegions(p.from, p.to), listShops()]);

  const { dates, rows, regions: regionRows, total } = await contest({
    from: p.from,
    to: p.to,
    region: p.region,
    shop: p.shop,
  });

  const avg = averagePoints(total);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
        <h1 className="text-2xl font-semibold tracking-tight">Конкурс по витринам</h1>
        <p className="mt-1 text-sm muted">
          Только наполнение витрины. Балл за день: 🟢 +1 · 🟡 0 · 🔴 −1
          {rows.length > 0 && (
            <>
              {' · '}
              {rows.length} {plural(rows.length, 'лавка', 'лавки', 'лавок')} ·{' '}
              {shortDate(p.from)} — {shortDate(p.to)}
              {p.region && ` · РМ ${p.region}`}
              {p.shop && ` · поиск «${p.shop}»`}
            </>
          )}
        </p>
        </div>
        {rows.length > 0 && (
          /* Обычная ссылка, а не кнопка с JS: PDF собирается на сервере, и
             файл должен скачиваться даже если скрипты не загрузились. */
          <a
            href={`/api/contest/report?${reportQuery(p)}`}
            className="rounded-lg border px-3 py-2 text-sm font-medium whitespace-nowrap hover:opacity-90"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            title="Отчёт за выбранный период с теми же фильтрами"
          >
            ⬇ Скачать PDF
          </a>
        )}
      </div>

      <Filters
        base="/contest"
        state={p}
        regions={regions}
        dates={p.dates}
        config={config}
        shops={shops.map((s) => ({ code: s.code, name: s.name }))}
        showCriterion={false}
        showStatus={false}
      />

      {dates.length === 0 || rows.length === 0 ? (
        <div className="surface p-8 text-center text-sm muted">
          {p.shop
            ? `По запросу «${p.shop}» витрин за период не нашлось. Попробуйте код (М17) или часть названия.`
            : 'За выбранный период витрины не заполняли. Расширь период или сними фильтр по РМ.'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Tile
              title="Баллов у сети"
              value={formatPoints(total.points)}
              hint={`за ${total.rated} ${plural(total.rated, 'оценённый день', 'оценённых дня', 'оценённых дней')}`}
              explain="Сумма баллов всех лавок за все дни периода: зелёный день даёт +1, жёлтый 0, красный −1. Дни без заполненной витрины не считаются вовсе."
            />
            <Tile
              title="Средний балл за день"
              value={avg == null ? '—' : formatPoints(avg)}
              hint="сумма баллов ÷ оценённые дни"
              explain="Сравнивать сети и РМ между собой можно только по этой цифре: сумма баллов у того, кто ведёт двенадцать лавок, больше просто потому, что лавок больше."
            />
            <Tile
              title="Лавок в конкурсе"
              value={String(rows.length)}
              hint={`дней в таблице: ${dates.length}`}
              explain="Лавки, попавшие под фильтры. Те, у кого за период нет ни одного дня с заполненной витриной, в сортировках всегда уходят вниз: ноль баллов у них означает «не участвовала», а не «сыграла вничью»."
            />
          </div>

          {/* Обозначения те же, что на радаре, но балл — своё правило, и
              его стоит держать перед глазами рядом с таблицей. */}
          <StatusLegend note="Балл за день: 🟢 +1 · 🟡 0 · 🔴 −1. Клик по ячейке — карточка лавки за этот день." />

          {/* --- Лавки --- */}
          <ContestTable rows={rows} dates={dates} from={p.from} to={p.to} />

          {/* --- РМ --- */}
          <section className="surface p-4">
            <h2 className="text-sm font-semibold">Статистика по РМ</h2>
            <p className="mt-0.5 text-xs muted">
              День лавки идёт тому РМ, который вёл её в этот день. Сортировка — по среднему баллу:
              сумма у РМ с двенадцатью лавками больше просто потому, что лавок больше.
            </p>
            {regionRows.length === 0 ? (
              <p className="mt-4 text-sm muted">За период РМ не определились — справочник пуст.</p>
            ) : (
              <div className="radar-scroll mt-3">
                <table className="radar-table w-full text-sm">
                  <thead>
                    <tr>
                      <th className="px-2 py-2 text-left text-xs font-medium muted">РМ</th>
                      <th className="px-2 py-2 text-right text-xs font-medium muted">Лавок</th>
                      <th className="px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted">
                        🔴 / 🟡 / 🟢
                      </th>
                      <th className="hidden px-2 py-2 text-right text-xs font-medium muted sm:table-cell">
                        Витрина
                      </th>
                      <th className="px-2 py-2 text-right text-xs font-medium muted">
                        <span className="inline-flex items-center gap-1">
                          Ср. балл
                          <Hint text="Сумма баллов ÷ оценённые дни. Именно по нему таблица и отсортирована: сумма у РМ с двенадцатью лавками больше просто потому, что лавок больше." />
                        </span>
                      </th>
                      <th className="px-2 py-2 text-right text-xs font-medium muted">Баллы</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regionRows.map((r) => {
                      const mean = averagePoints(r.score);
                      return (
                        <tr key={r.region}>
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            <Link
                              href={`/contest?from=${p.from}&to=${p.to}&region=${encodeURIComponent(r.region)}`}
                              className="hover:underline"
                            >
                              {r.region}
                            </Link>
                          </td>
                          <td className="px-2 py-1.5 text-right text-xs tabular-nums muted">{r.shops}</td>
                          <td className="px-2 py-1.5 text-right text-xs whitespace-nowrap tabular-nums muted">
                            {r.score.red} / {r.score.yellow} / {r.score.green}
                          </td>
                          <td className="hidden px-2 py-1.5 text-right text-xs tabular-nums muted sm:table-cell">
                            {r.avgFill == null ? '—' : `${Math.round(r.avgFill * 100)}%`}
                          </td>
                          <td className="px-2 py-1.5 text-right text-xs font-medium tabular-nums">
                            {mean == null ? '—' : formatPoints(mean)}
                          </td>
                          <td
                            className="px-2 py-1.5 text-right text-sm font-semibold tabular-nums"
                            title={`${r.score.rated} ${plural(r.score.rated, 'оценённый день', 'оценённых дня', 'оценённых дней')}`}
                          >
                            {formatPoints(r.score.points)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Те же фильтры, что на экране, — иначе PDF показал бы другой период. */
function reportQuery(p: { from: string; to: string; region?: string; shop?: string }): string {
  const q = new URLSearchParams({ from: p.from, to: p.to });
  if (p.region) q.set('region', p.region);
  if (p.shop) q.set('shop', p.shop);
  return q.toString();
}

function Tile({
  title,
  value,
  hint,
  explain,
}: {
  title: string;
  value: string;
  hint: string;
  /** Как получилась цифра — если из подписи это не очевидно. */
  explain?: string;
}) {
  return (
    <div className="surface p-3">
      <div className="flex items-center gap-1.5 text-xs muted">
        <span>{title}</span>
        {explain && <Hint text={explain} />}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs muted">{hint}</div>
    </div>
  );
}
