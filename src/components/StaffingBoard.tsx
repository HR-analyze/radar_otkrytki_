'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  EXTRA_ROLES,
  STAFF_ROLES,
  STAFF_ROLE_FORMS,
  STAFF_ROLE_SHORT,
  STAFF_ROLE_TITLE,
  TEMPLATE_ROLES,
  postsLabel,
  MONTH_DAYS,
  STAFF_HOURLY_RATE,
  dailyHours,
  monthlyHours,
  pay,
  slotAt,
  slotLabel,
  slotPersonHours,
  slotShortLabel,
  staffAt,
  staffAtAll,
  type StaffNorm,
} from '@/lib/staffing';
import { formatClock, minutesNowMsk } from '@/lib/time';
import { plural } from '@/lib/plural';
import { Hint } from './Hint';
import { StaffingLayout } from './StaffingLayout';

/**
 * График пиков: калькулятор «лавка + время → сколько людей на смене» и под
 * ним шаблон таблицей.
 *
 * Всё считается в браузере: норм на все лавки — пара сотен окон, и гонять
 * сервер на каждую смену времени незачем. Выбор живёт в адресе (replaceState,
 * без перезагрузки страницы), так что «М17 в 14:00» передаётся ссылкой.
 *
 * Таблица и калькулятор связаны: при «Все лавки» в таблице вся сеть, а
 * калькулятор считает сумму по ней; выбрана лавка — в таблице остаётся она
 * одна. Окно, в которое попало время, подсвечено столбцом. Клик по строке
 * выбирает лавку.
 */
