'use client';

import { useMemo, useState } from 'react';
import {
  STAFF_ROLES,
  STAFF_ROLE_FORMS,
  STAFF_ROLE_TITLE,
  slotAt,
  slotLabel,
  slotShortLabel,
  staffAt,
  staffAtAll,
  type StaffNorm,
} from '@/lib/staffing';
import { formatClock, minutesNowMsk } from '@/lib/time';
import { plural } from '@/lib/plural';
import { Hint } from './Hint';

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
}: {
  norms: StaffNorm[];
  /** null — «Все лавки». */
  initialCode: string | null;
  initialMinutes: number;
}) {
  const [code, setCode] = useState(initialCode);
  const [minutes, setMinutes] = useState(initialMinutes);
  const norm = code == null ? null : (norms.find((n) => n.code === code) ?? null);
  const shown = norm ? [norm] : norms;
  // Окна в шаблоне одни на все лавки — шапке таблицы годится любая.
  const head = norm ?? norms[0];
  const at = useMemo(() => (norm ? staffAt(norm, minutes) : staffAtAll(norms, minutes)), [norm, norms, minutes]);
  const total = at.reduce((a, r) => a + r.count, 0);

  const pick = (next: { code?: string | null; minutes?: number }) => {
    const c = next.code !== undefined ? next.code : code;
    const m = next.minutes ?? minutes;
    if (next.code !== undefined) setCode(next.code);
    if (next.minutes != null) setMinutes(next.minutes);
    const q = new URLSearchParams(c ? { shop: c, time: formatClock(m) } : { time: formatClock(m) });
    window.history.replaceState(null, '', `?${q}`);
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
                onClick={() => pick({ minutes: minutesNowMsk() })}
                className="h-10 rounded-lg border px-3 text-sm whitespace-nowrap hover:opacity-80"
                style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                title="Текущее время по Москве"
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

          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {at.map((a) => (
              <div key={a.role} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="text-xs muted">{STAFF_ROLE_TITLE[a.role]}</div>
                <div className={`mt-1 text-3xl font-semibold tabular-nums ${a.count === 0 ? 'muted' : ''}`}>
                  {formatCount(a.count)}
                </div>
                <div className="mt-0.5 text-xs muted">
                  {a.slot ? `окно ${slotLabel(a.slot)}` : 'вне окон шаблона'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- шаблон целиком --- */}
      <section className="flex flex-col gap-2">
        <div>
          <h2 className="text-sm font-semibold">Шаблон по часам-пикам</h2>
          <p className="mt-0.5 text-xs muted">
            Сколько человек должно быть на смене в каждом окне. Подсвечены окна, в которые попадает{' '}
            {formatClock(minutes)}. Клик по строке оставит в таблице одну эту лавку, вернуть всю сеть — «Все
            лавки» в фильтре. FTE — итого по штату, чел.-ч — человеко-часов в месяц.
          </p>
        </div>
        <div className="surface radar-scroll staffing-scroll">
          <table className="radar-table staffing-table w-full text-sm">
            <caption className="sr-only">График пиков: норма выхода сотрудников по лавкам и часовым окнам</caption>
            <thead>
              <tr>
                <th rowSpan={2} className="radar-sticky px-3 py-2 text-left text-xs font-medium muted">
                  Лавка
                </th>
                <th rowSpan={2} className="hidden px-2 py-2 text-left text-xs font-medium muted md:table-cell">
                  Грейд
                </th>
                {STAFF_ROLES.map((role) => (
                  <th
                    key={role}
                    colSpan={head.roles[role].slots.length + 2}
                    className="px-2 pt-2 text-center text-xs font-semibold"
                    style={{ borderLeft: '1px solid var(--border)' }}
                  >
                    {STAFF_ROLE_TITLE[role]}
                  </th>
                ))}
              </tr>
              <tr>
                {STAFF_ROLES.flatMap((role) => {
                  const slots = head.roles[role].slots;
                  const active = slotAt(slots, minutes);
                  return [
                    ...slots.map((s, i) => (
                      <th
                        key={`${role}-${i}`}
                        className="px-1.5 py-1.5 text-center text-[11px] font-medium whitespace-nowrap muted"
                        style={{
                          ...(i === 0 && { borderLeft: '1px solid var(--border)' }),
                          ...(s === active && { background: ACTIVE_COLUMN, color: 'var(--text)' }),
                        }}
                      >
                        {slotShortLabel(s)}
                      </th>
                    )),
                    <th key={`${role}-fte`} className="px-1.5 py-1.5 text-center text-[11px] font-medium muted">
                      <Hint text="Итого по штату" below>
                        FTE
                      </Hint>
                    </th>,
                    <th key={`${role}-h`} className="px-1.5 py-1.5 text-center text-[11px] font-medium whitespace-nowrap muted">
                      чел.-ч
                    </th>,
                  ];
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
                    <td className="radar-sticky px-3 py-1 whitespace-nowrap" style={selected ? { background: SELECTED_ROW } : undefined}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          pick({ code: n.code });
                        }}
                        aria-current={selected ? 'true' : undefined}
                        className={`text-left hover:underline ${selected ? 'font-semibold' : ''}`}
                      >
                        {n.code} {n.name}
                      </button>
                    </td>
                    <td
                      className="hidden px-2 py-1 text-xs whitespace-nowrap muted md:table-cell"
                      style={selected ? { background: SELECTED_ROW } : undefined}
                    >
                      {n.grade ?? '—'}
                    </td>
                    {STAFF_ROLES.flatMap((role) => {
                      const r = n.roles[role];
                      const active = slotAt(r.slots, minutes);
                      return [
                        ...r.slots.map((s, i) => (
                          <td
                            key={`${role}-${i}`}
                            className={`px-1.5 py-1 text-center text-xs tabular-nums ${s.count === 0 ? 'muted' : ''}`}
                            style={{
                              ...(i === 0 && { borderLeft: '1px solid var(--border)' }),
                              ...(selected && { background: SELECTED_ROW }),
                              ...(s === active && { background: selected ? SELECTED_CELL : ACTIVE_COLUMN, fontWeight: 600 }),
                            }}
                          >
                            {formatCount(s.count)}
                          </td>
                        )),
                        <td
                          key={`${role}-fte`}
                          className="px-1.5 py-1 text-center text-xs tabular-nums muted"
                          style={selected ? { background: SELECTED_ROW } : undefined}
                        >
                          {r.fte == null ? '—' : formatCount(r.fte)}
                        </td>,
                        <td
                          key={`${role}-h`}
                          className="px-1.5 py-1 text-center text-xs tabular-nums muted"
                          style={selected ? { background: SELECTED_ROW } : undefined}
                        >
                          {r.hours == null ? '—' : r.hours}
                        </td>,
                      ];
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

/** Дробные бывают только FTE (0,5 ставки) — пишем через запятую. */
function formatCount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}
