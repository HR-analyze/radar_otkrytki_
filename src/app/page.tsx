import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import {
  antiTop,
  bestShops,
  departureSummary,
  lastRun,
  listRegions,
  listShops,
  shopTotals,
  showcaseStats,
  summaryByCriterion,
  weakestCriteria,
  type SummaryFilters,
} from '@/lib/queries';
import { isWritable } from '@/lib/snapshot';
import { formatMoment, shortDate } from '@/lib/time';
import { Filters } from '@/components/Filters';
import { DepartureBlock } from '@/components/DepartureBlock';
import { StatusBadge, StatusBar, STATUS_FILTER_TITLE } from '@/components/Status';
import { RefreshButton } from '@/components/RefreshButton';
import { CRITERION_ORDER, DEFAULT_CRITERION, type CriterionKey } from '@/lib/types';
import { plural } from '@/lib/plural';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  /**
   * Сводка открывается на критерии по умолчанию, а не на агрегате по всем
   * критериям: пункт «Все» убран из фильтра 10.09.2026 — см. Filters.
   * Плитки, топ и анти-топ считаются по выбранному критерию.
   */
  const p = await resolveParams(sp, { criterion: DEFAULT_CRITERION });
  const config = loadConfig();
  const singleDay = p.from === p.to;

  /**
   * Один объект фильтров на все виджеты сводки: пять полей шапки — те же, что
   * на радаре. Раньше сюда доезжали только период и РМ, и «сводка по лавке»
   * требовала уходить в радар.
   */
  const filters: SummaryFilters = {
    from: p.from,
    to: p.to,
    region: p.region,
    shop: p.shop,
    criterion: p.criterion,
    status: p.status,
  };

  const departures = await departureSummary(p.from, p.to);
  const [regions, shops, summary, totals, top, best, weak, fill, runAttendance, runShowcase] =
    await Promise.all([
      listRegions(p.from, p.to),
      listShops(),
      summaryByCriterion(filters),
      shopTotals(filters),
      antiTop(filters),
      bestShops(filters),
      weakestCriteria(filters),
      showcaseStats(filters),
      lastRun('attendance'),
      lastRun('showcase'),
    ]);
  const writable = isWritable();

  // Что именно сейчас выбрано — словами, а не только видом выпадающих списков.
  const criterionTitle = config.criteria[p.criterion]?.title ?? p.criterion;
  const statusTitle = p.status && p.status !== 'all' ? STATUS_FILTER_TITLE[p.status] : null;

  // За период счётчики усреднены по дням — подпись должна это говорить.
  const scope = singleDay
    ? `на ${shortDate(p.to)}`
    : `в среднем за день · ${shortDate(p.from)} — ${shortDate(p.to)}`;

  // Плитки, топ и анти-топ считаются по выбранному критерию, а не по агрегату
  // лавки — без подписи цифры выглядели бы необъяснимо просевшими.
  const byCriterion = ` · критерий «${criterionTitle}»`;

  const unconfirmed = CRITERION_ORDER.filter((c) => config.criteria[c]?.confirmed === false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Сводка по сети</h1>
          <p className="mt-1 text-sm muted">
            {singleDay
              ? `Статусы на ${shortDate(p.to)}`
              : `Период ${shortDate(p.from)} — ${shortDate(p.to)} · ${totals.days} ${plural(totals.days, 'день', 'дня', 'дней')} с данными`}
            {p.region ? ` · РМ ${p.region}` : ''}
            {p.shop ? ` · поиск «${p.shop}»` : ''}
            {byCriterion}
            {statusTitle ? ` · ${statusTitle}` : ''}
            {` · ${totals.total} ${plural(totals.total, 'лавка', 'лавки', 'лавок')}`}
          </p>
        </div>
        {writable && <RefreshButton />}
      </div>

      {unconfirmed.length > 0 && (
        <div
          className="surface flex flex-wrap items-center gap-2 p-3 text-sm"
          style={{ borderColor: 'var(--yellow)' }}
        >
          <span>⚠️</span>
          <span>
            Пороги требуют подтверждения по оригиналу листа:{' '}
            <b>{unconfirmed.map((c) => config.criteria[c]?.title).join(', ')}</b>. Цифры сняты с фото
            рукописного листа.
          </span>
          <Link href="/settings" className="underline">
            что именно спорно
          </Link>
        </div>
      )}

      <Filters
        base="/"
        state={p}
        regions={regions}
        dates={p.dates}
        config={config}
        shops={shops.map((s) => ({ code: s.code, name: s.name }))}
        criterionDefault={DEFAULT_CRITERION}
      />

      {/* Фильтр может не найти ни одной лавки — «0 из 0» на шести плитках
          выглядит поломкой, а не пустым результатом. */}
      {totals.total === 0 && (
        <div className="surface p-8 text-center text-sm muted">
          {p.shop
            ? `По запросу «${p.shop}» лавок не нашлось. Попробуй код (М17) или часть названия.`
            : 'Под фильтры не попало ни одной лавки. Сними фильтр по статусу или расширь период.'}
        </div>
      )}

      {/* --- Плитки: лавки по агрегату и наполнение витрин --- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile title="Лавок в 🔴" value={totals.red} total={totals.total} tone="red" hint={scope + byCriterion} />
        <Tile title="Лавок в 🟡" value={totals.yellow} total={totals.total} tone="yellow" hint={scope + byCriterion} />
        <Tile title="Лавок в 🟢" value={totals.green} total={totals.total} tone="green" hint={scope + byCriterion} />
        <ShowcaseTile fill={fill} totalShops={totals.total} scope={scope} />
      </div>

      {/* --- По критериям --- */}
      <section className="surface p-4">
        <h2 className="text-sm font-semibold">Лавки по критериям · {scope}</h2>
        {/* Разрез по всем шести критериям сразу — фильтр «Критерий» его не
            сужает, иначе от блока осталась бы одна плитка. Остальные фильтры
            (РМ, лавка, статус) работают. */}
        <p className="mt-0.5 text-xs muted">
          Здесь всегда все критерии: фильтр «{criterionTitle}» влияет на плитки выше,
          топ и анти-топ.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {summary.map((s) => {
            const cfg = config.criteria[s.criterion];
            const counted = s.green + s.yellow + s.red;
            return (
              <Link
                key={s.criterion}
                href={`/radar?${radarQuery(p, s.criterion)}`}
                /* Карточка — ссылка в радар по этому критерию. Раньше об этом
                   говорил только курсор: добавляем сдвиг рамки под курсором и
                   подпись, иначе половина людей до радара так и не доходит. */
                className="group rounded-lg border p-3 transition-colors"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium group-hover:underline">
                    {cfg?.title ?? s.criterion}
                    {cfg?.confirmed === false && <span title="Пороги требуют подтверждения"> ⚠</span>}
                  </span>
                  <span className="text-xs muted tabular-nums">
                    {counted > 0 ? `${Math.round((s.red / counted) * 100)}% 🔴` : '—'}
                  </span>
                </div>
                <div className="mt-2">
                  <StatusBar green={s.green} yellow={s.yellow} red={s.red} missing={s.missing} />
                </div>
                <div className="mt-1.5 flex gap-3 text-xs tabular-nums muted">
                  <span>🟢 {s.green}</span>
                  <span>🟡 {s.yellow}</span>
                  <span>🔴 {s.red}</span>
                  {s.missing > 0 && <span>· нет данных: {s.missing}</span>}
                </div>
                {counted === 0 && (
                  <p className="mt-1.5 text-xs muted">
                    Ни одной отметки за день — должность не встречается в выгрузке.
                  </p>
                )}
              </Link>
            );
          })}
        </div>
      </section>

      {/* Топ и анти-топ рядом: показывать только проблемы — значит показывать
          половину картины, а лавки, которые держат сеть, вообще не видно. */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* --- Топ --- */}
        <section className="surface p-4">
          <h2 className="text-sm font-semibold">Лучшие локации — топ 🟢</h2>
          <p className="mt-0.5 text-xs muted">
            Доля зелёных ячеек за {shortDate(p.from)} — {shortDate(p.to)}{' '}
            по критерию «{criterionTitle}».
          </p>
          {best.length === 0 ? (
            <p className="mt-4 text-sm muted">За период оценённых статусов нет.</p>
          ) : (
            <ul className="mt-3 flex flex-col">
              {best.map((r) => (
                <li
                  key={r.shop.code}
                  className="flex items-start justify-between gap-3 border-t py-2 first:border-0"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div className="min-w-0">
                    <Link
                      href={`/shop/${encodeURIComponent(r.shop.code)}?from=${p.from}&to=${p.to}`}
                      className="text-sm hover:underline"
                    >
                      {r.shop.name}
                    </Link>
                    {r.shop.region && <span className="ml-1.5 text-xs muted">{r.shop.region}</span>}
                    {/* Числитель со знаменателем: без них доля не проверяется. */}
                    <p className="mt-0.5 text-xs muted">
                      {r.greenCount} из {r.total} ячеек
                      {r.fill != null && ` · витрина ${Math.round(r.fill * 100)}%`}
                    </p>
                  </div>
                  <span
                    className="shrink-0 text-sm font-semibold tabular-nums"
                    title="Доля зелёных ячеек за период"
                  >
                    {Math.round(r.share * 100)}% 🟢
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- Анти-топ --- */}
        <section className="surface p-4">
          <h2 className="text-sm font-semibold">Проблемные локации — анти-топ 🔴</h2>
          <p className="mt-0.5 text-xs muted">
            Число красных ячеек за {shortDate(p.from)} — {shortDate(p.to)}{' '}
            по критерию «{criterionTitle}».
          </p>
          {top.length === 0 ? (
            <p className="mt-4 text-sm muted">За период красных статусов нет.</p>
          ) : (
            /* Список, а не таблица: колонка «Западает» — длинный текст, в четырёх
               колонках он на телефоне рассыпался по одному слову в строку. */
            <ul className="mt-3 flex flex-col">
              {top.map((r) => (
                <li
                  key={r.shop.code}
                  className="flex items-start justify-between gap-3 border-t py-2 first:border-0"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div className="min-w-0">
                    <Link
                      href={`/shop/${encodeURIComponent(r.shop.code)}?from=${p.from}&to=${p.to}`}
                      className="text-sm hover:underline"
                    >
                      {r.shop.name}
                    </Link>
                    {r.shop.region && <span className="ml-1.5 text-xs muted">{r.shop.region}</span>}
                    <p className="mt-0.5 text-xs muted">
                      {r.criteria.map((c) => config.criteria[c]?.title ?? c).join(' / ')}
                      {r.fill != null && ` · витрина ${Math.round(r.fill * 100)}%`}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums" title="Красных ячеек за период">
                    {r.redCount} 🔴
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

      </div>

      {/* Выезд с РЦ — сетевой показатель, поэтому отдельным блоком, а не среди
          критериев лавок: к лавкам эта выгрузка не привязана. */}
      {departures && config.rules.driverDeparture && (
        <DepartureBlock
          data={departures}
          greenUntil={config.rules.driverDeparture.greenUntil}
          yellowUntil={config.rules.driverDeparture.yellowUntil}
          zones={config.rules.scoreZones}
        />
      )}

      {/* --- Где западает --- */}
      <section className="surface p-4">
        <h2 className="text-sm font-semibold">Где западает сильнее всего</h2>
        <p className="mt-0.5 text-xs muted">
          Доля 🔴 среди всех оценённых ячеек критерия за период. Здесь тоже все
          критерии — блок про то, какой из них западает.
        </p>
        {/* В две колонки: шесть полос в одну растягивались бы на всю ширину
            экрана, и сравнивать их длину становилось неудобно. */}
        <div className="mt-3 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
          {weak.map((w) => (
            <div key={w.criterion}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>{config.criteria[w.criterion]?.title ?? w.criterion}</span>
                <span className="tabular-nums muted">
                  {Math.round(w.share * 100)}% · {w.red} из {w.total}
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--neutral-soft)' }}>
                <div className="dot-red h-full" style={{ width: `${Math.round(w.share * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>

        {/* Блок про синк показываем только там, где синк вообще возможен:
            на read-only хостинге «не запускалось» — это шум, а не информация. */}
        {writable && (
          <>
            <h3 className="mt-5 text-sm font-semibold">Последние обновления данных</h3>
            <dl className="mt-2 flex flex-col gap-1.5 text-xs">
              <RunLine label="Отметки (Диск)" run={runAttendance} />
              <RunLine label="Витрины (Таблица)" run={runShowcase} />
            </dl>
          </>
        )}
      </section>

    </div>
  );
}

/**
 * Ссылка со сводки в радар: тот же период и те же фильтры, но со своим
 * критерием. Без переноса фильтров человек, отобравший лавки одного РМ,
 * проваливался в радар по всей сети.
 */
function radarQuery(
  p: { from: string; to: string; region?: string; shop?: string; status?: string },
  criterion: CriterionKey,
): string {
  const q = new URLSearchParams({ from: p.from, to: p.to, criterion });
  if (p.region) q.set('region', p.region);
  if (p.shop) q.set('shop', p.shop);
  if (p.status && p.status !== 'all') q.set('status', p.status);
  return q.toString();
}

/**
 * Витрину заполняют руками в течение дня, поэтому покрытие бывает низким.
 * Среднее по трём лавкам — не среднее по сети, и подавать его так нельзя.
 */
function ShowcaseTile({
  fill,
  totalShops,
  scope,
}: {
  fill: Awaited<ReturnType<typeof showcaseStats>>;
  totalShops: number;
  scope: string;
}) {
  const coverage = totalShops > 0 ? fill.filled / totalShops : 0;
  const thin = coverage < 0.5;

  return (
    <div className="surface p-4">
      <div className="text-xs muted" title={scope}>
        Среднее наполнение витрины
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">
          {fill.avg == null ? '—' : `${Math.round(fill.avg * 100)}%`}
        </span>
        {fill.filled > 0 && (
          <span className="text-xs tabular-nums muted">
            по {fill.filled} {plural(fill.filled, 'лавке', 'лавкам', 'лавкам')} из {totalShops}
          </span>
        )}
      </div>
      {fill.filled === 0 ? (
        <p className="mt-1 text-xs muted">За день таблицу ещё не заполняли.</p>
      ) : thin ? (
        <p className="mt-1 text-xs ink-yellow">
          ⚠ Заполнено меньше половины лавок — это не среднее по сети.
        </p>
      ) : (
        <p className="mt-1 text-xs muted">
          минимум {Math.round((fill.min ?? 0) * 100)}% — {fill.minShop}
        </p>
      )}
    </div>
  );
}

/**
 * Плитка «лавок в 🔴 — 12 из 80».
 *
 * Полоса под цифрой рисовалась через StatusBar, и остаток она подавала как
 * `missing` — «нет данных». На деле остаток — это лавки других цветов, по
 * которым данные как раз есть, и первый же блок сводки вводил в заблуждение.
 * Здесь это просто доля: сколько из всех лавок попало в эту зону.
 */
function Tile({
  title,
  value,
  total,
  tone,
  hint,
}: {
  title: string;
  value: number;
  total: number;
  tone: 'red' | 'yellow' | 'green';
  hint: string;
}) {
  const share = total > 0 ? value / total : 0;

  return (
    <div className="surface p-4">
      <div className="text-xs muted" title={hint}>
        {title}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className="text-2xl font-semibold tabular-nums"
          style={{ color: `var(--${tone}-ink)` }}
        >
          {value}
        </span>
        <span className="text-sm muted tabular-nums">из {total}</span>
      </div>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--neutral-soft)' }}
        role="img"
        aria-label={`${value} из ${total} — ${Math.round(share * 100)}%`}
      >
        <div
          className={`dot-${tone} h-full`}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
    </div>
  );
}

function RunLine({
  label,
  run,
}: {
  label: string;
  run: Awaited<ReturnType<typeof lastRun>>;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="muted">{label}</dt>
      <dd className="text-right">
        {run ? (
          <>
            <StatusBadge status={run.status === 'ok' ? 'green' : 'red'}>
              {run.status === 'ok' ? 'ок' : 'ошибка'}
            </StatusBadge>{' '}
            <span className="muted">
              {formatMoment(run.finishedAt ?? run.startedAt, {
                dateStyle: 'short',
                timeStyle: 'medium',
              })}{' '}
              МСК · {run.rows} строк
            </span>
          </>
        ) : (
          <span className="muted">не запускалось</span>
        )}
      </dd>
    </div>
  );
}