export function StaffingBoard({
  norms,
  initialCode,
  initialMinutes,
  initialLive = false,
  editable = false,
  unlocked = false,
}: {
  norms: StaffNorm[];
  /** null — «Все лавки». */
  initialCode: string | null;
  initialMinutes: number;
  /** Время не задано в адресе — идём за текущим временем по Москве. */
  initialLive?: boolean;
  /** Правка графика возможна: пароль задан, хранилище есть. */
  editable?: boolean;
  /** Пароль на правку уже введён. */
  unlocked?: boolean;
}) {
  const [code, setCode] = useState(initialCode);
  const [minutes, setMinutes] = useState(initialMinutes);
  /**
   * «Сейчас»: время идёт за часами по Москве и обновляется раз в минуту, а в
   * адрес не пишется. Раньше в адрес писалось любое время, в том числе
   * текущее на момент выбора лавки, — и ссылка, открытая через полтора часа,
   * показывала красную черту на давно прошедшем 15:26. Выставили время руками —
   * оно замирает и попадает в адрес, кнопка «Сейчас» возвращает живое.
   */
  const [live, setLive] = useState(initialLive);
  useEffect(() => {
    if (!live) return;
    setMinutes(minutesNowMsk());
    const timer = window.setInterval(() => setMinutes(minutesNowMsk()), 30_000);
    return () => window.clearInterval(timer);
  }, [live]);
  const norm = code == null ? null : (norms.find((n) => n.code === code) ?? null);
  const shown = norm ? [norm] : norms;
  // Окна в шаблоне одни на все лавки — шапке таблицы годится любая.
  const head = norm ?? norms[0];
  const at = useMemo(() => (norm ? staffAt(norm, minutes) : staffAtAll(norms, minutes)), [norm, norms, minutes]);
  const total = at.reduce((a, r) => a + r.count, 0);
  const rates = [...new Set(STAFF_ROLES.map((r) => STAFF_HOURLY_RATE[r]))];
  const rateLabel =
    rates.length === 1
      ? `${rates[0]} ₽/ч`
      : `ставку должности (${rates.map((rate) => `${rate} ₽/ч — ${STAFF_ROLES.filter((r) => STAFF_HOURLY_RATE[r] === rate).map((r) => STAFF_ROLE_SHORT[r].toLowerCase()).join(', ')}`).join('; ')})`;

  const pick = (next: { code?: string | null; minutes?: number; live?: boolean }) => {
    const c = next.code !== undefined ? next.code : code;
    const m = next.minutes ?? minutes;
    const l = next.live ?? (next.minutes != null ? false : live);
    if (next.code !== undefined) setCode(next.code);
    if (next.minutes != null) setMinutes(next.minutes);
    setLive(l);
    const q = new URLSearchParams({ ...(c && { shop: c }), ...(!l && { time: formatClock(m) }) });
    window.history.replaceState(null, '', q.size ? `?${q}` : window.location.pathname);
  };

  return (
    <div className="flex flex-col gap-5">
      {/* --- калькулятор --- */}
      <section className="surface flex flex-col gap-4 p-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,18rem)_auto_1fr] sm:items-end">
          <label className="flex flex-col gap-1.5 text-xs muted">
            Лавка
            <select
              value={norm?.code ?? ''}
              onChange={(e) => pick({ code: e.target.value || null })}
              className="h-10 rounded-lg border px-2 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
            >
              <option value="">Все лавки</option>
              {norms.map((n) => (
                <option key={n.code} value={n.code}>
                  {n.code} {n.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs muted">
            Время
            <span className="flex gap-2">
              <input
                type="time"
                value={formatClock(minutes)}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number);
                  if (Number.isFinite(h) && Number.isFinite(m)) pick({ minutes: h * 60 + m });
                }}
                className="h-10 rounded-lg border px-2 text-sm tabular-nums"
                style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
              />
              <button
                type="button"
                onClick={() => pick({ minutes: minutesNowMsk(), live: true })}
                className="h-10 rounded-lg border px-3 text-sm whitespace-nowrap hover:opacity-80"
                style={{
                  borderColor: live ? 'var(--focus)' : 'var(--border)',
                  background: live ? 'color-mix(in srgb, var(--focus) 15%, var(--surface))' : 'var(--surface)',
                  color: 'var(--text)',
                }}
                aria-pressed={live}
                title={live ? 'Время идёт за часами по Москве' : 'Вернуться к текущему времени по Москве'}
              >
                Сейчас
              </button>
            </span>
          </label>
          <p className="text-xs muted sm:text-right">
            {norm ? (
              <>
                {norm.grade && <>Грейд {norm.grade} · </>}
                {norm.coffeeMachine == null ? 'кофемашина — не указано' : norm.coffeeMachine ? 'с кофемашиной' : 'без кофемашины'}
              </>
            ) : (
              `${norms.length} ${plural(norms.length, 'лавка', 'лавки', 'лавок')} в шаблоне`
            )}
          </p>
        </div>

        <div aria-live="polite">
          <p className="text-sm">
            В <span className="font-semibold tabular-nums">{formatClock(minutes)}</span>{' '}
            {norm ? (
              <>
                в{' '}
                <span className="font-semibold">
                  {norm.code} {norm.name}
                </span>
              </>
            ) : (
              <>
                во <span className="font-semibold">всех лавках</span>
              </>
            )}{' '}
            на смене должно быть{' '}
            <span className="font-semibold">
              {total} {plural(total, 'человек', 'человека', 'человек')}
            </span>
            {total > 0 && (
              <span className="muted">
                {': '}
                {at
                  .filter((a) => a.count > 0)
                  .map((a) => `${formatCount(a.count)} ${plural(a.count, ...STAFF_ROLE_FORMS[a.role])}`)
                  .join(', ')}
              </span>
            )}
            {total === 0 && <span className="muted"> — по шаблону в это время смены нет</span>}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
            {at.map((a) => {
              // Где эти люди стоят сейчас — дислокации окна, если лавку расписали.
              const posts = norm && a.slot ? norm.roles[a.role].posts?.[norm.roles[a.role].slots.indexOf(a.slot)] : undefined;
              return (
                <div key={a.role} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                  <div className="text-xs muted">{STAFF_ROLE_TITLE[a.role]}</div>
                  <div className={`mt-1 text-3xl font-semibold tabular-nums ${a.count === 0 ? 'muted' : ''}`}>
                    {formatCount(a.count)}
                  </div>
                  <div className="mt-0.5 text-xs muted">
                    {a.slot ? `окно ${slotLabel(a.slot)}` : 'вне окон шаблона'}
                  </div>
                  {posts && posts.length > 0 && <div className="mt-1.5 text-xs leading-snug">{postsLabel(posts)}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <StaffingLayout
        norm={norm}
        norms={norms}
        minutes={minutes}
        onPick={(c) => pick({ code: c })}
        editable={editable}
        unlocked={unlocked}
      />

      {/* --- шаблон целиком --- */}
      <section className="flex flex-col gap-2">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Шаблон по часам-пикам</h2>
            {/* Обычные ссылки, а не кнопки с JS: файлы собираются на сервере и
                должны скачиваться, даже если скрипты не загрузились. Выгружают
                то же, что в таблице: всю сеть или выбранную лавку. */}
            <div className="flex gap-2">
              {(['xlsx', 'pdf'] as const).map((ext) => (
                <a
                  key={ext}
                  href={`/api/staffing/${ext}${norm ? `?${new URLSearchParams({ shop: norm.code })}` : ''}`}
                  className="rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap hover:opacity-90"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                  title={
                    ext === 'xlsx'
                      ? 'Таблица Excel: люди и рубли по окнам, данные для сводных'
                      : 'PDF для чтения и печати: график дня, итоги и окна по должностям'
                  }
                >
                  ⬇ {ext === 'xlsx' ? 'Excel' : 'PDF'}
                  <span className="muted"> · {norm ? norm.code : 'все лавки'}</span>
                </a>
              ))}
            </div>
          </div>
          <p className="mt-0.5 text-xs muted">
            Сколько человек должно быть на смене в каждом окне, а под ними — сколько они заработают, ₽: человек ×
            часы × {rateLabel}. Подсвечены окна, в которые попадает {formatClock(minutes)}. Клик по строке оставит в
            таблице одну эту лавку, вернуть всю сеть — «Все лавки» в фильтре. FTE — итого по штату, ч/мес и ч/день —
            человеко-часы: за день по окнам, за месяц — день × {MONTH_DAYS}. Замы — по одному в лавке,
            по бару 6:30–18:00, по залу 6:30–23:00, сборщик — по ШР, 7:00–16:00; под числом у них заработок за день.
          </p>
        </div>
        <div className="surface radar-scroll staffing-scroll">
          <table className="radar-table staffing-table w-full text-sm">
            <caption className="sr-only">График пиков: норма выхода сотрудников по лавкам и часовым окнам</caption>
            <thead>
              <tr>
                <th rowSpan={2} className="radar-sticky px-2 py-2 text-left text-xs font-medium muted">
                  Лавка
                </th>
                {TEMPLATE_ROLES.map((role) => (
                  <th
                    key={role}
                    colSpan={head.roles[role].slots.length + 3}
                    className="px-2 pt-2 text-center text-xs font-semibold"
                    style={{ borderLeft: '1px solid var(--border)' }}
                  >
                    {STAFF_ROLE_TITLE[role]}
                  </th>
                ))}
                <th
                  colSpan={EXTRA_ROLES.length}
                  className="px-2 pt-2 text-center text-xs font-semibold whitespace-nowrap"
                  style={{ borderLeft: '1px solid var(--border)' }}
                >
                  Замы и сборщик
                </th>
              </tr>
              <tr>
                {TEMPLATE_ROLES.flatMap((role) => {
                  const slots = head.roles[role].slots;
                  const active = slotAt(slots, minutes);
                  return [
                    ...slots.map((s, i) => {
                      // «6:30–7:30» в две строки, начало над концом: в одну строку шапка
                      // из 24 окон не влезает в экран.
                      const [from, to] = slotShortLabel(s).split('–');
                      return (
                        <th
                          key={`${role}-${i}`}
                          className="px-[2px] py-1 text-center text-[11px] leading-tight font-medium whitespace-nowrap muted"
                          style={{
                            ...(i === 0 && { borderLeft: '1px solid var(--border)' }),
                            ...(s === active && { background: ACTIVE_COLUMN, color: 'var(--text)' }),
                          }}
                        >
                          {to == null ? (
                            from
                          ) : (
                            <>
                              {from}
                              <br />
                              {to}
                            </>
                          )}
                        </th>
                      );
                    }),
                    <th key={`${role}-fte`} className="px-[2px] py-1 text-center text-[11px] font-medium muted">
                      <Hint text="Итого по штату" below>
                        FTE
                      </Hint>
                    </th>,
                    <th key={`${role}-h`} className="px-[2px] py-1 text-center text-[11px] font-medium whitespace-nowrap muted">
                      <Hint text={MONTH_HINT} below>
                        ч/мес
                      </Hint>
                    </th>,
                    <th key={`${role}-d`} className="px-[2px] py-1 text-center text-[11px] font-medium whitespace-nowrap muted">
                      <Hint text={DAY_HINT} below>
                        ч/день
                      </Hint>
                    </th>,
                  ];
                })}
                {/* У замов и сборщика окно одно на весь день — по колонке на должность. */}
                {EXTRA_ROLES.map((role, i) => {
                  const s = head.roles[role].slots[0];
                  const on = slotAt([s], minutes) != null;
                  return (
                    <th
                      key={role}
                      className="px-[2px] py-1 text-center text-[11px] leading-tight font-medium whitespace-nowrap muted"
                      style={{
                        ...(i === 0 && { borderLeft: '1px solid var(--border)' }),
                        ...(on && { background: ACTIVE_COLUMN, color: 'var(--text)' }),
                      }}
                    >
                      <Hint text={`${STAFF_ROLE_TITLE[role]}: ${slotLabel(s)}, ${STAFF_HOURLY_RATE[role]} ₽/ч. Под числом — заработок за день, ₽`} below>
                        {EXTRA_HEAD[role][0]}
                        <br />
                        {EXTRA_HEAD[role][1]}
                      </Hint>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((n) => {
                const selected = n.code === norm?.code;
                return (
                  <tr
                    key={n.code}
                    onClick={() => pick({ code: n.code })}
                    className="cursor-pointer"
                  >
                    <td className="radar-sticky px-2 py-1 whitespace-nowrap" style={selected ? { background: SELECTED_ROW } : undefined}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          pick({ code: n.code });
                        }}
                        aria-current={selected ? 'true' : undefined}
                        title={`${n.code} ${n.name}`}
                        // Длинное название («Даниловская мануфактура») раздувало колонку на
                        // сотню пикселей, и таблица не влезала в экран — режем многоточием.
                        className={`block max-w-[7.5rem] truncate text-left hover:underline ${selected ? 'font-semibold' : ''}`}
                      >
                        {n.code} {n.name}
                      </button>
                      {/* Грейд — под названием, а не отдельной колонкой: строка и так в два этажа, а колонка съедала ширину. */}
                      {n.grade && <div className="text-[10px] muted">{n.grade}</div>}
                    </td>
                    {TEMPLATE_ROLES.flatMap((role) => {
                      const r = n.roles[role];
                      const rate = STAFF_HOURLY_RATE[role];
                      const active = slotAt(r.slots, minutes);
                      const day = dailyHours(r.slots);
                      const month = monthlyHours(r.slots);
                      return [
                        ...r.slots.map((s, i) => (
                          <td
                            key={`${role}-${i}`}
                            className={`px-[2px] py-1 text-center text-xs whitespace-nowrap tabular-nums ${s.count === 0 ? 'muted' : ''}`}
                            style={{
                              ...(i === 0 && { borderLeft: '1px solid var(--border)' }),
                              ...(selected && { background: SELECTED_ROW }),
                              ...(s === active && { background: selected ? SELECTED_CELL : ACTIVE_COLUMN, fontWeight: 600 }),
                            }}
                          >
                            {formatCount(s.count)}
                            <Rub value={pay(slotPersonHours(s), rate)} />
                          </td>
                        )),
                        <td
                          key={`${role}-fte`}
                          className="px-[2px] py-1 text-center text-xs tabular-nums muted"
                          style={selected ? { background: SELECTED_ROW } : undefined}
                        >
                          {r.fte == null ? '—' : formatCount(r.fte)}
                        </td>,
                        <td
                          key={`${role}-h`}
                          className="px-[2px] py-1 text-center text-xs whitespace-nowrap tabular-nums muted"
                          style={selected ? { background: SELECTED_ROW } : undefined}
                        >
                          {month == null ? '—' : formatCount(month)}
                          <Rub value={pay(month, rate)} />
                        </td>,
                        <td
                          key={`${role}-d`}
                          className="px-[2px] py-1 text-center text-xs whitespace-nowrap tabular-nums muted"
                          style={selected ? { background: SELECTED_ROW } : undefined}
                        >
                          {day == null ? '—' : formatCount(day)}
                          <Rub value={pay(day, rate)} />
                        </td>,
                      ];
                    })}
                    {EXTRA_ROLES.map((role, i) => {
                      const s = n.roles[role].slots[0];
                      const on = slotAt([s], minutes) != null;
                      return (
                        <td
                          key={role}
                          className={`px-[2px] py-1 text-center text-xs whitespace-nowrap tabular-nums ${s.count === 0 ? 'muted' : ''}`}
                          style={{
                            ...(i === 0 && { borderLeft: '1px solid var(--border)' }),
                            ...(selected && { background: SELECTED_ROW }),
                            ...(on && { background: selected ? SELECTED_CELL : ACTIVE_COLUMN, fontWeight: 600 }),
                          }}
                        >
                          {formatCount(s.count)}
                          <Rub value={pay(slotPersonHours(s), STAFF_HOURLY_RATE[role])} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/**
 * Шапка колонок замов и сборщика — в две строки, а окно — в подсказке и в
 * подписи над таблицей: «ЗД бар 6:30–18» в одну строку раздвигал таблицу
 * за край экрана в 1440 px.
 */
const EXTRA_HEAD: Record<(typeof EXTRA_ROLES)[number], [string, string]> = {
  barDeputy: ['ЗД', 'бар'],
  hallDeputy: ['ЗД', 'зал'],
  picker: ['Сбор-', 'щик'],
};

/**
 * Подложка окна, в которое попало выбранное время. Непрозрачная: шапка с
 * окнами липнет к верху рамки, и сквозь прозрачную проступали бы строки,
 * уехавшие под неё.
 */
const ACTIVE_COLUMN = 'color-mix(in srgb, var(--focus) 10%, var(--surface))';

/**
 * Подложка выбранной лавки. Непрозрачная: колонка с названием липнет к краю,
 * и сквозь прозрачную проступали бы цифры, уехавшие под неё. Рамка на строке
 * не годилась по той же причине — липкая ячейка её перекрывала.
 */
const SELECTED_ROW = 'color-mix(in srgb, var(--focus) 12%, var(--surface))';
const SELECTED_CELL = 'color-mix(in srgb, var(--focus) 26%, var(--surface))';

/**
 * Подсказки к человеко-часам. День — сумма по окнам, её можно проверить по
 * строке глазами; месяц — день × 31. Колонку «ЧЕЛ-КО часы» из шаблона не
 * показываем: она посчитана не от длины окон (см. StaffRoleNorm.hours).
 */
const MONTH_HINT = `Человеко-часы в месяц: «ч/день» × ${MONTH_DAYS}, как в шаблоне, под ними — они же в рублях. Число из колонки шаблона не берём — оно посчитано не от длины окон`;
const DAY_HINT = 'Человеко-часы в день по окнам: сколько человек в окне × длина окна в часах, сложено за смену. Под ними — они же в рублях';

/**
 * Вторая строка клетки — рубли. Знак ₽ не пишем: в каждой из 36 клеток он
 * съедал ширину, а таблица должна влезать в экран; что это рубли — в подписи.
 */
function Rub({ value }: { value: number | null }) {
  return <div className="text-[10px] leading-tight font-normal muted">{value == null ? '—' : formatRub(value)}</div>;
}

/**
 * 595820 → «595 820» через узкий неразрывный пробел, а четырёхзначные — слитно,
 * «1860», как и принято в русском наборе. Тут это не только типографика: в
 * узких колонках окон «1 860 3 720» читалось бы одним числом — пробел внутри
 * числа почти не отличим от зазора между колонками.
 *
 * Не toLocaleString: на сервере и в браузере разделитель разряда бывает
 * разный (U+00A0 и U+202F), и React ругался бы на расхождение разметки.
 */
function formatRub(n: number): string {
  return Math.abs(n) < 10_000 ? String(n) : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
}

/** Дробные бывают у FTE (0,5 ставки) и у часов в день — пишем через запятую. */
function formatCount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}
