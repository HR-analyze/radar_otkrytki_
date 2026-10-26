import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { kpi, listRegions, listShops, type KpiAverage } from '@/lib/queries';
import { formatPercent } from '@/lib/kpi';
import { shortDate } from '@/lib/time';
import { plural } from '@/lib/plural';
import { Filters } from '@/components/Filters';
import { StatusLegend } from '@/components/Status';
import { KpiDailyTable } from '@/components/KpiDailyTable';
import { Hint } from '@/components/Hint';

export const dynamic = 'force-dynamic';

/**
 * КПИ по наполнению витрин — три блока на три уровня ответственности.
 *
 * Показатель один — итог дня витрины (среднее утра и 16:00), разный только
 * срез: линейным сотрудникам — каждый день, директору и ТД — среднее за период
 * по своим лавкам, РМ — среднее за период по региону. Правило — в kpi.ts.
 *
 * Вкладка заменила в шапке «Конкурс»; сам конкурс открывается по прямой
 * ссылке /contest — там закреплённые нарушения и PDF-отчёт.
 */
export default async function KpiPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = await resolveParams(sp);
  const config = loadConfig();
  const [regions, shopList] = await Promise.all([listRegions(p.from, p.to), listShops(p.from)]);

  const { dates, shops, leaders, regions: regionRows, network, unmeasured } = await kpi({
    from: p.from,
    to: p.to,
    region: p.region,
    shop: p.shop,
  });

  const showcase = config.criteria.showcase;
  const zones =
    showcase.kind === 'percent'
      ? `Цвет — зона витрины: 🟢 от ${Math.round(showcase.greenFrom * 100)}% · 🟡 от ${Math.round(showcase.yellowFrom * 100)}% · 🔴 ниже.`
      : '';

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">КПИ по витринам</h1>
        <p className="mt-1 text-sm muted">
          Процент наполнения витрины. Итог дня — среднее утреннего замера и замера в 16:00.
          {shops.length > 0 && (
            <>
              {' · '}
              {shops.length} {plural(shops.length, 'лавка', 'лавки', 'лавок')} ·{' '}
              {shortDate(p.from)} — {shortDate(p.to)}
              {p.region && ` · РМ ${p.region}`}
              {p.shop && ` · поиск «${p.shop}»`}
            </>
          )}
        </p>
      </div>

      <Filters
        base="/kpi"
        state={p}
        regions={regions}
        dates={p.dates}
        config={config}
        shops={shopList.map((s) => ({ code: s.code, name: s.name }))}
        showCriterion={false}
        showStatus={false}
      />

      {shops.length === 0 ? (
        <div className="surface p-8 text-center text-sm muted">
          {p.shop
            ? `По запросу «${p.shop}» замеров витрин за период не нашлось. Попробуйте код (М17) или часть названия.`
            : 'За выбранный период витрины не заполняли. Возьми другой период или сними фильтр по РМ.'}
        </div>
      ) : (
        <>
          <StatusLegend note={`${zones} Клик по клетке — карточка лавки за этот день.`} />

          {/* --- 1. Линейные сотрудники --- */}
          <section className="flex flex-col gap-2">
            <BlockHeading
              n={1}
              title="Линейные сотрудники"
              subtitle="% по каждому дню — итог дня, среднее утра и 16:00. Пустая клетка — в этот день витрину не мерили."
            />
            <KpiDailyTable rows={shops} dates={dates} from={p.from} to={p.to} />
            {unmeasured.length > 0 && (
              <p className="text-xs muted">
                Без единого замера за период ({unmeasured.length}):{' '}
                {unmeasured.map((s) => s.code).join(', ')}. В средние они не входят — «не мерили» не равно 0%.
              </p>
            )}
          </section>

          {/* --- 2. Директор и ТД --- */}
          <section className="surface p-4">
            <BlockHeading
              n={2}
              title="Директор и территориальный директор"
              subtitle="Средний % за период. У ТД одна строка на все его лавки — по справочнику лавок; лавка без ТД — строка её директора."
              hint="Среднее — по всем дням с замером во всех лавках руководителя: каждый лавко-день весит одинаково. Лавка, где мерили два дня из тридцати, тянет итог ТД меньше, чем лавка с тридцатью замерами. ТД берётся из нынешнего справочника — истории ТД, в отличие от РМ, радар не ведёт."
            />
            <div className="radar-scroll mt-3">
              <table className="radar-table w-full text-sm">
                <thead>
                  <tr>
                    <Th left>Руководитель</Th>
                    <Th left>Лавки</Th>
                    <Th left className="hidden sm:table-cell">РМ</Th>
                    <Th className="hidden sm:table-cell">Лавко-дней</Th>
                    <Th>Средний %</Th>
                  </tr>
                </thead>
                <tbody>
                  {leaders.map((l) => (
                    <tr key={l.kind === 'territorial' ? `td:${l.name}` : `shop:${l.shops[0].shop.code}`}>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {l.kind === 'territorial' ? (
                          <>
                            <span className="mr-1.5 text-xs muted">ТД</span>
                            {l.name}
                          </>
                        ) : (
                          <span className="muted">Директор лавки</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex flex-col gap-0.5">
                          {l.shops.map((r) => (
                            <span key={r.shop.code} className="whitespace-nowrap">
                              <Link
                                href={`/shop/${encodeURIComponent(r.shop.code)}?from=${p.from}&to=${p.to}`}
                                className="hover:underline"
                              >
                                {r.shop.name}
                              </Link>
                              {/* У директора одна лавка, и её среднее — это и есть итог строки. */}
                              {l.shops.length > 1 && (
                                <span className="ml-2 text-xs tabular-nums muted">{formatPercent(r.avg)}</span>
                              )}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="hidden px-2 py-1.5 text-xs whitespace-nowrap muted sm:table-cell">
                        {l.regions.join(', ') || '—'}
                      </td>
                      <td className="hidden px-2 py-1.5 text-right text-xs tabular-nums muted sm:table-cell">
                        {l.measured}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Percent value={l} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* --- 3. РМ --- */}
          <section className="surface p-4">
            <BlockHeading
              n={3}
              title="Региональные менеджеры"
              subtitle="Средний % по региону за период."
              hint="Среднее — по всем лавко-дням региона с замером. День лавки идёт тому РМ, который вёл её в этот день: после передачи лавки её прошлые дни остаются у прежнего РМ."
            />
            {regionRows.length === 0 ? (
              <p className="mt-4 text-sm muted">За период РМ не определились — справочник пуст.</p>
            ) : (
              <div className="radar-scroll mt-3">
                <table className="radar-table w-full text-sm">
                  <thead>
                    <tr>
                      <Th left>РМ</Th>
                      <Th>Лавок</Th>
                      <Th className="hidden sm:table-cell">Лавко-дней</Th>
                      <Th>Средний %</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {regionRows.map((r) => (
                      <tr key={r.region}>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <Link
                            href={`/kpi?from=${p.from}&to=${p.to}&region=${encodeURIComponent(r.region)}`}
                            className="hover:underline"
                          >
                            {r.region}
                          </Link>
                        </td>
                        <td className="px-2 py-1.5 text-right text-xs tabular-nums muted">{r.shops}</td>
                        <td className="hidden px-2 py-1.5 text-right text-xs tabular-nums muted sm:table-cell">
                          {r.measured}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <Percent value={r} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/* Сеть — для сравнения: выше или ниже среднего по сети РМ. */}
                  {!p.region && regionRows.length > 1 && (
                    <tfoot>
                      <tr>
                        <td className="px-2 py-1.5 font-medium">Вся сеть</td>
                        <td className="px-2 py-1.5 text-right text-xs tabular-nums muted">{network.shops}</td>
                        <td className="hidden px-2 py-1.5 text-right text-xs tabular-nums muted sm:table-cell">
                          {network.measured}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <Percent value={network} />
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function BlockHeading({
  n,
  title,
  subtitle,
  hint,
}: {
  n: number;
  title: string;
  subtitle: string;
  /** Как получилась цифра — если из подписи это не очевидно. */
  hint?: string;
}) {
  return (
    <div>
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <span className="muted">{n}.</span> {title}
        {hint && <Hint text={hint} />}
      </h2>
      <p className="mt-0.5 text-xs muted">{subtitle}</p>
    </div>
  );
}

function Th({ children, left, className = '' }: { children: React.ReactNode; left?: boolean; className?: string }) {
  return (
    <th className={`px-2 py-2 text-xs font-medium whitespace-nowrap muted ${left ? 'text-left' : 'text-right'} ${className}`}>
      {children}
    </th>
  );
}

/** Средний процент на подложке своей зоны: цвет читается раньше цифры. */
function Percent({ value }: { value: KpiAverage }) {
  return (
    <span
      className={`st-${value.status} inline-block rounded-md px-2 py-0.5 text-sm font-semibold whitespace-nowrap tabular-nums`}
      title={`${value.measured} ${plural(value.measured, 'лавко-день', 'лавко-дня', 'лавко-дней')} с замером`}
    >
      {formatPercent(value.avg)}
    </span>
  );
}
