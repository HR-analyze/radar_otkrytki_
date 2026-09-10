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
/** Сколько «сохранено» висит на экране, прежде чем погаснуть. */
const SAVED_BADGE_MS = 2500;

export function NormsEditor() {
  const [data, setData] = useState<NormsData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { driver?: string; cook?: string }>>({});
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyEdited, setOnlyEdited] = useState(false);
  const [token, setToken] = useState('');
  /** Сколько правок ещё не доехало до сервера — видно человеку, а не только коду. */
  const [queued, setQueued] = useState(0);
  /** Лавка, у которой сейчас спрашиваем подтверждение возврата нормы. */
  const [confirming, setConfirming] = useState<string | null>(null);

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
    setQueued(0);
    setSave('idle');
    setError(body.ok ? null : (body.error ?? 'Не удалось загрузить нормы'));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Отправляем накопленные правки одной пачкой.
   *
   * `leaving` — уходим со страницы: запрос помечается keepalive, и браузер
   * обязуется его доставить даже после закрытия вкладки. Норму правят по
   * одной лавке и сразу уходят на другую вкладку — без этого последние
   * 700 мс ввода пропадали молча, ровно как это было в редакторе витрин.
   */
  const flush = useCallback(async (leaving = false) => {
    const batch = [...pending.current.entries()];
    if (batch.length === 0) return;
    pending.current.clear();
    setQueued(0);
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
        keepalive: leaving,
        headers: { 'content-type': 'application/json', 'x-radar-upload-token': token },
        body: JSON.stringify({ edits }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) {
        requeue(batch);
        setSave('error');
        setError(body.error ?? 'Не удалось сохранить');
        return;
      }
      setError(null);
      setSave('saved');
      // Уходя со страницы, перечитывать нечего и незачем: ответ мы уже
      // не увидим, а лишний запрос конкурирует с тем, что везёт правки.
      if (!leaving) await load();
    } catch {
      requeue(batch);
      setSave('error');
      setError('Сеть не ответила — правка не сохранена');
    }

    /**
     * Пачка вычищается из очереди перед отправкой. При сбое она исчезала
     * совсем: человек видел «не сохранено», правил заново — и отправлял
     * пустоту, потому что отправлять было уже нечего.
     */
    function requeue(failed: [string, { driver?: string; cook?: string }][]) {
      for (const [code, patch] of failed) {
        pending.current.set(code, { ...patch, ...pending.current.get(code) });
      }
      setQueued(pending.current.size);
    }
  }, [data, load, token]);

  /** «сохранено» гаснет само: иначе надпись одинаково стоит и через час. */
  useEffect(() => {
    if (save !== 'saved') return;
    const t = setTimeout(() => setSave('idle'), SAVED_BADGE_MS);
    return () => clearTimeout(t);
  }, [save]);

  /**
   * Незаписанное не должно теряться при уходе со страницы. visibilitychange
   * нужен рядом с beforeunload: на телефоне вкладку не закрывают — сворачивают,
   * и система выгружает её без предупреждения.
   */
  useEffect(() => {
    const leave = () => {
      if (pending.current.size > 0) void flush(true);
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') leave();
    };

    window.addEventListener('beforeunload', leave);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', leave);
      document.removeEventListener('visibilitychange', onHide);
      leave();
    };
  }, [flush]);

  const queueEdit = useCallback(
    (code: string, patch: { driver?: string; cook?: string }) => {
      setDrafts((d) => ({ ...d, [code]: { ...d[code], ...patch } }));
      pending.current.set(code, { ...pending.current.get(code), ...patch });
      setQueued(pending.current.size);

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
        {/*
          Крестик сброса позиционируется абсолютно и требует, чтобы родитель
          был `position: relative` (см. ClearButton). Раньше он лежал прямо в
          общей flex-строке — и висел не внутри поля, а рядом с ним, наезжая
          на галочку «только поправленные».
        */}
        <div className={`relative w-56 ${query ? 'has-clear' : ''}`}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Лавка: код или название"
            aria-label="Поиск лавки: код или название"
            className={`w-full rounded-lg border px-2.5 py-2 text-sm ${query ? 'pr-9' : ''}`}
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
            }}
          />
          {query && <ClearButton onClick={() => setQuery('')} label="Сбросить поиск" />}
        </div>
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
            /* Пароль, а не обычное поле: код общий на команду, и набирать его
               открытым текстом на экране, который показывают на планёрке, —
               ровно тот способ, которым он утекает. В витринах уже password. */
            type="password"
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
            aria-label="Код загрузки"
            className="w-36 rounded-lg border px-2.5 py-2 text-sm"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
            }}
          />
        )}

        {/* То же, что в редакторе витрин: надпись «сохранено» гаснет сама и
            проговаривается вслух, а несохранённое видно счётчиком. */}
        <span className="ml-auto text-xs" aria-live="polite">
          {save === 'saving' && <span className="muted">сохраняю…</span>}
          {save === 'saved' && <span className="ink-green">✅ сохранено</span>}
          {save === 'error' && (
            <span className="ink-red">
              ⚠ не сохранено{queued > 0 && `: ${queued} в очереди`}
            </span>
          )}
          {save === 'idle' && queued > 0 && (
            <span className="muted">правок в очереди: {queued}</span>
          )}
          {save === 'idle' && queued === 0 && data.updatedAt && (
            <span className="muted">правили {formatMoment(data.updatedAt)} МСК</span>
          )}
        </span>
      </div>

      {error && (
        <p className="text-sm ink-red">
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

      {/* Восемьдесят строк: заголовок обязан липнуть, иначе к середине списка
          уже не понять, где норма водителя, а где часы поваров. Своя высота
          нужна затем же, зачем радару, — см. globals.css. */}
      <div className="surface max-h-[32rem] overflow-auto" style={{ overscrollBehavior: 'contain' }}>
        <table className="norms-table w-full text-sm">
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
                      /* Без подписи программа чтения с экрана объявляла просто
                         «поле ввода»: чья это норма и что в неё писать —
                         непонятно, а полей на странице восемьдесят пар. */
                      aria-label={`Норма приезда водителя, ${s.code}`}
                      className="w-20 rounded border px-2 py-1.5 tabular-nums"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                      }}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      value={cook}
                      disabled={!data.editable}
                      onChange={(e) => queueEdit(s.code, { cook: e.target.value })}
                      onBlur={() => void flush()}
                      placeholder="6:20"
                      aria-label={`Часы выхода поваров, ${s.code}`}
                      className="w-44 rounded border px-2 py-1.5"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                      }}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-xs tabular-nums muted whitespace-nowrap">
                    {zones(s.driverAt, data.yellowStepMinutes)}
                  </td>
                  <td className="px-3 py-1.5 text-xs muted">
                    {s.source === 'manual' ? (
                      /*
                       * Возврат стирает ручную норму насовсем: отмены, как у
                       * процентов витрины, здесь нет — сервер заменяет запись
                       * значением из справочника. Поэтому спрашиваем: один
                       * промах по строке из восьмидесяти стоил бы правки,
                       * которую потом никто не вспомнит.
                       */
                      <span className="flex flex-wrap items-center gap-1.5">
                        поправлено вручную
                        {confirming === s.code ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setConfirming(null);
                                void reset(s.code);
                              }}
                              className="rounded border px-1.5 py-0.5 font-medium ink-red"
                              style={{ borderColor: 'var(--red-ink)' }}
                            >
                              точно вернуть
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirming(null)}
                              className="underline"
                            >
                              отмена
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirming(s.code)}
                            className="underline"
                            title="Вернуть норму из справочника — ручная правка будет стёрта"
                          >
                            вернуть
                          </button>
                        )}
                      </span>
                    ) : (
                      [s.rawDriver, s.rawCook].filter(Boolean).join(' · ') || '—'
                    )}
                    {s.warnings.map((w) => (
                      <span key={w} className="block ink-yellow">
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
