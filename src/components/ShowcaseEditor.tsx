'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { plural } from '@/lib/plural';
import { formatDay, formatMoment } from '@/lib/time';
import type { Status } from '@/lib/types';
import { ClearButton } from './ClearButton';

/**
 * Редактор наполнения витрин.
 *
 * Раньше эти проценты жили в Excel-книге: её правили руками и перезаливали
 * целиком. Здесь то же самое делается на месте, и заточено оно под один
 * сценарий — человек садится и проходит день по списку лавок:
 *
 *  · день переключается стрелками, значение вводится числом, Enter — вниз;
 *  · сохраняется само, через полсекунды после ввода, без кнопки «Сохранить»:
 *    забыть нажать её — значит потерять работу;
 *  · статус 🟢/🟡/🔴 появляется прямо в строке, сразу видно, что получилось;
 *  · счётчик «заполнено N из 80» показывает, сколько ещё осталось.
 */

interface ShopRow {
  code: string;
  name: string;
  region: string | null;
  /** Особый час открытия («10:00») — у обычной лавки null. См. shopSchedules. */
  opensAt: string | null;
  percent: number | null;
  status: Status;
  /** Короткая пометка: «не привезли ягоды», «витрину чинили». */
  note: string;
}

interface DayData {
  ok: boolean;
  date: string;
  editable: boolean;
  hint: string;
  tokenRequired: boolean;
  updatedAt: string | null;
  thresholds: { green: number; yellow: number };
  knownDates: string[];
  filledByDate: Record<string, number>;
  shops: ShopRow[];
  error?: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Одна отменяемая правка: что было в поле до того, как его тронули. */
interface UndoStep {
  shopCode: string;
  field: 'percent' | 'note';
  before: string;
  label: string;
}

const TOKEN_KEY = 'radar.uploadToken';
/** Пауза после последнего нажатия клавиши, чтобы не слать запрос на каждую цифру. */
const SAVE_DEBOUNCE_MS = 500;
/** Сколько «Сохранено» висит на экране, прежде чем погаснуть. */
const SAVED_BADGE_MS = 2500;
/** Глубина отмены: дальше вспомнить, что именно правил, всё равно нельзя. */
const UNDO_DEPTH = 50;
/** Столько же, сколько принимает сервер (см. /api/showcase). */
const MAX_NOTE = 300;

export function ShowcaseEditor({ initialDate }: { initialDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(initialDate);
  const [data, setData] = useState<DayData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [shopCode, setShopCode] = useState('');
  const [region, setRegion] = useState('');
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  // Список лавок под галочкой «только незаполненные» замораживается: без этого
  // строка вылетала бы из фильтра после первой же цифры («9» — уже не пусто),
  // и дописать «95» было бы некуда. Набор пересобирается при включении галочки,
  // при смене дня и по кнопке «спрятать заполненные».
  const [emptyLock, setEmptyLock] = useState<Set<string>>(new Set());
  const [token, setToken] = useState('');
  /**
   * Стек отмены. Правок по восьмидесяти лавкам не восстановить ничем: значение
   * уходит на сервер через полсекунды и затирает прежнее, а вернуть его было
   * неоткуда — только вспоминать по памяти.
   */
  const [undo, setUndo] = useState<UndoStep[]>([]);
  /** Сколько правок ещё не доехало до сервера — видно человеку, а не только коду. */
  const [queued, setQueued] = useState(0);

  // Копим правки по полям: процент и комментарий у одной лавки правят
  // независимо, и отправить нужно ровно то, что человек трогал.
  const pending = useRef<Map<string, { percent?: string; note?: string }>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputs = useRef<Map<string, HTMLInputElement>>(new Map());
  /** Состояние сохранения для обработчиков, живущих вне рендера (см. beforeunload). */
  const saveRef = useRef<SaveState>('idle');

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    try {
      setToken(localStorage.getItem(TOKEN_KEY) ?? '');
    } catch {
      // Приватное окно — код спросим заново.
    }
  }, []);

