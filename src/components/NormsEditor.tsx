'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { plural } from '@/lib/plural';
import { formatMoment } from '@/lib/time';
import { ClearButton } from './ClearButton';

/**
 * Редактор нормативов открытия по лавкам.
 *
 * Сетевые пороги выше — одни на всю сеть, а норма у каждой лавки своя: в М73
 * водителя ждут в 5:20, в М72 — в 8:00. Эти цифры приезжают из справочника
 * «Лавки», но справочник отстаёт от жизни, поэтому их правят здесь.
 *
 * Часы выхода поваров вводятся одной строкой: «6:20», а где лавку
 * доукомплектовывают позже — «6:00 / 6:30». Строка из справочника («3 с 6:20»)
 * тоже принимается как есть: разбирает её тот же код, что читает справочник, и
 * количество поваров он отбрасывает — нормой является час, а не число людей.
 */

interface ShopRow {
  code: string;
  name: string;
  inRadar: boolean;
  driverAt: string | null;
  cookAt: string[];
  rawDriver: string | null;
  rawCook: string | null;
  source: 'reference' | 'manual';
  warnings: string[];
}

interface NormsData {
  ok: boolean;
  enabled: boolean;
  yellowStepMinutes: number;
  confirmed: boolean;
  editable: boolean;
  hint: string;
  tokenRequired: boolean;
  updatedAt: string | null;
  shops: ShopRow[];
  error?: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const TOKEN_KEY = 'radar.uploadToken';
/** Пауза после последнего нажатия клавиши, чтобы не слать запрос на каждый символ. */
const SAVE_DEBOUNCE_MS = 700;

export function NormsEditor() {
  const [data, setData] = useState<NormsData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { driver?: string; cook?: string }>>({});
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyEdited, setOnlyEdited] = useState(false);
  const [token, setToken] = useState('');

