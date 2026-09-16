import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { driverCook, listRegions, listShops } from '@/lib/queries';
import { BUCKET_TITLES, formatDelta, isSuspicious, type DriverCookGroup } from '@/lib/driver-cook';
import { shortDate } from '@/lib/time';
import { plural } from '@/lib/plural';
import { Filters } from '@/components/Filters';
import { Hint } from '@/components/Hint';

export const dynamic = 'force-dynamic';

/**
 * Сверка отметок: водитель и первый повар.
 *
 * Вопрос, ради которого вкладка существует: бывает ли, что водитель и повар
 * отмечаются одним движением. Водитель приезжает раньше смены, это два разных
 * человека у одного терминала — совпадение секунда в секунду на пустой лавке
 * расписанием не объясняется.
 *
 * Страница ничего не обвиняет и цвет лавке не ставит: она показывает пары и
 * их повторяемость по лавке и по водителю. Правила разбора — в driver-cook.ts,
 * выборка под фильтры — в queries.driverCook.
 *
 * Фильтров по критерию и статусу здесь нет: критерий тут ровно один, а статус
 * радара к близости отметок отношения не имеет.
 */
export default async function DriverCookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = await resolveParams(sp);
  const config = loadConfig();
  const [regions, shops] = await Promise.all([listRegions(p.from, p.to), listShops(p.from)]);

  const report = await driverCook({ from: p.from, to: p.to, region: p.region, shop: p.shop });
  const { summary: s } = report;
  const suspicious = report.pairs.filter(isSuspicious);
  const query = new URLSearchParams({ from: p.from, to: p.to });
  if (p.region) query.set('region', p.region);
  if (p.shop) query.set('shop', p.shop);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Сверка отметок</h1>
          <p className="mt-1 text-sm muted">
            Водитель и первый повар лавки: во сколько отметился каждый и не совпали ли отметки
            {' · '}
            {shortDate(p.from)} — {shortDate(p.to)}
            {p.region && ` · РМ ${p.region}`}
            {p.shop && ` · поиск «${p.shop}»`}
          </p>
        </div>
        {s.pairs > 0 && (
          /* Обычные ссылки, а не кнопки с JS: файлы собираются на сервере и
             должны скачиваться, даже если скрипты не загрузились. */
          <div className="flex gap-2">
            <a
              href={`/api/driver-cook/report?${query.toString()}`}
              className="rounded-lg border px-3 py-2 text-sm font-medium whitespace-nowrap hover:opacity-90"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              title="Отчёт за период с теми же фильтрами: итоги, динамика по дням, лавки, водители и список совпавших дней"
            >
              ⬇ Скачать PDF
            </a>
            <a
              href={`/api/driver-cook/csv?${query.toString()}`}
              className="rounded-lg border px-3 py-2 text-sm font-medium whitespace-nowrap hover:opacity-90"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              title="Все пары за период с теми же фильтрами — таблицей для Excel"
            >
              ⬇ CSV
            </a>
          </div>
        )}
      </div>

      <Filters
        base="/driver-cook"
        state={p}
        regions={regions}
        dates={p.dates}
        config={config}
        shops={shops.map((sh) => ({ code: sh.code, name: sh.name }))}
        showCriterion={false}
        showStatus={false}
      />

      {s.pairs === 0 ? (
        <div className="surface p-8 text-center text-sm muted">
          {p.shop
            ? `По запросу «${p.shop}» пар за период не нашлось. Попробуйте код (М17) или часть названия.`
            : 'За период нет ни одного дня, где face id есть и у водителя, и у повара одной лавки. ' +
              'Обычно это значит, что загружены не обе выгрузки: нужны и «выходы», и «водители».'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              title="Лавко-дней в сверке"
              value={String(s.pairs)}
              hint={`пропущено: ${s.skipped}`}
              explain={
                'Дни, где в одной лавке есть живая отметка face id и у водителя, и у повара — ' +
                'только их и можно сравнивать. Пропущенные — это дни, где отметка была ' +
                'только у одной стороны или время восстановлено из журнала отгрузок: ' +
                'у восстановленного времени разница в минутах ничего не значит.'
              }
            />
            <Tile
              title="Водитель раньше повара"
              value={String(s.byBucket.driver_before)}
              hint={`${share(s.byBucket.driver_before, s.pairs)} · лавку открыл водитель: ${s.aloneByBucket.driver_before}`}
              explain={
                'Водитель отметился раньше первого повара больше чем на минуту. Само по себе ' +
                'это нормальная работа — товар привозят до смены. Смотреть стоит на вторую ' +
                'цифру: дни, когда до водителя в лавке не было вообще никого.'
              }
            />
            <Tile
              title="Отметились одновременно"
              value={String(s.byBucket.simultaneous)}
              hint={`${share(s.byBucket.simultaneous, s.pairs)} · из них лавка пустая: ${s.aloneByBucket.simultaneous}`}
              explain={
                `Разрыв между отметками не больше ${report.options.simultaneousSeconds} секунд — ` +
                'фактически один момент. Два человека у одного терминала так не попадают.'
              }
              accent
            />
            <Tile
              title="Совпало на пустой лавке"
              value={String(suspicious.length)}
              hint={`${share(suspicious.length, s.pairs)} от всех дней`}
              explain={
                `Отметки сошлись в пределах ${report.options.closeMinutes} минут, и до этой пары ` +
                'в лавке не отмечался никто — ни кассир, ни бариста, ни уборщик. Это и есть ' +
                'случаи, которые стоит разобрать руками.'
              }
              accent
            />
          </div>

          <section className="surface p-4">
            <h2 className="text-sm font-semibold">Как разошлись отметки</h2>
            <p className="mt-0.5 text-xs muted">
              Знаменатель во всех долях — {s.pairs}{' '}
              {plural(s.pairs, 'лавко-день', 'лавко-дня', 'лавко-дней')} с обеими отметками.
            </p>
            <div className="radar-scroll mt-3">
              <table className="radar-table w-full text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-2 text-left text-xs font-medium muted">Случай</th>
                    <th className="px-2 py-2 text-right text-xs font-medium muted">Дней</th>
                    <th className="px-2 py-2 text-right text-xs font-medium muted">Доля</th>
                    <th className="px-2 py-2 text-right text-xs font-medium muted">
                      <span className="inline-flex items-center gap-1">
                        До пары никого
                        <Hint text="В этот день до водителя и повара в лавке не отметился никто — считаются все должности, включая уборщика и директора: вопрос в том, был ли в лавке кто-то ещё." />
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <BucketRow
                    title={`Водитель раньше повара (> ${report.options.simultaneousSeconds} сек)`}
                    count={s.byBucket.driver_before}
                    alone={s.aloneByBucket.driver_before}
                    total={s.pairs}
                  />
                  <BucketRow
                    title={`Одновременно (± ${report.options.simultaneousSeconds} сек)`}
                    count={s.byBucket.simultaneous}
                    alone={s.aloneByBucket.simultaneous}
                    total={s.pairs}
                  />
                  <BucketRow
                    title={`Повар раньше, разрыв до ${report.options.closeMinutes} мин`}
                    count={s.byBucket.cook_before_close}
                    alone={s.aloneByBucket.cook_before_close}
                    total={s.pairs}
                  />
                  <BucketRow
                    title="Повар раньше водителя — обычный день"
                    count={s.byBucket.cook_before}
                    alone={null}
                    total={s.pairs}
                  />
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <GroupSection
              title="Лавки"
              note="Отсортировано по числу совпадений. Одно совпадение — случайность, семь из семи — уже нет."
              groups={report.byShop.filter((g) => g.alone > 0)}
              empty="Совпадений по лавкам за период нет."
              head="Лавка"
              linkOf={(g) => `/driver-cook?${withKey(query, 'shop', g.key)}`}
            />
            <GroupSection
              title="Водители"
              note="Тот же счёт, но по человеку за рулём: он объезжает несколько лавок, и повторяемость видно только здесь."
              groups={report.byDriver.filter((g) => g.alone > 0)}
              empty="Совпадений по водителям за период нет."
              head="Водитель"
            />
          </div>

          <section className="surface p-4">
            <h2 className="text-sm font-semibold">
              Совпавшие пары: {suspicious.length}{' '}
              {plural(suspicious.length, 'день', 'дня', 'дней')}
            </h2>
            <p className="mt-0.5 text-xs muted">
              Разрыв со знаком «+» — водитель отметился раньше повара, «−» — позже. Клик по лавке
              открывает её карточку за этот день.
            </p>
            {suspicious.length === 0 ? (
              <p className="mt-4 text-sm muted">
                За период таких дней нет: отметки водителя и повара нигде не сошлись на пустой
                лавке.
              </p>
            ) : (
              <div className="radar-scroll mt-3">
                <table className="radar-table w-full text-sm">
                  <thead>
                    <tr>
                      <th className="px-2 py-2 text-left text-xs font-medium muted">Дата</th>
                      <th className="px-2 py-2 text-left text-xs font-medium muted">Лавка</th>
                      <th className="px-2 py-2 text-right text-xs font-medium muted">Водитель</th>
                      <th className="px-2 py-2 text-right text-xs font-medium muted">Повар</th>
                      <th className="px-2 py-2 text-right text-xs font-medium muted">Разрыв</th>
                      <th className="hidden px-2 py-2 text-left text-xs font-medium muted lg:table-cell">
                        Кто за рулём
                      </th>
                      <th className="hidden px-2 py-2 text-left text-xs font-medium muted lg:table-cell">
                        Кто на кухне
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {suspicious.map((pair) => (
                      <tr key={`${pair.date}-${pair.shopCode}`}>
                        <td className="px-2 py-1.5 text-xs whitespace-nowrap tabular-nums muted">
                          {shortDate(pair.date)}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <Link
                            href={`/shop/${encodeURIComponent(pair.shopCode)}?from=${pair.date}&to=${pair.date}`}
                            className="hover:underline"
                          >
                            {pair.shopName}
                          </Link>
                        </td>
                        <td className="px-2 py-1.5 text-right text-xs tabular-nums">
                          {pair.driverTime}
                        </td>
                        <td className="px-2 py-1.5 text-right text-xs tabular-nums">
                          {pair.cookTime}
                        </td>
                        <td
                          className="px-2 py-1.5 text-right text-xs font-medium whitespace-nowrap tabular-nums"
                          title={BUCKET_TITLES[pair.bucket]}
                        >
                          {formatDelta(pair.deltaMinutes)}
                        </td>
                        <td className="hidden px-2 py-1.5 text-xs lg:table-cell">
                          {pair.driverName}
                        </td>
                        <td className="hidden px-2 py-1.5 text-xs lg:table-cell">
                          {pair.cookName}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-xs muted">
            Сверка идёт только по живым отметкам face id. Время из журнала отгрузок и досчёт
            «уход − 30 минут» в неё не входят: они восстановлены, а не отмечены. Совпадение
            отметок — повод разобраться, а не приговор: страница не меняет ни статусы лавки, ни
            итог радара.
          </p>
        </>
      )}
    </div>
  );
}

function BucketRow({
  title,
  count,
  alone,
  total,
}: {
  title: string;
  count: number;
  /** null — колонка к этому случаю неприменима. */
  alone: number | null;
  total: number;
}) {
  return (
    <tr>
      <td className="px-2 py-1.5">{title}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{count}</td>
      <td className="px-2 py-1.5 text-right text-xs tabular-nums muted">{share(count, total)}</td>
      <td className="px-2 py-1.5 text-right text-xs font-medium tabular-nums">
        {alone == null ? '—' : alone}
      </td>
    </tr>
  );
}

function GroupSection({
  title,
  note,
  groups,
  empty,
  head,
  linkOf,
}: {
  title: string;
  note: string;
  groups: readonly DriverCookGroup[];
  empty: string;
  head: string;
  /** Ссылка с строки — только там, где по ней есть куда отфильтровать. */
  linkOf?: (g: DriverCookGroup) => string;
}) {
  return (
    <section className="surface p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-0.5 text-xs muted">{note}</p>
      {groups.length === 0 ? (
        <p className="mt-4 text-sm muted">{empty}</p>
      ) : (
        <div className="radar-scroll mt-3">
          <table className="radar-table w-full text-sm">
            <thead>
              <tr>
                <th className="px-2 py-2 text-left text-xs font-medium muted">{head}</th>
                <th className="px-2 py-2 text-right text-xs font-medium muted">Дней</th>
                <th className="px-2 py-2 text-right text-xs font-medium muted">Одновр.</th>
                <th className="px-2 py-2 text-right text-xs font-medium muted">Рядом</th>
                <th className="px-2 py-2 text-right text-xs font-medium muted">Совпало</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {linkOf ? (
                      <Link href={linkOf(g)} className="hover:underline">
                        {g.title}
                      </Link>
                    ) : (
                      g.title
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums muted">{g.pairs}</td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums muted">
                    {g.simultaneous}
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums muted">
                    {g.cookBeforeClose}
                  </td>
                  <td className="px-2 py-1.5 text-right text-sm font-semibold tabular-nums">
                    {g.alone}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Tile({
  title,
  value,
  hint,
  explain,
  accent = false,
}: {
  title: string;
  value: string;
  hint?: string;
  explain?: string;
  /** Плитка про совпадения — ради них страница и открыта. */
  accent?: boolean;
}) {
  return (
    <div className="surface p-4">
      <div className="flex items-center gap-1 text-xs muted">
        {title}
        {explain && <Hint text={explain} />}
      </div>
      <div
        className="mt-1 text-2xl font-semibold tabular-nums"
        style={accent ? { color: 'var(--red)' } : undefined}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs muted">{hint}</div>}
    </div>
  );
}

function share(n: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((n / total) * 1000) / 10}%`;
}

/** Ссылка «отфильтровать по этой лавке», не теряя период и РМ. */
function withKey(base: URLSearchParams, key: string, value: string): string {
  const q = new URLSearchParams(base);
  q.set(key, value);
  return q.toString();
}
