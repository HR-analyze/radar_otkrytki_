import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { contest, listRegions, listShops } from '@/lib/queries';
import { averagePoints, formatPoints, type ContestScore } from '@/lib/contest';
import { shortDate } from '@/lib/time';
import { Filters } from '@/components/Filters';
import { plural } from '@/lib/plural';
import { StatusCell, StatusLegend, STATUS_TEXT } from '@/components/Status';

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
            />
            <Tile
              title="Средний балл за день"
              value={avg == null ? '—' : formatPoints(avg)}
              hint="сумма баллов ÷ оценённые дни"
            />
            <Tile
              title="Лавок в конкурсе"
              value={String(rows.length)}
              hint={`дней в таблице: ${dates.length}`}
            />
          </div>

          {/* Обозначения те же, что на радаре, но балл — своё правило, и
              его стоит держать перед глазами рядом с таблицей. */}
          <StatusLegend note="Балл за день: 🟢 +1 · 🟡 0 · 🔴 −1. Клик по ячейке — карточка лавки за этот день." />

          {/* --- Лавки --- */}
          <div className="surface radar-scroll">
            <table className="radar-table w-full text-sm">
              <thead>
                <tr>
                  <th className="radar-sticky px-3 py-2 text-left text-xs font-medium muted">Лавка</th>
                  <th className="hidden px-2 py-2 text-left text-xs font-medium muted sm:table-cell">РМ</th>
                  {dates.map((d) => (
                    <th key={d} className="px-0.5 py-2 text-center text-xs font-medium muted">
                      {shortDate(d)}
                    </th>
                  ))}
                  <th className="hidden px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted md:table-cell">
                    🔴 / 🟡 / 🟢
                  </th>
                  <th
                    className="hidden px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted md:table-cell"
                    title="Средняя наполненность витрины за оценённые дни"
                  >
                    Витрина
                  </th>
                  <th
                    className="hidden px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted md:table-cell"
                    title="Сумма баллов за период: 🟢 +1 · 🟡 0 · 🔴 −1"
                  >
                    Баллы
                  </th>
                  <th className="w-full" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.shop.code}>
                    <td className="radar-sticky px-3 py-1 whitespace-nowrap">
                      <Link
                        href={`/shop/${encodeURIComponent(r.shop.code)}?from=${p.from}&to=${p.to}`}
                        className="hover:underline"
                        title={r.shop.region ? `${r.shop.name} · РМ ${r.shop.region}` : r.shop.name}
                      >
                        {r.shop.name}
                      </Link>
                      {/* На телефоне колонка «Баллы» уезжает за правый край, а
                          ради неё вкладку и открывают — дублируем у названия. */}
                      <span
                        className="ml-2 text-xs font-semibold tabular-nums md:hidden"
                        style={{ color: pointsColor(r.score.points) }}
                      >
                        {formatPoints(r.score.points)}
                      </span>
                    </td>
                    <td className="hidden px-2 py-1 text-xs whitespace-nowrap muted sm:table-cell">
                      {r.shop.region ?? '—'}
                    </td>
                    {dates.map((d) => {
                      const cell = r.cells[d];
                      if (!cell) return <td key={d} className="px-0.5 py-0.5" />;
                      return (
                        <StatusCell
                          key={d}
                          status={cell.status}
                          href={`/shop/${encodeURIComponent(r.shop.code)}?from=${d}&to=${d}`}
                          title={`${r.shop.name} · ${shortDate(d)} · ${STATUS_TEXT[cell.status]} · витрина ${Math.round(cell.fill * 100)}% · ${formatPoints(cell.points)}`}
                        />
                      );
                    })}
                    <Counts score={r.score} />
                    <td className="hidden px-2 py-1 text-right text-xs whitespace-nowrap tabular-nums muted md:table-cell">
                      {r.avgFill == null ? '—' : `${Math.round(r.avgFill * 100)}%`}
                    </td>
                    <Points score={r.score} />
                    <td aria-hidden />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
                      <th
                        className="px-2 py-2 text-right text-xs font-medium muted"
                        title="Сумма баллов ÷ оценённые дни"
                      >
                        Ср. балл
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

/** Разбивка дней по цветам — статистика лавки рядом с её строкой. */
function Counts({ score }: { score: ContestScore }) {
  return (
    <td
      className="hidden px-2 py-1 text-right text-xs whitespace-nowrap tabular-nums muted md:table-cell"
      title={`${score.rated} ${plural(score.rated, 'оценённый день', 'оценённых дня', 'оценённых дней')} за период`}
    >
      {score.red} / {score.yellow} / {score.green}
    </td>
  );
}

/**
 * Баллы со знаком и знаменателем: «+3» из скольких дней — без этого «0» у
 * лавки с двумя днями и у лавки с двадцатью выглядят одинаково.
 */
function Points({ score }: { score: ContestScore }) {
  return (
    <td
      className="hidden px-2 py-1 text-right text-sm font-semibold whitespace-nowrap tabular-nums md:table-cell"
      title={`🟢 ${score.green} · 🟡 ${score.yellow} · 🔴 ${score.red} → ${formatPoints(score.points)} за ${score.rated} ${plural(score.rated, 'день', 'дня', 'дней')}`}
      style={{ color: pointsColor(score.points) }}
    >
      {formatPoints(score.points)}
    </td>
  );
}

/** Плюс — зелёным, минус — красным: знак читается раньше цифры. */
function pointsColor(points: number): string | undefined {
  if (points > 0) return 'var(--green-ink)';
  if (points < 0) return 'var(--red-ink)';
  return undefined;
}

function Tile({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <div className="surface p-3">
      <div className="text-xs muted">{title}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs muted">{hint}</div>
    </div>
  );
}