  const pending = useRef<Map<string, { driver?: string; cook?: string }>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      setToken(localStorage.getItem(TOKEN_KEY) ?? '');
    } catch {
      // Приватное окно — код спросим заново.
    }
  }, []);

  const load = useCallback(async () => {
    const res = await fetch('/api/norms');
    const body = (await res.json()) as NormsData;
    setData(body);
    setDrafts({});
    setSave('idle');
    setError(body.ok ? null : (body.error ?? 'Не удалось загрузить нормы'));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Отправляем накопленные правки одной пачкой. */
  const flush = useCallback(async () => {
    const batch = [...pending.current.entries()];
    if (batch.length === 0) return;
    pending.current.clear();
    setSave('saving');

    const rows = data?.shops ?? [];
    const edits = batch.map(([code, patch]) => {
      const row = rows.find((s) => s.code === code);
      return {
        shopCode: code,
        // Правка одного поля не должна стирать соседнее: недостающее берём из
        // текущего состояния лавки, потому что сервер заменяет норму целиком.
        driverAt: patch.driver ?? row?.driverAt ?? '',
        cook: patch.cook ?? formatPlan(row?.cookAt ?? []),
      };
    });

    try {
      const res = await fetch('/api/norms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-radar-upload-token': token },
        body: JSON.stringify({ edits }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) {
        setSave('error');
        setError(body.error ?? 'Не удалось сохранить');
        return;
      }
      setError(null);
      setSave('saved');
      await load();
    } catch {
      setSave('error');
      setError('Сеть не ответила — правка не сохранена');
    }
  }, [data, load, token]);

  const queueEdit = useCallback(
    (code: string, patch: { driver?: string; cook?: string }) => {
      setDrafts((d) => ({ ...d, [code]: { ...d[code], ...patch } }));
      pending.current.set(code, { ...pending.current.get(code), ...patch });

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const reset = useCallback(
    async (code: string) => {
      setSave('saving');
      const res = await fetch('/api/norms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-radar-upload-token': token },
        body: JSON.stringify({ reset: code }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) {
        setSave('error');
        setError(body.error ?? 'Не удалось сбросить');
        return;
      }
      setSave('saved');
      await load();
    },
    [load, token],
  );

  const shops = useMemo(() => {
    const list = data?.shops ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((s) => {
      if (onlyEdited && s.source !== 'manual') return false;
      if (!q) return true;
      return `${s.code} ${s.name}`.toLowerCase().includes(q);
    });
  }, [data, onlyEdited, query]);

  if (!data) return <p className="text-sm muted">Загружаю нормы…</p>;

  const edited = data.shops.filter((s) => s.source === 'manual').length;
  const missing = data.shops.filter((s) => s.inRadar && !s.driverAt && s.cookAt.length === 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Лавка: код или название"
          className="w-56 rounded border px-2 py-1 text-sm"
          style={{ borderColor: 'var(--border)' }}
        />
        {query && <ClearButton onClick={() => setQuery('')} label="Сбросить поиск" />}
        <label className="flex items-center gap-1.5 text-xs muted">
          <input
            type="checkbox"
            checked={onlyEdited}
            onChange={(e) => setOnlyEdited(e.target.checked)}
          />
          только поправленные ({edited})
        </label>

        {data.tokenRequired && (
          <input
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              try {
                localStorage.setItem(TOKEN_KEY, e.target.value);
              } catch {
                // Приватное окно — код живёт до перезагрузки страницы.
              }
            }}
            placeholder="Код загрузки"
            className="w-36 rounded border px-2 py-1 text-sm"
            style={{ borderColor: 'var(--border)' }}
          />
        )}

        <span className="ml-auto text-xs muted">
          {save === 'saving' && 'сохраняю…'}
          {save === 'saved' && 'сохранено'}
          {save === 'idle' && data.updatedAt && `правили ${formatMoment(data.updatedAt)}`}
        </span>
      </div>

      {error && (
        <p className="text-sm" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}
      {!data.editable && <p className="text-xs muted">{data.hint}</p>}

      {missing.length > 0 && (
        <p className="text-xs muted">
          Без нормы в справочнике: {missing.map((s) => s.code).join(', ')} —{' '}
          {plural(missing.length, 'эта лавка считается', 'эти лавки считаются', 'эти лавки считаются')}{' '}
          по сетевым порогам выше.
        </p>
      )}

      <div className="surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs muted">
              <th className="px-3 py-2 font-normal">Лавка</th>
              <th className="px-3 py-2 font-normal">Водитель</th>
              <th className="px-3 py-2 font-normal">Повара</th>
              <th className="px-3 py-2 font-normal">Зоны</th>
              <th className="px-3 py-2 font-normal">Справочник</th>
            </tr>
          </thead>
          <tbody>
            {shops.map((s) => {
              const draft = drafts[s.code] ?? {};
              const driver = draft.driver ?? s.driverAt ?? '';
              const cook = draft.cook ?? formatPlan(s.cookAt);

              return (
                <tr
                  key={s.code}
                  className="border-t align-top"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className="font-medium">{s.code}</span>{' '}
                    <span className="muted">{s.name.replace(`${s.code} `, '')}</span>
                    {!s.inRadar && (
                      <span className="ml-1.5 text-xs muted" title="В выгрузках отметок этой лавки нет">
                        нет в радаре
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      value={driver}
                      disabled={!data.editable}
                      onChange={(e) => queueEdit(s.code, { driver: e.target.value })}
                      onBlur={() => void flush()}
                      placeholder="—"
                      className="w-20 rounded border px-1.5 py-0.5 tabular-nums"
                      style={{ borderColor: 'var(--border)' }}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      value={cook}
                      disabled={!data.editable}
                      onChange={(e) => queueEdit(s.code, { cook: e.target.value })}
                      onBlur={() => void flush()}
                      placeholder="6:20"
                      className="w-44 rounded border px-1.5 py-0.5"
                      style={{ borderColor: 'var(--border)' }}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-xs tabular-nums muted whitespace-nowrap">
                    {zones(s.driverAt, data.yellowStepMinutes)}
                  </td>
                  <td className="px-3 py-1.5 text-xs muted">
                    {s.source === 'manual' ? (
                      <span className="flex items-center gap-1.5">
                        поправлено вручную
                        <button
                          type="button"
                          onClick={() => void reset(s.code)}
                          className="underline"
                          title="Вернуть норму из справочника"
                        >
                          вернуть
                        </button>
                      </span>
                    ) : (
                      [s.rawDriver, s.rawCook].filter(Boolean).join(' · ') || '—'
                    )}
                    {s.warnings.map((w) => (
                      <span key={w} className="block" style={{ color: 'var(--yellow)' }}>
                        {w}
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Часы → строка для поля ввода: обратный разбор того, что принимает сервер. */
function formatPlan(times: readonly string[]): string {
  return times.join(' / ');
}

/** «🟢 до 06:30 · 🟡 до 06:45» — как норма превращается в зоны. */
function zones(normAt: string | null, step: number): string {
  if (!normAt) return 'по сетевым порогам';

  const [h, m] = normAt.split(':').map(Number);
  const yellow = h * 60 + m + step;
  const hh = String(Math.floor(yellow / 60) % 24).padStart(2, '0');
  const mm = String(yellow % 60).padStart(2, '0');
  return `🟢 до ${normAt} · 🟡 до ${hh}:${mm} · 🔴 позже`;
}
