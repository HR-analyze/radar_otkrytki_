'use client';

import {
  STAFF_ROLES,
  STAFF_ROLE_TITLE,
  hasLayout,
  offText,
  postsHeadcount,
  postsLabel,
  slotAt,
  slotLabel,
  type StaffNorm,
} from '@/lib/staffing';
import { formatClock } from '@/lib/time';
import { plural } from '@/lib/plural';

/**
 * Расстановка по дислокациям: кто из смены где стоит в каждом окне — «1 касса,
 * 2 прием», «1 кулинария, хлебка». Берётся из строк под лавкой в шаблоне (см.
 * parsers/staffing.ts), «кондитерка» там уже приведена к «кулинарии».
 *
 * Только для одной лавки: расстановка у каждой своя, и по сети это 60 таблиц.
 * На «Все лавки» — список расписанных лавок, клик выбирает лавку.
 *
 * Не сходится число людей в расстановке с нормой — пишем «расписано 2 из 4»:
 * часто расписывают только часть смены (у поваров — одних «на разогреве»),
 * и это видно сразу, а не при сверке с Excel.
 */
export function StaffingLayout({
  norm,
  norms,
  minutes,
  onPick,
}: {
  norm: StaffNorm | null;
  norms: StaffNorm[];
  minutes: number;
  onPick: (code: string) => void;
}) {
  if (!norm) {
    const laid = norms.filter(hasLayout);
    return (
      <section className="surface flex flex-col gap-2 p-4">
        <h2 className="text-sm font-semibold">Расстановка по дислокациям</h2>
        <p className="text-xs muted">
          Кто где стоит в каждом окне. Расписана у {laid.length} из {norms.length}{' '}
          {plural(norms.length, 'лавки', 'лавок', 'лавок')} — выберите лавку:
        </p>
        <div className="flex flex-wrap gap-1.5">
          {laid.map((n) => (
            <button
              key={n.code}
              type="button"
              onClick={() => onPick(n.code)}
              title={`${n.code} ${n.name}`}
              className="rounded-md border px-2 py-1 text-xs tabular-nums hover:opacity-80"
              style={{ borderColor: 'var(--border)' }}
            >
              {n.code}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (!hasLayout(norm)) {
    return (
      <section className="surface flex flex-col gap-1 p-4">
        <h2 className="text-sm font-semibold">Расстановка по дислокациям</h2>
        <p className="text-xs muted">
          Для {norm.code} {norm.name} расстановку ещё не прислали: в шаблоне под лавкой пусто.
        </p>
      </section>
    );
  }

  const roles = STAFF_ROLES.filter((role) => {
    const r = norm.roles[role];
    return r.slots.some((s) => s.count > 0) || r.posts?.some((p) => p.length > 0);
  });

  return (
    <section className="surface flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">Расстановка по дислокациям</h2>
        <p className="mt-0.5 text-xs muted">
          Кто где стоит в каждом окне — как расписано в шаблоне. Подсвечено окно, в которое попадает{' '}
          {formatClock(minutes)}. Кондитерка и кулинария — одно место.
        </p>
      </div>

      {norm.layout && (norm.layout.stations.length > 0 || norm.layout.remarks.length > 0) && (
        <div className="flex flex-col gap-0.5 text-xs">
          {norm.layout.stations.length > 0 && (
            <p>
              <span className="muted">Рабочие места: </span>
              {postsLabel(norm.layout.stations)}
            </p>
          )}
          {norm.layout.remarks.map((r) => (
            <p key={r}>
              <span className="muted">Пометка: </span>
              {r}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {roles.map((role) => {
          const r = norm.roles[role];
          const active = slotAt(r.slots, minutes);
          return (
            <div key={role} className="grid gap-2 sm:grid-cols-[8rem_1fr] sm:items-start">
              <div className="pt-1.5 text-sm font-medium">{STAFF_ROLE_TITLE[role]}</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {r.slots.map((slot, i) => {
                  const posts = r.posts?.[i] ?? [];
                  const counted = postsHeadcount(posts, role);
                  const off = counted != null && counted !== slot.count;
                  return (
                    <div
                      key={i}
                      className="rounded-lg border px-2.5 py-2 text-xs"
                      style={{
                        borderColor: 'var(--border)',
                        ...(slot === active && { background: ACTIVE }),
                      }}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="muted tabular-nums">{slotLabel(slot)}</span>
                        <span className={`font-semibold tabular-nums ${slot.count === 0 ? 'muted' : ''}`}>
                          {slot.count} чел.
                        </span>
                      </div>
                      {posts.length > 0 ? (
                        <ul className="mt-1 flex flex-col gap-0.5 leading-snug">
                          {posts.map((p, k) => (
                            <li key={k}>{p.count == null ? p.place : `${p.count} ${p.place}`}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-1 muted">{slot.count === 0 ? 'никого' : 'не расписано'}</div>
                      )}
                      {off && (
                        <div className="mt-1" style={{ color: OFF }}>
                          {offText(counted, slot.count)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Окно, в которое попадает время: та же подложка, что у столбца в таблице. */
const ACTIVE = 'color-mix(in srgb, var(--focus) 10%, var(--surface))';

/** Расстановка не сходится с нормой — янтарный, читается в обеих темах. */
const OFF = '#d97706';