  const load = useCallback(async (day: string) => {
    const res = await fetch(`/api/showcase?date=${day}`);
    const body = (await res.json()) as DayData;
    setData(body);
    setDrafts({});
    setNoteDrafts({});
    setEmptyLock(new Set((body.shops ?? []).filter((s) => s.percent == null).map((s) => s.code)));
    // Стек отмены привязан к дню: вернуть вчерашнее значение в сегодняшнее
    // поле — это не отмена, а порча данных.
    setUndo([]);
    setQueued(0);
    setSave('idle');
    setError(body.ok ? null : (body.error ?? 'Не удалось загрузить день'));
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  /**
   * Отправляем накопленные правки одной пачкой.
   *
   * `leaving` — уходим со страницы. Тогда запрос помечается keepalive: браузер
   * обязуется доставить его, даже если вкладку уже закрыли. Без этой пометки
   * обработчик beforeunload запускал обычный fetch и вкладка закрывалась
   * раньше, чем он уходил, — последние полсекунды ввода пропадали молча.
   */
  const flush = useCallback(async (leaving = false) => {
    const batch = [...pending.current.entries()];
    if (batch.length === 0) return;
    pending.current.clear();
    setQueued(0);

    setSave('saving');
    try {
      const res = await fetch('/api/showcase', {
        method: 'POST',
        keepalive: leaving,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-radar-upload-token': token } : {}),
        },
        body: JSON.stringify({
          edits: batch.map(([shopCode, fields]) => ({
            date,
            shopCode,
            // Ключ кладём только для тронутого поля: иначе правка комментария
            // стёрла бы процент, и наоборот.
            ...(fields.percent !== undefined ? { percent: fields.percent || null } : {}),
            ...(fields.note !== undefined ? { note: fields.note } : {}),
          })),
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        saved?: { shopCode: string; percent: number | null; status: Status; note: string }[];
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Сервер ответил ${res.status}`);

      // Красим строки по ответу сервера, а не по своей догадке о порогах.
      setData((prev) =>
        prev
          ? {
              ...prev,
              shops: prev.shops.map((s) => {
                const saved = body.saved?.find((x) => x.shopCode === s.code);
                return saved
                  ? { ...s, percent: saved.percent, status: saved.status, note: saved.note }
                  : s;
              }),
            }
          : prev,
      );
      setSave('saved');
      setError(null);
      router.refresh();
    } catch (e) {
      /*
       * Пачку возвращаем в очередь: она была вычищена перед отправкой, и при
       * сетевом сбое правки исчезали совсем — человек видел «не удалось
       * сохранить», нажимал ещё раз и отправлял пустоту.
       */
      for (const [code, fields] of batch) {
        pending.current.set(code, { ...fields, ...pending.current.get(code) });
      }
      setQueued(pending.current.size);
      setSave('error');
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    }
  }, [date, router, token]);

  /**
   * Незаписанное не должно теряться при уходе со страницы.
   *
   * beforeunload на телефоне срабатывает не всегда: вкладку не «закрывают», её
   * сворачивают, и система выгружает без предупреждения. Поэтому слушаем ещё
   * и visibilitychange — момент, когда страница уходит из виду.
   *
   * Предупреждение «уйти со страницы?» показываем только если сохранение
   * реально сломалось: в обычном случае keepalive-запрос всё довезёт, и
   * лишний диалог только раздражал бы того, кто заполнил восемьдесят лавок.
   */
  useEffect(() => {
    const leave = () => {
      if (pending.current.size > 0) void flush(true);
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      leave();
      if (saveRef.current === 'error' && pending.current.size > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onHide);
      leave();
    };
  }, [flush]);

  /**
   * «✅ Сохранено» гасим через пару секунд. Раньше надпись оставалась висеть
   * навсегда и переставала что-либо значить: она одинаково стояла и через
   * секунду после правки, и через час.
   */
  useEffect(() => {
    if (save !== 'saved') return;
    const t = setTimeout(() => setSave('idle'), SAVED_BADGE_MS);
    return () => clearTimeout(t);
  }, [save]);

  function queue(code: string, patch: { percent?: string; note?: string }) {
    pending.current.set(code, { ...pending.current.get(code), ...patch });
    setQueued(pending.current.size);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }

  /**
   * Кладём в стек отмены прежнее значение поля — но только первую правку
   * подряд: иначе набранные «9», «95» дали бы два шага отмены на одно
   * осмысленное действие, и «отменить» пришлось бы жать по букве.
   */
  function remember(step: UndoStep) {
    setUndo((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.shopCode === step.shopCode && last.field === step.field) return prev;
      return [...prev, step].slice(-UNDO_DEPTH);
    });
  }

  function change(code: string, raw: string) {
    const value = raw.replace(',', '.').replace(/[^\d.]/g, '').slice(0, 5);
    const shop = shops.find((x) => x.code === code);
    remember({
      shopCode: code,
      field: 'percent',
      before: shop ? percentOf(shop, drafts) : '',
      label: `${code}: наполнение`,
    });
    setDrafts((d) => ({ ...d, [code]: value }));
    queue(code, { percent: value });
  }

  function changeNote(code: string, raw: string) {
    const value = raw.slice(0, MAX_NOTE);
    const shop = shops.find((x) => x.code === code);
    remember({
      shopCode: code,
      field: 'note',
      before: shop ? noteOf(shop, noteDrafts) : '',
      label: `${code}: комментарий`,
    });
    setNoteDrafts((d) => ({ ...d, [code]: value }));
    queue(code, { note: value });
  }

  /** Вернуть последнее изменённое поле к тому, что в нём было. */
  const undoLast = useCallback(() => {
    setUndo((prev) => {
      const step = prev[prev.length - 1];
      if (!step) return prev;

      if (step.field === 'percent') {
        setDrafts((d) => ({ ...d, [step.shopCode]: step.before }));
        pending.current.set(step.shopCode, {
          ...pending.current.get(step.shopCode),
          percent: step.before,
        });
      } else {
        setNoteDrafts((d) => ({ ...d, [step.shopCode]: step.before }));
        pending.current.set(step.shopCode, {
          ...pending.current.get(step.shopCode),
          note: step.before,
        });
      }

      setQueued(pending.current.size);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
      return prev.slice(0, -1);
    });
  }, [flush]);

  // Ctrl+Z — то, что человек жмёт не задумываясь. Внутри полей ввода браузер
  // отменяет сам, поэтому перехватываем только вне их.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      undoLast();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoLast]);

  const shops = data?.shops ?? [];
  const regions = useMemo(
    () => [...new Set(shops.map((s) => s.region).filter(Boolean))].sort() as string[],
    [shops],
  );

  // Список лавок в выпадашке сужается выбранным РМ: иначе можно выбрать пару
  // «РМ + чужая лавка» и получить пустой экран без объяснений.
  const shopOptions = useMemo(
    () => shops.filter((s) => !region || s.region === region),
    [shops, region],
  );

  const visible = useMemo(
    () =>
      shops.filter((s) => {
        if (region && s.region !== region) return false;
        if (shopCode && s.code !== shopCode) return false;
        // Замок держит строку в списке, пока в неё дописывают число.
        if (onlyEmpty && !emptyLock.has(s.code) && percentOf(s, drafts) !== '') return false;
        return true;
      }),
    [shops, region, shopCode, onlyEmpty, emptyLock, drafts],
  );

  const filled = shops.filter((s) => percentOf(s, drafts) !== '').length;
  /** Сколько строк остались в списке только благодаря замку — их можно спрятать. */
  const doneInView = onlyEmpty
    ? visible.filter((s) => percentOf(s, drafts) !== '').length
    : 0;
  const relock = () =>
    setEmptyLock(new Set(shops.filter((s) => percentOf(s, drafts) === '').map((s) => s.code)));
  const readOnly = data ? !data.editable : false;

  function focusNext(index: number) {
    const next = visible[index + 1];
    if (next) inputs.current.get(next.code)?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      {/* --- День и состояние сохранения --- */}
      <div className="surface flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-1">
          <StepButton label="←" title="Предыдущий день" onClick={() => setDate(shift(date, -1))} />
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          />
          <StepButton label="→" title="Следующий день" onClick={() => setDate(shift(date, 1))} />
        </div>

        {/* Нативное поле даты показывает формат системы — подписываем по-русски. */}
        <span className="text-sm font-medium">{humanDate(date)}</span>

        <span className="text-sm">
          Заполнено <b className="tabular-nums">{filled}</b> из {shops.length}{' '}
          {plural(shops.length, 'лавки', 'лавок', 'лавок')}
        </span>

        {/*
          Состояние сохранения читает и программа чтения с экрана: aria-live
          проговаривает изменения, не уводя фокус из поля ввода. Раньше это был
          немой серый текст, который к тому же не гас.
        */}
        <span className="text-xs" aria-live="polite">
          {save === 'saving' && <span className="muted">Сохраняю…</span>}
          {save === 'saved' && <span className="ink-green">✅ Сохранено</span>}
          {save === 'error' && (
            <span className="ink-red">
              ⚠ Не сохранено{queued > 0 && `: ${queued} ${plural(queued, 'правка', 'правки', 'правок')} в очереди`}
            </span>
          )}
          {save === 'idle' && queued > 0 && <span className="muted">Правки в очереди: {queued}</span>}
          {save === 'idle' && queued === 0 && data?.updatedAt && (
            <span className="muted">Последняя правка: {when(data.updatedAt)}</span>
          )}
        </span>

        {/* Отмена последнего изменения: без неё стёртый процент по восьмидесяти
            лавкам восстановить было нечем. */}
        {undo.length > 0 && !readOnly && (
          <button
            type="button"
            onClick={undoLast}
            title={`Отменить: ${undo[undo.length - 1].label} (Ctrl+Z)`}
            className="rounded-lg border px-2.5 py-1.5 text-xs"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          >
            ↩ Отменить ({undo.length})
          </button>
        )}

        {data?.tokenRequired && (
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              try {
                localStorage.setItem(TOKEN_KEY, e.target.value);
              } catch {
                // не запомнили — спросим ещё раз
              }
            }}
            placeholder="код доступа"
            className="ml-auto w-40 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          />
        )}
      </div>

      {readOnly && (
        <p className="surface p-3 text-sm" style={{ borderColor: 'var(--yellow)' }}>
          {data?.hint}
        </p>
      )}
      {error && (
        <p className="surface p-3 text-sm ink-red" style={{ borderColor: 'var(--red)' }}>
          {error}
        </p>
      )}

      {/* --- Фильтры: список из 80 лавок нужно уметь сузить --- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className={`relative w-40 ${shopCode ? 'has-clear' : ''}`}>
          <select
            value={shopCode}
            onChange={(e) => setShopCode(e.target.value)}
            aria-label="Лавка"
          >
            <option value="">Все лавки</option>
            {shopOptions.map((s) => (
              // В списке только код: с названием строка «М12 Покровка» вдвое
              // длиннее, а ищут здесь по номеру.
              <option key={s.code} value={s.code} title={s.name}>
                {s.code}
              </option>
            ))}
          </select>
          {shopCode && <ClearButton onClick={() => setShopCode('')} label="Сбросить фильтр по лавке" />}
        </div>
        <div className={`relative w-56 ${region ? 'has-clear' : ''}`}>
          <select
            value={region}
            onChange={(e) => {
              const next = e.target.value;
              setRegion(next);
              // Выбранная лавка могла выпасть из списка нового РМ — снимаем,
              // иначе фильтры противоречат друг другу и список пуст.
              if (next && shopCode && !shops.some((s) => s.code === shopCode && s.region === next)) {
                setShopCode('');
              }
            }}
            aria-label="Региональный менеджер"
          >
            <option value="">Все РМ</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {region && <ClearButton onClick={() => setRegion('')} label="Сбросить фильтр по РМ" />}
        </div>
        <label
          className="flex items-center gap-2 text-sm"
          title="Список фиксируется на момент включения: заполненная лавка остаётся на месте, пока её не спрятать вручную"
        >
          <input
            type="checkbox"
            checked={onlyEmpty}
            onChange={(e) => {
              setOnlyEmpty(e.target.checked);
              if (e.target.checked) relock();
            }}
          />
          только незаполненные
        </label>
        {onlyEmpty && doneInView > 0 && (
          <button
            type="button"
            onClick={relock}
            className="rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          >
            Спрятать заполненные ({doneInView})
          </button>
        )}
      </div>

      {/* --- Собственно список --- */}
      <div className="surface overflow-hidden">
        {data == null ? (
          <p className="p-6 text-sm muted">Загружаю день…</p>
        ) : visible.length === 0 ? (
          <p className="p-6 text-sm muted">Под фильтры не попала ни одна лавка.</p>
        ) : (
          <ul>
            {visible.map((shop, i) => {
              const value = percentOf(shop, drafts);
              return (
                <li
                  key={shop.code}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-3 py-2 first:border-0"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <span className="w-12 shrink-0 text-sm font-medium tabular-nums">{shop.code}</span>
                  {/* Лавка с поздним открытием: в 08:00 она ещё закрыта, и ноль
                      у неё означает не пустую витрину, а закрытую дверь. Метка
                      стоит перед названием, чтобы её нельзя было пролистать. */}
                  {shop.opensAt && (
                    <span
                      className="st-yellow shrink-0 rounded px-1.5 py-0.5 text-xs font-medium tabular-nums"
                      title={`Лавка открывается с ${shop.opensAt}, а не с общих 08:00`}
                    >
                      🕙 с {shop.opensAt}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm" title={shop.name}>
                    {shop.name.replace(/^[А-ЯA-Z]+\d+\s*/i, '')}
                    {shop.region && <span className="ml-2 text-xs muted">{shop.region}</span>}
                  </span>

                  {/* Комментарий: поле без рамки, пока пустое, — восемьдесят
                      строк с рамками превратили бы список в решётку. Рамка
                      появляется, когда в поле что-то есть или на нём фокус. */}
                  <input
                    value={noteOf(shop, noteDrafts)}
                    onChange={(e) => changeNote(shop.code, e.target.value)}
                    disabled={readOnly}
                    placeholder="комментарий"
                    title={noteOf(shop, noteDrafts) || 'Комментарий к лавке за этот день'}
                    aria-label={`Комментарий, ${shop.code}`}
                    className="showcase-note min-w-0 flex-1 basis-40 rounded-lg px-2 py-1.5 text-sm disabled:opacity-50 sm:max-w-xs"
                  />

                  <div className="flex items-center gap-1.5">
                    <input
                      ref={(el) => {
                        if (el) inputs.current.set(shop.code, el);
                        else inputs.current.delete(shop.code);
                      }}
                      value={value}
                      onChange={(e) => change(shop.code, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          focusNext(i);
                        }
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          const prev = visible[i - 1];
                          if (prev) inputs.current.get(prev.code)?.focus();
                        }
                      }}
                      onFocus={(e) => e.target.select()}
                      disabled={readOnly}
                      inputMode="decimal"
                      placeholder="—"
                      aria-label={`Наполнение витрины, ${shop.code}`}
                      className="w-20 rounded-lg border px-2 py-1.5 text-right text-sm tabular-nums disabled:opacity-50"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                      }}
                    />
                    <span className="w-4 text-xs muted">%</span>
                    <span
                      className={`st-${statusOf(shop, value, data.thresholds)} w-16 shrink-0 rounded px-2 py-1 text-center text-xs font-medium`}
                    >
                      {label(statusOf(shop, value, data.thresholds))}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs muted">
        Значение вводится в процентах. Enter или ↓ — следующая лавка, ↑ — предыдущая. Пустое поле
        означает «в этот день не заполняли»: такая лавка в средние значения не входит. Комментарий
        рядом — свободный текст на случай «не привезли ягоды»; на цифры он не влияет. Сохраняется
        само, а последнее изменение отменяется кнопкой «Отменить» или Ctrl+Z. Галочка
        «только незаполненные» фиксирует список: заполненная лавка не
        выпрыгивает из-под курсора на первой же цифре, а прячется по кнопке рядом с галочкой или
        при смене дня. Метка «🕙 с 10:00» — лавка открывается позже общих 08:00 (М71 Кузьминки, М72
        Ватутинки): раннее наполнение у неё считать не с чего.
      </p>
    </div>
  );
}

function noteOf(shop: ShopRow, drafts: Record<string, string>): string {
  const draft = drafts[shop.code];
  return draft !== undefined ? draft : shop.note;
}

function percentOf(shop: ShopRow, drafts: Record<string, string>): string {
  const draft = drafts[shop.code];
  if (draft !== undefined) return draft;
  return shop.percent == null ? '' : String(shop.percent);
}

/** Пока правка летит на сервер, статус считаем на месте — по тем же порогам. */
function statusOf(
  shop: ShopRow,
  value: string,
  thresholds: { green: number; yellow: number },
): Status {
  if (value === '') return 'no_data';
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 'no_data';

  const share = percent / 100;
  if (share >= thresholds.green) return 'green';
  if (share >= thresholds.yellow) return 'yellow';
  return 'red';
}

function label(status: Status): string {
  if (status === 'green') return '🟢 ок';
  if (status === 'yellow') return '🟡 ниже';
  if (status === 'red') return '🔴 мало';
  return '—';
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** «пн, 31 августа» — чтобы не гадать, какой это день недели. */
function humanDate(date: string): string {
  return formatDay(date, { weekday: 'short', day: 'numeric', month: 'long' });
}

/** Когда правку сохранили — по Москве, как и всё время на дашборде. */
function when(iso: string): string {
  return `${formatMoment(iso)} МСК`;
}

function StepButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      /* 44 пикселя: стрелками «вчера/завтра» пользуются с телефона чаще
         всего, а прежние 36 в высоту заставляли целиться. */
      className="flex size-11 items-center justify-center rounded-lg border text-sm"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {label}
    </button>
  );
}
