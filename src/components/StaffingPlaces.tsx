'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { STAFF_ROLE_SHORT } from '@/lib/staffing';
import type { PlaceSource, PlaceUsage } from '@/lib/staffing-places';
import { plural } from '@/lib/plural';
import { EditButton } from './StaffingLayout';

export interface PlaceRow extends PlaceUsage {
  /** Единое название сейчас — с учётом словаря по умолчанию и правок сайта. */
  name: string;
  /** Строку правили на сайте (иначе — словарь по умолчанию или как написано). */
  fromSite: boolean;
}

const SOURCE_LABEL = (s: PlaceSource) => (s === 'stations' ? 'места лавки' : STAFF_ROLE_SHORT[s].toLowerCase());

/**
 * Таблица функционалов: строки сгруппированы по единому названию, в группе —
 * все его написания. В правке у каждого написания поле «единое название», а
 * у группы — поле, которое переименовывает её целиком.
 *
 * Группы строятся по сохранённым названиям, а не по черновику: иначе строка
 * прыгала бы в другую группу на каждую набранную букву.
 */
export function StaffingPlaces({
  rows,
  shopCount,
  editable,
  unlocked,
}: {
  rows: PlaceRow[];
  shopCount: number;
  editable: boolean;
  unlocked: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const by = new Map<string, PlaceRow[]>();
    for (const r of rows) by.set(r.name.toLowerCase(), [...(by.get(r.name.toLowerCase()) ?? []), r]);
    return [...by.values()]
      .map((list) => {
        const sorted = [...list].sort((a, b) => b.uses - a.uses);
        const shops = new Set(sorted.flatMap((r) => r.shops));
        return { name: sorted[0].name, rows: sorted, uses: sorted.reduce((s, r) => s + r.uses, 0), shops: shops.size };
      })
      .sort((a, b) => b.uses - a.uses);
  }, [rows]);

  const q = query.trim().toLowerCase();
  const shown = q
    ? groups.filter((g) => g.name.toLowerCase().includes(q) || g.rows.some((r) => r.place.toLowerCase().includes(q)))
    : groups;
  const names = useMemo(() => [...new Set(groups.map((g) => g.name))].sort((a, b) => a.localeCompare(b, 'ru')), [groups]);

  const value = (r: PlaceRow) => draft[r.key] ?? r.name;
  const changed = rows.filter((r) => draft[r.key] != null && draft[r.key].trim() !== r.name);

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/staffing/places', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases: changed.map((r) => ({ place: r.place, name: draft[r.key].trim() })) }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (!data.ok) {
      setError(data.error ?? 'Не сохранилось');
      return;
    }
    setDraft({});
    setEditing(false);
    router.refresh();
  };

  const variants = rows.length;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-semibold tabular-nums">{variants}</span> {plural(variants, 'написание', 'написания', 'написаний')}{' '}
          → <span className="font-semibold tabular-nums">{groups.length}</span>{' '}
          {plural(groups.length, 'функционал', 'функционала', 'функционалов')} по {shopCount}{' '}
          {plural(shopCount, 'лавке', 'лавкам', 'лавкам')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти функционал"
            className="h-8 w-48 rounded-md border px-2 text-xs"
            style={INPUT_STYLE}
          />
          {editable && !editing && <EditButton unlocked={unlocked} onEdit={() => setEditing(true)} />}
          {editing && (
            <>
              <button
                type="button"
                disabled={busy || changed.length === 0}
                onClick={save}
                className={BUTTON}
                style={{ ...BUTTON_STYLE, background: 'var(--focus)', color: '#fff' }}
              >
                Сохранить{changed.length > 0 && ` (${changed.length})`}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft({});
                  setEditing(false);
                  setError(null);
                }}
                className={BUTTON}
                style={BUTTON_STYLE}
              >
                Отмена
              </button>
            </>
          )}
          {error && (
            <span className="text-xs" style={{ color: 'var(--red)' }}>
              {error}
            </span>
          )}
        </div>
      </div>

      {editing && (
        <p className="text-xs muted">
          Впишите единое название справа от написания или выберите из списка. Поле в строке группы переименовывает все её
          написания сразу. Пустое поле — оставить как написано. Свести «разог» к «разогреву» — вписать «разогрев».
        </p>
      )}

      <div className="surface overflow-x-auto">
        {/* Ширины заданы: иначе при поиске колонки разъезжались бы под оставшиеся строки. */}
        <table className="w-full min-w-[44rem] table-fixed text-sm">
          <colgroup>
            <col />
            <col className="w-16" />
            <col className="w-16" />
            <col className="w-48" />
            <col className="w-[38%]" />
          </colgroup>
          <thead>
            <tr className="text-left text-xs muted">
              <th className="px-3 py-2 font-medium">Как написано</th>
              <th className="px-3 py-2 text-right font-medium">Раз</th>
              <th className="px-3 py-2 text-right font-medium">Лавок</th>
              <th className="px-3 py-2 font-medium">Где</th>
              <th className="px-3 py-2 font-medium">Единое название</th>
            </tr>
          </thead>
          {shown.map((g) => {
            // Одно написание, которое и есть название, — строка группы лишняя.
            const header = g.rows.length > 1 || g.rows[0].name.toLowerCase() !== g.rows[0].key;
            return (
              <tbody key={g.name} className="border-t" style={{ borderColor: 'var(--border)' }}>
                {header && (
                  <tr style={{ background: 'color-mix(in srgb, var(--focus) 6%, transparent)' }}>
                    <td className="px-3 py-1.5 font-semibold">
                      {g.name}
                      {g.rows.length > 1 && (
                        <span className="ml-2 text-xs font-normal muted">
                          {g.rows.length} {plural(g.rows.length, 'написание', 'написания', 'написаний')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{g.uses}</td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{g.shops}</td>
                    <td />
                    <td className="px-3 py-1.5">
                      {editing && g.rows.length > 1 && (
                        <input
                          list="staffing-place-names"
                          placeholder="переименовать группу"
                          onChange={(e) => {
                            const v = e.target.value;
                            setDraft((d) => ({ ...d, ...Object.fromEntries(g.rows.map((r) => [r.key, v || r.name])) }));
                          }}
                          className="h-7 w-full min-w-48 rounded border px-1.5 text-xs"
                          style={INPUT_STYLE}
                          aria-label={`${g.name}: переименовать все написания`}
                        />
                      )}
                    </td>
                  </tr>
                )}
                {g.rows.map((r) => {
                  const dirty = draft[r.key] != null && draft[r.key].trim() !== r.name;
                  return (
                    <tr key={r.key} className={header ? 'border-t' : ''} style={{ borderColor: 'var(--border)' }}>
                      <td className={`py-1.5 pr-3 ${header ? 'pl-6' : 'pl-3 font-semibold'}`}>{r.place}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{r.uses}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums" title={r.shops.join(', ')}>
                        {r.shops.length}
                      </td>
                      <td className="px-3 py-1.5 text-xs muted">{r.sources.map(SOURCE_LABEL).join(', ')}</td>
                      <td className="px-3 py-1.5">
                        {editing ? (
                          <input
                            list="staffing-place-names"
                            value={value(r)}
                            onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                            className="h-7 w-full min-w-48 rounded border px-1.5 text-xs"
                            style={{ ...INPUT_STYLE, ...(dirty && { borderColor: 'var(--focus)' }) }}
                            aria-label={`${r.place}: единое название`}
                          />
                        ) : r.name.toLowerCase() === r.key ? (
                          <span className="text-xs muted">как написано</span>
                        ) : (
                          <span>
                            → {r.name}
                            {!r.fromSite && <span className="ml-2 text-xs muted">(опечатка, по умолчанию)</span>}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
        {shown.length === 0 && <p className="p-4 text-center text-sm muted">Ничего не нашлось</p>}
      </div>
      <datalist id="staffing-place-names">
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </section>
  );
}

const BUTTON = 'h-8 rounded-md border px-3 text-xs font-medium whitespace-nowrap hover:opacity-90 disabled:opacity-50';
const BUTTON_STYLE = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' };
const INPUT_STYLE = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' };
