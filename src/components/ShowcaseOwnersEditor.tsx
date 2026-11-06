'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeCode } from '@/lib/shops';
import { splitShops, type ShowcaseOwner } from '@/lib/showcase-owners';
import { formatMoment } from '@/lib/time';
import { plural } from '@/lib/plural';

/**
 * Редактор «кто какие лавки заполняет».
 *
 * Сохраняется кнопкой, а не на каждый символ, как витрины: список пишется
 * целиком, и полупеченная строка «М14, М1» на полпути к «М16» тут же
 * перекинула бы чужую лавку. Лавки вводятся строкой — так их копируют из
 * таблицы; к виду «М14» их приводит сервер.
 */

interface Row {
  key: number;
  name: string;
  shops: string;
}

const FIELD = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' };

export function ShowcaseOwnersEditor({
  owners,
  updatedAt,
  editable,
  knownShops,
}: {
  owners: readonly ShowcaseOwner[];
  updatedAt: string | null;
  editable: boolean;
  knownShops: readonly string[];
}) {
  const router = useRouter();
  const seq = useRef(owners.length);
  const initial = useMemo(
    () => owners.map((o, key) => ({ key, name: o.name, shops: o.shops.join(', ') })),
    [owners],
  );
  const [rows, setRows] = useState<Row[]>(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const dirty = JSON.stringify(rows.map(strip)) !== JSON.stringify(initial.map(strip));
  const known = useMemo(() => new Set(knownShops), [knownShops]);

  // Подсказки до сохранения: та же лавка у двух людей и коды, которых нет в
  // радаре. Окончательно проверяет сервер, здесь — чтобы не гонять запросы.
  const hints = useMemo(() => {
    const owner = new Map<string, string>();
    const twice = new Set<string>();
    for (const r of rows) {
      for (const code of codes(r.shops)) {
        const was = owner.get(code);
        if (was !== undefined && was !== r.name) twice.add(code);
        owner.set(code, r.name);
      }
    }
    const free = knownShops.filter((c) => !owner.has(c));
    return { twice, free };
  }, [rows, knownShops]);

  const patch = (key: number, next: Partial<Row>) => {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...next } : r)));
    setState('idle');
  };

  const save = async () => {
    setState('saving');
    setError(null);
    try {
      const res = await fetch('/api/showcase/owners', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owners: rows.map((r) => ({ name: r.name, shops: r.shops })),
          baseUpdatedAt: updatedAt,
        }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) {
        setState('error');
        setError(body.error ?? 'Не удалось сохранить');
        return;
      }
      setState('saved');
      // Отчёт выше считается на сервере — перечитываем страницу целиком.
      router.refresh();
    } catch {
      setState('error');
      setError('Нет связи с сервером — правка не сохранена.');
    }
  };

  return (
    <section className="surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Кто какие лавки заполняет</h2>
          <p className="mt-0.5 text-xs muted">
            Лавки — через запятую или пробел: «М14, М16, М17». Одна лавка — один ответственный.
            {updatedAt && ` Сохранено ${formatMoment(updatedAt)}.`}
            {!editable && ' Здесь только просмотр: на этом хостинге нет базы ручных данных.'}
          </p>
        </div>
        {editable && (
          <div className="flex items-center gap-2">
            {dirty && state !== 'saving' && (
              <button
                type="button"
                onClick={() => {
                  setRows(initial);
                  setState('idle');
                  setError(null);
                }}
                className="rounded-lg px-3 py-2 text-sm muted hover:opacity-70"
              >
                Отменить
              </button>
            )}
            <button
              type="button"
              disabled={!dirty || state === 'saving'}
              onClick={() => void save()}
              className="rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
              style={{ background: 'var(--focus)' }}
            >
              {state === 'saving' ? 'Сохраняю…' : state === 'saved' && !dirty ? 'Сохранено ✓' : 'Сохранить'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--red-ink)' }}>
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {rows.map((r) => {
          const list = codes(r.shops);
          const strange = list.filter((c) => !known.has(c));
          const doubled = list.filter((c) => hints.twice.has(c));
          return (
            <div key={r.key} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={r.name}
                  disabled={!editable}
                  onChange={(e) => patch(r.key, { name: e.target.value })}
                  placeholder="Фамилия Имя"
                  aria-label="Ответственный"
                  className="w-full rounded-lg border px-2.5 py-2 text-sm sm:w-56"
                  style={FIELD}
                />
                <input
                  value={r.shops}
                  disabled={!editable}
                  onChange={(e) => patch(r.key, { shops: e.target.value })}
                  placeholder="М14, М16"
                  aria-label={`Лавки, ${r.name || 'новый ответственный'}`}
                  className="min-w-0 flex-1 rounded-lg border px-2.5 py-2 text-sm"
                  style={FIELD}
                />
                <span className="w-16 text-xs tabular-nums muted">
                  {list.length} {plural(list.length, 'лавка', 'лавки', 'лавок')}
                </span>
                {editable && (
                  <button
                    type="button"
                    onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}
                    aria-label={`Убрать ${r.name || 'строку'}`}
                    className="rounded-lg px-2 py-1 text-sm muted hover:opacity-70"
                  >
                    ✕
                  </button>
                )}
              </div>
              {(doubled.length > 0 || strange.length > 0) && (
                <p className="text-xs" style={{ color: 'var(--yellow-ink)' }}>
                  {doubled.length > 0 && `Уже у другого: ${doubled.join(', ')}. `}
                  {strange.length > 0 && `Нет в радаре: ${strange.join(', ')}.`}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {editable && (
        <button
          type="button"
          onClick={() => setRows((all) => [...all, { key: seq.current++, name: '', shops: '' }])}
          className="mt-3 rounded-lg border px-3 py-2 text-sm hover:opacity-90"
          style={{ borderColor: 'var(--border)' }}
        >
          + Добавить ответственного
        </button>
      )}

      {hints.free.length > 0 && (
        <p className="mt-3 text-xs muted">
          Ни за кем: {hints.free.join(', ')}.
        </p>
      )}
    </section>
  );
}

function strip(r: Row): { name: string; shops: string } {
  return { name: r.name.trim(), shops: codes(r.shops).join(',') };
}

function codes(text: string): string[] {
  return [...new Set(splitShops(text).map(normalizeCode))];
}
