'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { STAFF_ROLE_SHORT, normalizePlace } from '@/lib/staffing';
import {
  previewAliasChange,
  type PlaceAlias,
  type PlaceSource,
  type PlaceUsage,
  type PlaceWindow,
  type UnusedAlias,
} from '@/lib/staffing-places';
import type { PlaceLogEntry } from '@/lib/staffing-edits';
import { plural } from '@/lib/plural';
import { EditButton } from './StaffingLayout';

export interface PlaceRow extends PlaceUsage {
  /** Единое название сейчас — с учётом словаря по умолчанию и правок сайта. */
  name: string;
  /** Строку правили на сайте (иначе — словарь по умолчанию или как написано). */
  fromSite: boolean;
  /** Строку разобрали: сохраняли на сайте или это известная опечатка. Нет — «новое». */
  reviewed: boolean;
  /** Название без правок сайта: словарь по умолчанию или как написано. */
  defaultName: string;
}

/** Кто правит — запоминается в браузере, чтобы не вписывать на каждую правку. */
const AUTHOR_KEY = 'radar.staffing.author';

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
  saved,
  windows,
  unused,
  log,
}: {
  rows: PlaceRow[];
  shopCount: number;
  editable: boolean;
  unlocked: boolean;
  /** Строки словаря с сайта, ключ — как в базе. */
  saved: PlaceAlias[];
  /** Окна сети с написаниями как в книгах — для предпросмотра правки. */
  windows: PlaceWindow[];
  /** Строки словаря, которые ни на что не влияют. */
  unused: UnusedAlias[];
  log: (PlaceLogEntry & { when: string })[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  // Новые написания, принятые как есть: сохраняются строкой с тем же названием.
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState('');
  const [author, setAuthor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setAuthor(localStorage.getItem(AUTHOR_KEY) ?? '');
    } catch {
      // Хранилище браузера закрыто — впишут заново.
    }
  }, []);
  const rememberAuthor = (v: string) => {
    setAuthor(v);
    try {
      localStorage.setItem(AUTHOR_KEY, v);
    } catch {
      // см. выше
    }
  };

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
  const fresh = rows.filter((r) => !r.reviewed);
  const shown = groups
    .map((g) => (onlyNew ? { ...g, rows: g.rows.filter((r) => !r.reviewed) } : g))
    .filter((g) => g.rows.length > 0)
    .filter((g) => !q || g.name.toLowerCase().includes(q) || g.rows.some((r) => r.place.toLowerCase().includes(q)));
  const names = useMemo(() => [...new Set(groups.map((g) => g.name))].sort((a, b) => a.localeCompare(b, 'ru')), [groups]);

  const value = (r: PlaceRow) => draft[r.key] ?? r.name;
  const changed = rows.filter((r) => draft[r.key] != null && draft[r.key].trim() !== r.name);

  const changes = changed.map((r) => ({ place: r.place, name: draft[r.key].trim() }));
  const acceptedRows = rows.filter((r) => accepted.has(r.key) && !changed.includes(r));
  const pending = changes.length + acceptedRows.length;
  const preview = changes.length ? previewAliasChange(windows, saved, changes) : null;
  // Откатить можно только последнюю правку строки (журнал — новые сверху) и
  // только пока строку с тех пор не переписали.
  const current = new Map(saved.map((a) => [a.place, a.name]));
  const latest = new Set<number>();
  const logged = new Set<string>();
  for (const e of log) {
    if (logged.has(e.place)) continue;
    logged.add(e.place);
    latest.add(e.id);
  }

  /** Запрос к словарю; удалось — перечитать страницу. */
  const send = async (method: 'POST' | 'DELETE', payload: PlaceAlias[] | string): Promise<boolean> => {
    if (!author.trim()) {
      setError('Впишите, кто правит, — это попадёт в журнал');
      return false;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(
      method === 'DELETE'
        ? `/api/staffing/places?${new URLSearchParams({ place: payload as string, author: author.trim() })}`
        : '/api/staffing/places',
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' && { body: JSON.stringify({ aliases: payload, author: author.trim() }) }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (!data.ok) {
      setError(data.error ?? 'Не сохранилось');
      return false;
    }
    router.refresh();
    return true;
  };

  const save = async () => {
    if (await send('POST', [...changes, ...acceptedRows.map((r) => ({ place: r.place, name: r.name }))])) {
      setDraft({});
      setAccepted(new Set());
      setEditing(false);
    }
  };

  const addFunction = async () => {
    const name = normalizePlace(added);
    if (!name) return;
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      setError(`«${name}» уже есть`);
      return;
    }
    if (await send('POST', [{ place: name, name }])) setAdded('');
  };

  const rollback = (e: PlaceLogEntry) => {
    const what = e.oldName == null ? 'вернуть по умолчанию' : `вернуть «${e.oldName}»`;
    if (!window.confirm(`«${e.place}»: ${what}? Поменяется во всех лавках.`)) return;
    if (e.oldName == null) send('DELETE', e.place);
    else send('POST', [{ place: e.place, name: e.oldName }]);
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
          {fresh.length > 0 && (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => setOnlyNew((v) => !v)}
                className="font-semibold underline decoration-dotted"
                style={{ color: 'var(--red)' }}
                title="Написания, которые пришли из книг и которые ещё никто не разобрал"
              >
                не разобрано: {fresh.length}
              </button>
            </>
          )}
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
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
            только новые
          </label>
          {editable && !editing && <EditButton unlocked={unlocked} onEdit={() => setEditing(true)} />}
          {editing && (
            <>
              <input
                value={author}
                onChange={(e) => rememberAuthor(e.target.value)}
                placeholder="Кто правит"
                maxLength={60}
                className="h-8 w-36 rounded-md border px-2 text-xs"
                style={{ ...INPUT_STYLE, ...(!author.trim() && { borderColor: 'var(--red)' }) }}
                aria-label="Кто правит — для журнала"
              />
              <button
                type="button"
                disabled={busy || pending === 0}
                onClick={save}
                className={BUTTON}
                style={{ ...BUTTON_STYLE, background: 'var(--focus)', color: '#fff' }}
              >
                Сохранить{pending > 0 && ` (${pending})`}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft({});
                  setAccepted(new Set());
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
        <div className="flex flex-col gap-2">
          <p className="text-xs muted">
            Впишите единое название справа от написания или выберите из списка. Поле в строке группы переименовывает все её
            написания сразу. Пустое поле — оставить как написано. Свести «разог» к «разогреву» — вписать «разогрев».
            Новое написание, которое и так названо верно, — «принять». ↺ — вернуть название по умолчанию.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={added}
              onChange={(e) => setAdded(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addFunction()}
              placeholder="новый функционал"
              maxLength={80}
              className="h-8 w-56 rounded-md border px-2 text-xs"
              style={INPUT_STYLE}
              aria-label="Новый функционал"
            />
            <button type="button" disabled={busy || !added.trim()} onClick={addFunction} className={BUTTON} style={BUTTON_STYLE}>
              + Добавить функционал
            </button>
            {fresh.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setAccepted(new Set(fresh.map((r) => r.key)))}
                className={BUTTON}
                style={BUTTON_STYLE}
                title="Отметить все новые написания разобранными с теми названиями, что сейчас справа"
              >
                Принять все новые ({fresh.length})
              </button>
            )}
          </div>
          {preview && (
            <p className="text-xs" style={preview.merged > 0 ? { color: 'var(--red)' } : undefined}>
              Затронет {preview.windows} {plural(preview.windows, 'окно', 'окна', 'окон')} в {preview.shops}{' '}
              {plural(preview.shops, 'лавке', 'лавках', 'лавках')}
              {preview.merged > 0 &&
                `, в ${preview.merged} ${plural(preview.merged, 'окне', 'окнах', 'окнах')} места сольются в одно`}
              .
            </p>
          )}
        </div>
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
                      <td className={`py-1.5 pr-3 ${header ? 'pl-6' : 'pl-3 font-semibold'}`}>
                        {r.place}
                        {!r.reviewed && !accepted.has(r.key) && (
                          <span
                            className="ml-2 rounded px-1 text-[10px] font-semibold uppercase"
                            style={{ color: 'var(--red)', border: '1px solid var(--red)' }}
                            title="Пришло из книги, ещё никто не разобрал"
                          >
                            новое
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{r.uses}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums" title={r.shops.join(', ')}>
                        {r.shops.length}
                      </td>
                      <td className="px-3 py-1.5 text-xs muted">{r.sources.map(SOURCE_LABEL).join(', ')}</td>
                      <td className="px-3 py-1.5">
                        {editing ? (
                          <span className="flex items-center gap-1">
                            <input
                              list="staffing-place-names"
                              value={value(r)}
                              onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                              className="h-7 w-full min-w-40 rounded border px-1.5 text-xs"
                              style={{ ...INPUT_STYLE, ...(dirty && { borderColor: 'var(--focus)' }) }}
                              aria-label={`${r.place}: единое название`}
                            />
                            {!r.reviewed && !dirty && (
                              <button
                                type="button"
                                onClick={() =>
                                  setAccepted((a) => {
                                    const next = new Set(a);
                                    if (next.has(r.key)) next.delete(r.key);
                                    else next.add(r.key);
                                    return next;
                                  })
                                }
                                className="h-7 shrink-0 rounded border px-1.5 text-xs"
                                style={{ ...BUTTON_STYLE, ...(accepted.has(r.key) && { borderColor: 'var(--focus)' }) }}
                                aria-pressed={accepted.has(r.key)}
                              >
                                {accepted.has(r.key) ? '✓ принято' : 'принять'}
                              </button>
                            )}
                            {r.fromSite && value(r).trim() !== r.defaultName && (
                              <button
                                type="button"
                                onClick={() => setDraft((d) => ({ ...d, [r.key]: r.defaultName }))}
                                className="h-7 shrink-0 rounded border px-1.5 text-xs"
                                style={BUTTON_STYLE}
                                title={`Вернуть по умолчанию: «${r.defaultName}»`}
                              >
                                ↺
                              </button>
                            )}
                          </span>
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
      {unused.length > 0 && (
        <section className="surface flex flex-col gap-2 p-3">
          <h2 className="text-sm font-semibold">Строки словаря без написаний ({unused.length})</h2>
          <p className="text-xs muted">
            Ни на что сейчас не влияют: функционал добавили, а в лавки ещё не поставили, или написание пропало из книг.
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {unused.map((a) => (
              <li key={a.place} className="flex flex-wrap items-center gap-2">
                {a.kind === 'added' ? (
                  <>
                    <span className="font-medium">{a.name}</span>
                    <span className="text-xs muted">добавлен, пока ни в одной лавке</span>
                  </>
                ) : (
                  <>
                    <span>
                      {a.place} → {a.name}
                    </span>
                    <span className="text-xs muted">написания больше нет в книгах</span>
                  </>
                )}
                {editing && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => window.confirm(`Удалить строку «${a.place}»?`) && send('DELETE', a.place)}
                    className="text-xs underline muted"
                  >
                    удалить
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {log.length > 0 && (
        <details className="surface p-3">
          <summary className="cursor-pointer text-sm font-semibold">Журнал правок ({log.length})</summary>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {log.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs tabular-nums muted">{e.when}</span>
                <span className="text-xs font-medium">{e.author}</span>
                <span>
                  «{e.place}»: {e.oldName ?? <span className="muted">по умолчанию</span>} →{' '}
                  {e.newName ?? <span className="muted">строку удалили</span>}
                </span>
                {editing && latest.has(e.id) && (current.get(e.place) ?? null) === e.newName && (
                  <button type="button" disabled={busy} onClick={() => rollback(e)} className="text-xs underline muted">
                    откатить
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

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
