'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  STAFF_ROLE_TITLE,
  TEMPLATE_ROLES,
  hasLayout,
  offText,
  parsePosts,
  postsHeadcount,
  postsLabel,
  slotAt,
  slotLabel,
  slotShortLabel,
  type StaffNorm,
  type StaffRole,
  type StaffSlot,
} from '@/lib/staffing';
import { formatClock, formatMoment } from '@/lib/time';
import { plural } from '@/lib/plural';

/**
 * Расстановка по дислокациям: кто из смены где стоит в каждом окне — «1 касса,
 * 2 прием», «1 кулинария, хлебка». Берётся из строк под лавкой в шаблоне (см.
 * parsers/staffing.ts) и из правок на сайте (staffing-edits.ts).
 *
 * Показ — таймлайном: сверху общая шкала часов, окно каждой должности — блок
 * ровно под своим временем, красная черта — выбранное время. В карточках
 * подряд время читалось плохо: окна у должностей разные, и «16:00–17:30» у
 * кассира стояло под «16:00–18:00» повара как будто это одно и то же.
 *
 * Только для одной лавки: расстановка у каждой своя. На «Все лавки» — список
 * расписанных лавок, клик выбирает лавку.
 *
 * Правка — под своим паролем (RADAR_STAFFING_PASSWORD): числа в окнах и посты.
 */
export function StaffingLayout({
  norm,
  norms,
  minutes,
  onPick,
  editable,
  unlocked,
}: {
  norm: StaffNorm | null;
  norms: StaffNorm[];
  minutes: number;
  onPick: (code: string) => void;
  /** Правка вообще возможна: пароль задан, хранилище есть. */
  editable: boolean;
  /** Пароль на правку уже введён. */
  unlocked: boolean;
}) {
  const [editing, setEditing] = useState(false);

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
              title={`${n.code} ${n.name}${n.editedAt ? ' · правили на сайте' : ''}`}
              className="rounded-md border px-2 py-1 text-xs tabular-nums hover:opacity-80"
              style={{ borderColor: n.editedAt ? 'var(--focus)' : 'var(--border)' }}
            >
              {n.code}
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="surface flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Расстановка по дислокациям</h2>
          <p className="mt-0.5 text-xs muted">
            Кто где стоит в каждом окне. Красная черта — {formatClock(minutes)}. Кондитерка и кулинария — одно место.
            {norm.editedAt && <> Правили на сайте {formatMoment(norm.editedAt)}.</>}
            {!hasLayout(norm) && <> Расстановку для этой лавки ещё не прислали — в шаблоне под ней пусто.</>}
          </p>
        </div>
        {editable && !editing && <EditButton unlocked={unlocked} onEdit={() => setEditing(true)} />}
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

      {editing && unlocked ? (
        <EditForm norm={norm} onDone={() => setEditing(false)} />
      ) : (
        <Timeline norm={norm} minutes={minutes} />
      )}
    </section>
  );
}

/**
 * Порядок строк: замы сверху — они на смене весь день и держат кассу, —
 * дальше должности шаблона, сборщик внизу.
 */
const ORDER: readonly StaffRole[] = ['barDeputy', 'hallDeputy', ...TEMPLATE_ROLES, 'picker'];

const STEP = 30;

function visibleRoles(norm: StaffNorm): StaffRole[] {
  return ORDER.filter((role) => {
    const r = norm.roles[role];
    return r.slots.some((s) => s.count > 0) || r.posts?.some((p) => p.length > 0);
  });
}

/* -------------------------------- таймлайн -------------------------------- */

function Timeline({ norm, minutes }: { norm: StaffNorm; minutes: number }) {
  const roles = visibleRoles(norm);
  const slots = roles.flatMap((r) => norm.roles[r].slots);
  if (slots.length === 0) return <p className="text-xs muted">По шаблону в этой лавке никого.</p>;

  const start = Math.floor(Math.min(...slots.map((s) => s.from ?? s.to - STEP)) / STEP) * STEP;
  const end = Math.ceil(Math.max(...slots.map((s) => s.to)) / STEP) * STEP;
  const steps = (end - start) / STEP;
  const col = (m: number) => 2 + (m - start) / STEP;
  const hours = Array.from({ length: Math.floor(end / 60) - Math.ceil(start / 60) + 1 }, (_, i) => Math.ceil(start / 60) + i);
  const now = minutes >= start && minutes <= end ? (minutes - start) / (end - start) : null;

  return (
    // Шире экрана телефона таблица времени не читается — там прокрутка вбок.
    <div className="overflow-x-auto">
      <div
        className="relative grid gap-y-1.5"
        style={{ gridTemplateColumns: `7.5rem repeat(${steps}, minmax(0, 1fr))`, minWidth: '56rem' }}
      >
        {/* шкала часов */}
        {hours.map((h) => (
          <div
            key={h}
            className="border-l pl-1 text-[11px] font-semibold tabular-nums"
            style={{ gridRow: 1, gridColumn: `${col(h * 60)} / span 2`, borderColor: 'var(--border)' }}
          >
            {h}:00
          </div>
        ))}

        {roles.map((role, row) => (
          <RoleRow key={role} norm={norm} role={role} row={row + 2} col={col} minutes={minutes} />
        ))}

        {now != null && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-0.5"
            style={{ left: `calc(7.5rem + (100% - 7.5rem) * ${now})`, background: 'var(--red)' }}
          />
        )}
      </div>
    </div>
  );
}

