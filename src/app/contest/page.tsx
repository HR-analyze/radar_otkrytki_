import { cookies } from 'next/headers';
import { COOKIE, isUnlocked } from '@/lib/auth';
import { openManualDb } from '@/lib/manual-db';
import { readContestViolations } from '@/lib/contest-violations-store';
import { ContestViolations } from '@/components/ContestViolations';
import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { contest, listRegions, listShops } from '@/lib/queries';
import { CONTEST_START, averagePoints, formatPoints } from '@/lib/contest';
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
  // Конкурс идёт с 14.09.2026: дни до старта не показываем и не считаем.
  const p = await resolveParams(sp, { minDate: CONTEST_START });
  const config = loadConfig();
  const [regions, shops] = await Promise.all([listRegions(p.from, p.to), listShops()]);

  const { dates, rows, regions: regionRows, total, violations } = await contest({
    from: p.from,
    to: p.to,
    region: p.region,
    shop: p.shop,
  });

  // В фильтре остаётся и РМ с закреплённым штрафом после передачи лавки.
  const allViolations = await readContestViolations();
  for (const v of allViolations) {
    if (!regions.current.includes(v.region) && !regions.past.includes(v.region)) regions.past.push(v.region);
  }
  const unlocked = await isUnlocked((await cookies()).get(COOKIE)?.value);
  const editable = Boolean(await openManualDb());
  const avg = averagePoints(total);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
        <h1 className="text-2xl font-semibold tracking-tight">Конкурс по витринам</h1>
        <p className="mt-1 text-sm muted">
          Балл за витрину: 🟢 +1 · 🟡 0 · 🔴 −1. Каждое нарушение: −1 к итогу.
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

      {rows.length === 0 ? (
        <div className="surface p-8 text-center text-sm muted">
          {p.shop
            ? `По запросу «${p.shop}» витрин за период не нашлось. Попробуйте код (М17) или часть названия.`
            : /* Расширять период вниз некуда: до старта конкурса дней нет — и
                 совет «расширь период» сбивал бы с толку именно в первые дни. */
              p.dates.length === 0
              ? `Конкурс идёт с ${shortDate(CONTEST_START)}. Данных за конкурсные дни ещё нет — дождись ближайшей выгрузки.`
              : 'За выбранный период витрины не заполняли. Возьми другой период или сними фильтр по РМ.'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Tile
              title="Баллов у сети"
              value={formatPoints(total.points)}
              /* Без подписи: «за N оценённых дней» под суммой читалось как
                 «баллы за день» и путало — само число есть в подсказке. */
              explain="Баллы за витрины выбранного периода минус закреплённые нарушения. За каждое нарушение вычитается один балл, независимо от числа дней."
            />
            <Tile
              title="Средний балл за день"
              value={avg == null ? '—' : formatPoints(avg)}
              /* Не «÷ дни»: знаменатель — лавко-дни, сумма по всем лавкам.
                 Одиннадцать лавок за два дня дают 22, а не 2. */
              hint="сумма баллов ÷ оценённые лавко-дни"
              explain="Сравнивать сети и РМ между собой можно только по этой цифре: сумма баллов у того, кто ведёт двенадцать лавок, больше просто потому, что лавок больше."
            />
            <Tile
              title="Лавок в конкурсе"
              value={String(rows.length)}
              hint={`дней в таблице: ${dates.length}`}
              explain="Лавки с заполненными витринами или закреплёнными нарушениями, попавшие под фильтры."
            />
          </div>

          {/* Обозначения те же, что на радаре, но балл — своё правило, и
              его стоит держать перед глазами рядом с таблицей. */}
          <StatusLegend note="Балл за день: 🟢 +1 · 🟡 0 · 🔴 −1. Нарушение: −1 к итогу. Клик по ячейке — карточка лавки за этот день." />

          {/* --- Лавки --- */}
          <ContestTable rows={rows} dates={dates} from={p.from} to={p.to} />

          {/* --- РМ --- */}
          <section className="surface p-4">
            <h2 className="text-sm font-semibold">Статистика по РМ</h2>
            <p className="mt-0.5 text-xs muted">
              День лавки идёт тому РМ, который вёл её в этот день. Сортировка — по среднему баллу:
              сумма у РМ с двенадцатью лавками больше просто потому, что лавок больше. Закреплённые нарушения вычтены из баллов.
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
                          <Hint text="Сумма баллов ÷ оценённые лавко-дни: средний балл одной лавки за один день. Именно по нему таблица и отсортирована — сумма у РМ с двенадцатью лавками больше просто потому, что лавок больше. Закреплённые нарушения вычтены из баллов." />
                        </span>
                      </th>
                      <th className="px-2 py-2 text-right text-xs font-medium muted">Нарушения</th>
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
                          <td className="px-2 py-1.5 text-right text-xs tabular-nums" title="Каждое нарушение вычитает 1 балл из итога">
                            {r.score.violations}{r.score.violations > 0 && ` (${formatPoints(-r.score.violations)})`}
                          </td>
                          <td
                            className="px-2 py-1.5 text-right text-sm font-semibold tabular-nums"
                            title={`${r.score.rated} ${plural(r.score.rated, 'оценённый лавко-день', 'оценённых лавко-дня', 'оценённых лавко-дней')}`}
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
      <ContestViolations violations={violations} shops={shops} editable={editable}
        unlocked={unlocked} tokenRequired={Boolean(process.env.RADAR_UPLOAD_TOKEN)}
        returnTo={`/contest?${reportQuery(p)}`} />
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
  /** Подпись под цифрой. Не передана — плитка обходится без неё. */
  hint?: string;
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
      {hint && <div className="mt-0.5 text-xs muted">{hint}</div>}
    </div>
  );
}
