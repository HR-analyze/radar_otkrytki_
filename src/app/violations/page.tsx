import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { listRegions, listShops, violations } from '@/lib/queries';
import { formatLate, kindsOf, type ShopDay, type ViolationsGroup } from '@/lib/violations';
import { shortDate } from '@/lib/time';
import { plural } from '@/lib/plural';
import { Filters } from '@/components/Filters';
import { Hint } from '@/components/Hint';

export const dynamic = 'force-dynamic';

/** Сколько строк показываем на странице: остальное — в PDF и CSV. */
const LIMIT = 40;

/**
 * Нарушения открытия — четыре вопроса заказчика одним экраном:
 *
 *   1. выезд с РЦ позже установленного времени;
 *   2. водитель приехал вовремя, а сотрудника фактически не было;
 *   3. сотрудник был, а водитель опоздал;
 *   4. повар опоздал.
 *
 * Радар на соседней вкладке красит день лавки и отвечает «как дела». Здесь
 * вопрос другой — «что именно нарушено и кем», поэтому единица не цвет, а
 * случай: строка с фамилией, временем и величиной опоздания.
 *
 * Правила — в violations.ts, выборка под фильтры — в queries.violations.
 */
export default async function ViolationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = await resolveParams(sp);
  const config = loadConfig();
  const [regions, shops] = await Promise.all([listRegions(p.from, p.to), listShops(p.from)]);

  const { report, departures } = await violations({
    from: p.from,
    to: p.to,
    region: p.region,
    shop: p.shop,
  });
  const { summary: s } = report;

  const noStaff = report.days.filter((d) => kindsOf(d).includes('driver_on_time_no_staff'));
  const noStaffLate = report.days.filter((d) => kindsOf(d).includes('no_staff_driver_late'));
  const driverLate = report.days.filter((d) => kindsOf(d).includes('driver_late'));
  const cookLate = report.days.filter((d) => d.lateCooks.length > 0 && !d.skipped);

  const query = new URLSearchParams({ from: p.from, to: p.to });
  if (p.region) query.set('region', p.region);
  if (p.shop) query.set('shop', p.shop);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Нарушения открытия</h1>
          <p className="mt-1 text-sm muted">
            Выезд с РЦ, приезд водителя в лавку и приход поваров — против норматива
            {' · '}
            {shortDate(p.from)} — {shortDate(p.to)}
            {p.region && ` · РМ ${p.region}`}
            {p.shop && ` · поиск «${p.shop}»`}
          </p>
        </div>
        {s.checked > 0 && (
          /* Обычные ссылки, а не кнопки с JS: файлы собираются на сервере и
             должны скачиваться, даже если скрипты не загрузились. */
          <div className="flex gap-2">
            <a
              href={`/api/violations/report?${query.toString()}`}
              className="rounded-lg border px-3 py-2 text-sm font-medium whitespace-nowrap hover:opacity-90"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              title="Отчёт за период с теми же фильтрами: все четыре раздела целиком"
            >
              ⬇ Скачать PDF
            </a>
            <a
              href={`/api/violations/csv?${query.toString()}`}
              className="rounded-lg border px-3 py-2 text-sm font-medium whitespace-nowrap hover:opacity-90"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              title="Все нарушения за период с теми же фильтрами — таблицей для Excel"
            >
              ⬇ CSV
            </a>
          </div>
        )}
      </div>

      <Filters
        base="/violations"
        state={p}
        regions={regions}
        dates={p.dates}
        config={config}
        shops={shops.map((sh) => ({ code: sh.code, name: sh.name }))}
        showCriterion={false}
        showStatus={false}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          n="1"
          title="Выезд с РЦ позже нормы"
          value={departures.hasData ? String(departures.yellow + departures.red) : '—'}
          hint={
            departures.hasData
              ? `из ${departures.checked} ${plural(departures.checked, 'выезда', 'выездов', 'выездов')} · 🔴 ${departures.red}`
              : 'выгрузки по РЦ за период нет'
          }
          explain={`Норматив выезда свой у каждой лавки («Выезд с РЦ» в справочнике) и берётся по первой лавке маршрута водителя за этот день. Где связать не вышло, применяется сетевое правило — до ${departures.greenUntil}. Единица здесь — выезд водителя, а не лавко-день.`}
          accent={departures.red > 0}
        />
        <Tile
          n="2"
          title="Водитель вовремя, встретить некому"
          value={String(s.byKind.driver_on_time_no_staff)}
          hint={`ещё ${s.byKind.no_staff_driver_late} — и водитель опоздал`}
          explain={`Водитель уложился в норму своей лавки, а первый сотрудник отметился уже после него — встречать товар было некому. Уборщик встречающим не считается: он приходит к своей уборке. Разрыв меньше ${report.options.staffGapSeconds} секунд показан как «вместе»: два человека у одного терминала так не попадают.`}
          accent={s.byKind.driver_on_time_no_staff > 0}
        />
        <Tile
          n="3"
          title="Сотрудник есть — водитель опоздал"
          value={String(s.byKind.driver_late)}
          hint={`из ${s.checked} ${plural(s.checked, 'лавко-дня', 'лавко-дней', 'лавко-дней')} · 🔴 ${s.driverLateRed}`}
          explain="Сотрудник отметился сам, отдельно от водителя, а водитель приехал позже нормы своей лавки. Норма у каждой лавки своя — она видна на вкладке «Пороги»."
          accent={s.byKind.driver_late > 0}
        />
        <Tile
          n="4"
          title="Повар опоздал"
          value={String(s.lateCooks)}
          hint={`в ${s.byKind.cook_late} ${plural(s.byKind.cook_late, 'лавко-дне', 'лавко-днях', 'лавко-днях')} · 🔴 ${s.lateCooksRed}`}
          explain="Повара сравниваются каждый со своей нормой: «1 с 6:00, 2 с 6:30» значит, что к 6:00 лавку открывает первый, а к 6:30 она укомплектована. Здесь считаются люди, а не дни: два опоздавших в одной лавке — это две строки."
          accent={s.lateCooks > 0}
        />
      </div>

      {/* --- 1. Выезд с РЦ --- */}
      <section className="surface p-4">
        <h2 className="text-sm font-semibold">1. Выезд с РЦ позже установленного времени</h2>
        <p className="mt-0.5 text-xs muted">
          Норматив выезда свой у каждой лавки и берётся по первой лавке маршрута водителя за этот
          день; где связать не вышло — сетевое правило «до {departures.greenUntil}», в таблице оно
          подписано «(сеть)». Строка — один выезд водителя с РЦ.
          {departures.byShopNorm > 0 &&
            ` По норме лавки посчитано ${departures.byShopNorm} из ${departures.checked}.`}
        </p>
        {!departures.hasData ? (
          <p className="mt-4 text-sm muted">
            За период нет выгрузки по РЦ. Радар читает её отдельным файлом («РЦ Свобода»), и без
            него выезды не считаются — ни вовремя, ни с опозданием.
          </p>
        ) : departures.late.length === 0 ? (
          <p className="mt-4 text-sm muted">
            Все {departures.checked} {plural(departures.checked, 'выезд', 'выезда', 'выездов')} за
            период — в норме.
          </p>
        ) : (
          <Table
            head={['Дата', 'Водитель', 'Первая лавка', 'Норма', 'Выехал', 'Позже нормы', 'Зона']}
            align={['left', 'left', 'left', 'right', 'right', 'right', 'right']}
            rows={departures.late.slice(0, LIMIT).map((l) => [
              shortDate(l.date),
              l.employeeName,
              l.shop ?? 'не определена',
              l.normSource === 'shop' ? l.norm : `${l.norm} (сеть)`,
              l.time,
              formatLate(l.lateBy),
              l.status === 'red' ? '🔴' : '🟡',
            ])}
            more={departures.late.length - LIMIT}
          />
        )}
      </section>

      {/* --- 2. Сотрудника не было --- */}
      <section className="surface p-4">
        <h2 className="text-sm font-semibold">
          2. Водитель приехал вовремя, а встретить его было некому
        </h2>
        <p className="mt-0.5 text-xs muted">
          Первый сотрудник отметился позже водителя — в колонке «Разрыв» видно, на сколько.
          Уборщик встречающим не считается. «Вместе» — отметки разошлись меньше чем на{' '}
          {report.options.staffGapSeconds} секунд. Клик по лавке открывает её карточку за этот день.
        </p>
        {noStaff.length === 0 ? (
          <p className="mt-4 text-sm muted">За период таких дней нет.</p>
        ) : (
          <DayTable days={noStaff} />
        )}
        {noStaffLate.length > 0 && (
          <>
            <h3 className="mt-5 text-xs font-semibold">
              Отдельно: сотрудника не было, и водитель при этом опоздал —{' '}
              {noStaffLate.length}
            </h3>
            <p className="mt-0.5 text-xs muted">
              Вынесено из счёта пункта 2, чтобы один день не попал в две категории сразу.
            </p>
            <DayTable days={noStaffLate} />
          </>
        )}
      </section>

      {/* --- 3. Водитель опоздал --- */}
      <section className="surface p-4">
        <h2 className="text-sm font-semibold">3. Сотрудник есть — водитель опоздал</h2>
        <p className="mt-0.5 text-xs muted">
          Сотрудник отметился сам, а водитель приехал позже нормы своей лавки. Сортировка — по
          величине опоздания.
        </p>
        {driverLate.length === 0 ? (
          <p className="mt-4 text-sm muted">За период таких дней нет.</p>
        ) : (
          <DayTable
            days={[...driverLate].sort((a, b) => (b.driverLateBy ?? 0) - (a.driverLateBy ?? 0))}
          />
        )}
      </section>

      {/* --- 4. Повар опоздал --- */}
      <section className="surface p-4">
        <h2 className="text-sm font-semibold">4. Повар нарушил тайминг прихода</h2>
        <p className="mt-0.5 text-xs muted">
          Каждый повар — со своей нормой по справочнику лавки. Строка — один человек за один день.
        </p>
        {cookLate.length === 0 ? (
          <p className="mt-4 text-sm muted">За период опозданий поваров нет.</p>
        ) : (
          <Table
            head={['Дата', 'Лавка', 'Повар', 'Норма', 'Пришёл', 'Опоздание']}
            align={['left', 'left', 'left', 'right', 'right', 'right']}
            rows={cookLate
              .flatMap((d) => d.lateCooks.map((c) => ({ day: d, cook: c })))
              .sort((a, b) => b.cook.lateBy - a.cook.lateBy)
              .slice(0, LIMIT)
              .map(({ day, cook }) => [
                shortDate(day.date),
                <Link
                  key={`${day.date}-${day.shopCode}`}
                  href={`/shop/${encodeURIComponent(day.shopCode)}?from=${day.date}&to=${day.date}`}
                  className="hover:underline"
                >
                  {day.shopName}
                </Link>,
                cook.name,
                cook.norm,
                cook.time,
                formatLate(cook.lateBy),
              ])}
            more={cookLate.reduce((n, d) => n + d.lateCooks.length, 0) - LIMIT}
          />
        )}
      </section>

      {/* --- Повторяемость --- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <GroupSection
          title="Лавки"
          note="Сумма нарушений по пунктам 2–4. Выезд с РЦ сюда не входит: его не с чем связать по лавкам."
          groups={report.byShop.filter((g) => g.total > 0)}
          head="Лавка"
          unit="Дней"
          empty="Нарушений по лавкам за период нет."
          linkOf={(g) => `/violations?${withKey(query, 'shop', g.key)}`}
        />
        <GroupSection
          title="Водители"
          note="Тот же счёт по человеку за рулём: он объезжает несколько лавок, и повторяемость видно только здесь."
          groups={report.byDriver.filter((g) => g.total > 0)}
          head="Водитель"
          unit="Лавко-дней"
          empty="Нарушений по водителям за период нет."
        />
      </div>

      <p className="text-xs muted">
        Считаются только живые отметки face id: время из журнала отгрузок и досчёт «уход − 30
        минут» восстановлены, а не отмечены. Дни «другого графика» — вторая смена, а не опоздание,
        и в счёт не идут. Лавко-дней без отметки водителя за период: {s.noDriverMark}.
      </p>
    </div>
  );
}

/** Лавко-дни: водитель против нормы и кто отметился первым из сотрудников. */
function DayTable({ days }: { days: readonly ShopDay[] }) {
  return (
    <Table
      head={['Дата', 'Лавка', 'Норма', 'Водитель', 'Опоздание', 'Первый сотрудник', 'Разрыв']}
      align={['left', 'left', 'right', 'right', 'right', 'left', 'right']}
      rows={days.slice(0, LIMIT).map((d) => [
        shortDate(d.date),
        <Link
          key={`${d.date}-${d.shopCode}`}
          href={`/shop/${encodeURIComponent(d.shopCode)}?from=${d.date}&to=${d.date}`}
          className="hover:underline"
        >
          {d.shopName}
        </Link>,
        d.driverNorm ?? '—',
        d.driver?.time ?? '—',
        d.driverLateBy != null && d.driverLateBy > 0 ? formatLate(d.driverLateBy) : 'в норме',
        d.staff ? `${d.staff.role}: ${d.staff.time}` : '—',
        formatGap(d),
      ])}
      more={days.length - LIMIT}
    />
  );
}

/** «+17 мин» — сотрудник настолько позже водителя; «вместе» — отметки слиплись. */
function formatGap(day: ShopDay): string {
  if (day.staffGapSeconds == null) return '—';
  if (day.staffMarkedTogether) return `вместе · ${Math.abs(day.staffGapSeconds)} сек`;
  return formatLate(Math.round(day.staffGapSeconds / 60));
}

function GroupSection({
  title,
  note,
  groups,
  head,
  unit,
  empty,
  linkOf,
}: {
  title: string;
  note: string;
  groups: readonly ViolationsGroup[];
  head: string;
  /** У лавки счётчик — её дни, у водителя — лавко-дни: он объезжает несколько. */
  unit: string;
  empty: string;
  linkOf?: (g: ViolationsGroup) => string;
}) {
  return (
    <section className="surface p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-0.5 text-xs muted">{note}</p>
      {groups.length === 0 ? (
        <p className="mt-4 text-sm muted">{empty}</p>
      ) : (
        <Table
          head={[head, unit, '№2', '№3', '№4', 'Всего']}
          align={['left', 'right', 'right', 'right', 'right', 'right']}
          rows={groups.slice(0, LIMIT).map((g) => [
            linkOf ? (
              <Link key={g.key} href={linkOf(g)} className="hover:underline">
                {g.title}
              </Link>
            ) : (
              g.title
            ),
            String(g.days),
            String(g.byKind.driver_on_time_no_staff + g.byKind.no_staff_driver_late),
            String(g.byKind.driver_late),
            String(g.byKind.cook_late),
            String(g.total),
          ])}
          more={groups.length - LIMIT}
        />
      )}
    </section>
  );
}

function Table({
  head,
  rows,
  align,
  more,
}: {
  head: readonly string[];
  rows: readonly React.ReactNode[][];
  align: readonly ('left' | 'right')[];
  /** Сколько строк не поместилось: их видно в PDF и CSV. */
  more: number;
}) {
  return (
    <>
      <div className="radar-scroll mt-3">
        <table className="radar-table w-full text-sm">
          <thead>
            <tr>
              {/* Классы выравнивания — целыми словами: Tailwind не находит
                  их, если склеивать строку вида `text-${...}`. */}
              {head.map((h, i) => (
                <th
                  key={h}
                  className={`px-2 py-2 text-xs font-medium muted ${
                    align[i] === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className={`px-2 py-1.5 text-xs ${
                      align[j] === 'right' ? 'text-right tabular-nums' : 'text-left'
                    } ${j === 0 ? 'whitespace-nowrap tabular-nums muted' : ''}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 && (
        <p className="mt-2 text-xs muted">
          Показаны первые {LIMIT}. Ещё {more} {plural(more, 'строка', 'строки', 'строк')} — в PDF и
          CSV.
        </p>
      )}
    </>
  );
}

function Tile({
  n,
  title,
  value,
  hint,
  explain,
  accent = false,
}: {
  /** Номер пункта: те же четыре, что в постановке. */
  n: string;
  title: string;
  value: string;
  hint?: string;
  explain?: string;
  accent?: boolean;
}) {
  return (
    <div className="surface p-4">
      <div className="flex items-center gap-1 text-xs muted">
        <span className="font-semibold">{n}.</span>
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

/** Ссылка «отфильтровать по этой лавке», не теряя период и РМ. */
function withKey(base: URLSearchParams, key: string, value: string): string {
  const q = new URLSearchParams(base);
  q.set(key, value);
  return q.toString();
}