function RoleRow({
  norm,
  role,
  row,
  col,
  minutes,
}: {
  norm: StaffNorm;
  role: StaffRole;
  row: number;
  col: (m: number) => number;
  minutes: number;
}) {
  const r = norm.roles[role];
  const active = slotAt(r.slots, minutes);
  return (
    <>
      <div className="pr-2 pt-1.5 text-sm font-medium" style={{ gridRow: row, gridColumn: 1 }}>
        {STAFF_ROLE_TITLE[role]}
      </div>
      {r.slots.map((slot, i) => {
        const posts = r.posts?.[i] ?? [];
        // Пустое окно («0 чел., никого») блоком не рисуем: оно только
        // занимало место и отвлекало от тех окон, где люди есть.
        if (slot.count === 0 && posts.length === 0) return null;
        return (
          <Block
            key={i}
            slot={slot}
            posts={posts}
            role={role}
            active={slot === active}
            style={{ gridRow: row, gridColumn: `${col(slot.from ?? slot.to - STEP)} / ${col(slot.to)}` }}
          />
        );
      })}
    </>
  );
}

/**
 * Блок окна. Читается сверху вниз: время окна, сколько человек — плашкой, и
 * посты, где число людей выделено жирным: «**4** линия». Шрифт крупнее, чем
 * в остальной таблице, — это главное, ради чего блок открывают.
 */
function Block({
  slot,
  posts,
  role,
  active,
  style,
}: {
  slot: StaffSlot;
  posts: { count: number | null; place: string }[];
  role: StaffRole;
  active: boolean;
  style: React.CSSProperties;
}) {
  const counted = postsHeadcount(posts, role);
  const off = counted != null && counted !== slot.count;
  return (
    <div
      className="mx-0.5 flex min-w-0 flex-col gap-1 rounded-lg border px-2 py-1.5 text-[13px] leading-snug"
      title={`${slotLabel(slot)} · ${slot.count} чел.${posts.length ? ` · ${postsLabel(posts)}` : ''}`}
      style={{
        ...style,
        borderColor: off ? 'var(--red)' : active ? 'var(--focus)' : 'var(--border)',
        borderWidth: off ? 2 : 1,
        ...(active && { background: ACTIVE }),
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <span className="font-bold tabular-nums" style={{ color: 'var(--text)' }}>
          {slotShortLabel(slot)}
        </span>
        <span
          className="rounded px-1.5 py-px text-xs font-bold tabular-nums"
          style={{ background: COUNT_BG, color: 'var(--text)' }}
        >
          {slot.count} чел.
        </span>
      </div>
      {posts.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {posts.map((p, k) => (
            <li key={k} style={{ color: 'var(--text)' }}>
              {p.count != null && <b className="tabular-nums">{p.count} </b>}
              {p.place}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs italic muted">не расписано</div>
      )}
      {off && (
        <div className="text-xs font-bold" style={{ color: 'var(--red)' }}>
          {offText(counted, slot.count)}
        </div>
      )}
    </div>
  );
}

/** Плашка «5 чел.»: заметна и в светлой, и в тёмной теме. */
const COUNT_BG = 'color-mix(in srgb, var(--text) 10%, transparent)';

/** Окно, в которое попадает время: та же подложка, что у столбца в таблице. */
const ACTIVE = 'color-mix(in srgb, var(--focus) 12%, var(--surface))';

/* --------------------------------- правка --------------------------------- */

function EditButton({ unlocked, onEdit }: { unlocked: boolean; onEdit: () => void }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (unlocked) {
    return (
      <button type="button" onClick={onEdit} className={BUTTON} style={BUTTON_STYLE}>
        ✎ Править
      </button>
    );
  }
  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)} className={BUTTON} style={BUTTON_STYLE}>
        ✎ Править
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await fetch('/api/staffing/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        setBusy(false);
        if (!data.ok) {
          setError(data.error ?? 'Не вышло войти');
          return;
        }
        onEdit();
        router.refresh();
      }}
    >
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Пароль на правку"
        className="h-8 w-40 rounded-md border px-2 text-xs"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
      />
      <button type="submit" disabled={busy} className={BUTTON} style={BUTTON_STYLE}>
        Войти
      </button>
      {error && <span className="text-xs" style={{ color: 'var(--red)' }}>{error}</span>}
    </form>
  );
}

/**
 * Форма правки: по каждой должности окна — число людей и посты, пост на
 * строку («2 прием», «1 кулинария, хлебка»). Сохраняется лавка целиком;
 * «Вернуть шаблон» стирает правку, и лавка снова идёт по шаблону.
 */
function EditForm({ norm, onDone }: { norm: StaffNorm; onDone: () => void }) {
  const router = useRouter();
  const roles = ORDER;
  const [counts, setCounts] = useState(() =>
    Object.fromEntries(roles.map((r) => [r, norm.roles[r].slots.map((s) => String(s.count))])) as Record<StaffRole, string[]>,
  );
  const [texts, setTexts] = useState(() =>
    Object.fromEntries(
      roles.map((r) => [
        r,
        norm.roles[r].slots.map((_, i) =>
          (norm.roles[r].posts?.[i] ?? []).map((p) => (p.count == null ? p.place : `${p.count} ${p.place}`)).join('\n'),
        ),
      ]),
    ) as Record<StaffRole, string[]>,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    setError(null);
    const res = await fetch(
      method === 'DELETE' ? `/api/staffing/edits?${new URLSearchParams({ shop: norm.code })}` : '/api/staffing/edits',
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' && {
          body: JSON.stringify({
            shop: norm.code,
            roles: Object.fromEntries(
              roles.map((r) => [
                r,
                {
                  counts: counts[r].map((c) => Number(c || 0)),
                  // Пост на строку; «/» внутри строки тоже делит людей, как в шаблоне.
                  posts: texts[r].map((t) => t.split('\n').flatMap((line) => parsePosts(line))),
                },
              ]),
            ),
          }),
        }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (!data.ok) {
      setError(data.error ?? 'Не сохранилось');
      return;
    }
    onDone();
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs muted">
        Число — сколько человек должно быть в окне по норме (меняет и таблицу ниже). Посты — по одному на строку:
        «2 прием», «1 кулинария, хлебка».
      </p>
      {roles.map((role) => (
        <div key={role} className="grid gap-2 sm:grid-cols-[8rem_1fr] sm:items-start">
          <div className="pt-1 text-sm font-medium">{STAFF_ROLE_TITLE[role]}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {norm.roles[role].slots.map((slot, i) => (
              <label key={i} className="flex flex-col gap-1 rounded-md border p-1.5 text-xs" style={{ borderColor: 'var(--border)' }}>
                <span className="flex items-center justify-between gap-1">
                  <span className="font-semibold tabular-nums">{slotLabel(slot)}</span>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={counts[role][i]}
                    onChange={(e) => setCounts((c) => ({ ...c, [role]: c[role].map((v, k) => (k === i ? e.target.value : v)) }))}
                    className="h-7 w-14 rounded border px-1 text-right tabular-nums"
                    style={INPUT_STYLE}
                    aria-label={`${STAFF_ROLE_TITLE[role]} ${slotLabel(slot)}: человек`}
                  />
                </span>
                <textarea
                  rows={3}
                  value={texts[role][i]}
                  onChange={(e) => setTexts((t) => ({ ...t, [role]: t[role].map((v, k) => (k === i ? e.target.value : v)) }))}
                  placeholder="пост на строку"
                  className="w-full rounded border px-1 py-0.5"
                  style={INPUT_STYLE}
                  aria-label={`${STAFF_ROLE_TITLE[role]} ${slotLabel(slot)}: посты`}
                />
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => send('POST')} className={BUTTON} style={{ ...BUTTON_STYLE, background: 'var(--focus)', color: '#fff' }}>
          Сохранить
        </button>
        <button type="button" disabled={busy} onClick={onDone} className={BUTTON} style={BUTTON_STYLE}>
          Отмена
        </button>
        {norm.editedAt && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Вернуть ${norm.code} к шаблону? Правки сайта по этой лавке сотрутся.`)) send('DELETE');
            }}
            className={BUTTON}
            style={BUTTON_STYLE}
          >
            Вернуть шаблон
          </button>
        )}
        {error && <span className="text-xs" style={{ color: 'var(--red)' }}>{error}</span>}
      </div>
    </div>
  );
}

const BUTTON = 'h-8 rounded-md border px-3 text-xs font-medium whitespace-nowrap hover:opacity-90 disabled:opacity-50';
const BUTTON_STYLE = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' };
const INPUT_STYLE = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' };
