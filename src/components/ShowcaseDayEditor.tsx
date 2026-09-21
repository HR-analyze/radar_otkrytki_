'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { plural } from '@/lib/plural';
import { shiftDate } from '@/lib/showcase-range';
import type { Status } from '@/lib/types';
import { ClearButton } from './ClearButton';
import {
  FIELD_STYLE,
  SaveBadge,
  StepButton,
  TokenInput,
  UndoButton,
  humanDate,
  statusLabel,
  statusOf,
} from './showcase-ui';
import { useShowcaseEdits, type SavedRow } from './use-showcase-edits';

/**
 * Первый способ заполнения: **выбран день — в списке лавки.**
 *
 * Так заполняют по горячим следам: человек садится вечером и проходит день по
 * списку восьмидесяти лавок. День переключается стрелками, значение вводится
 * числом, Enter — вниз, статус 🟢/🟡/🔴 появляется прямо в строке, счётчик
 * «заполнено N из 80» показывает, сколько осталось.
 *
 * Дозаполнять пропуски задним числом здесь неудобно — для этого есть второй
 * режим, «лавка → дни» (см. ShowcaseShopEditor).
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

export function ShowcaseDayEditor({
  date,
  onDate,
  shopCode,
  onShopCode,
  region,
  onRegion,
}: {
  date: string;
  onDate: (date: string) => void;
  shopCode: string;
  onShopCode: (code: string) => void;
  region: string;
  onRegion: (region: string) => void;
}) {
  const [data, setData] = useState<DayData | null>(null);
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  // Список лавок под галочкой «только незаполненные» замораживается: без этого
  // строка вылетала бы из фильтра после первой же цифры («9» — уже не пусто),
  // и дописать «95» было бы некуда. Набор пересобирается при включении галочки,
  // при смене дня и по кнопке «спрятать заполненные».
  const [emptyLock, setEmptyLock] = useState<Set<string>>(new Set());
  const inputs = useRef<Map<string, HTMLInputElement>>(new Map());

  // Красим строки по ответу сервера, а не по своей догадке о порогах.
  const applySaved = useCallback(
    (rows: SavedRow[]) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              shops: prev.shops.map((s) => {
                const saved = rows.find((x) => x.shopCode === s.code && x.date === prev.date);
                return saved
                  ? { ...s, percent: saved.percent, status: saved.status, note: saved.note }
                  : s;
              }),
            }
          : prev,
      );
    },
    [],
  );

  const edits = useShowcaseEdits(applySaved);
  const { reset, setError } = edits;

  const load = useCallback(
    async (day: string) => {
      const res = await fetch(`/api/showcase?date=${day}`);
      const body = (await res.json()) as DayData;
      setData(body);
      setEmptyLock(new Set((body.shops ?? []).filter((s) => s.percent == null).map((s) => s.code)));
      if (!body.ok) setError(body.error ?? 'Не удалось загрузить день');
    },
    [setError],
  );

  useEffect(() => {
    // Очередь дописываем и забываем черновики: под редактором сменился день.
    reset();
    void load(date);
  }, [date, load, reset]);

  const shops = data?.shops ?? [];
  const thresholds = data?.thresholds ?? { green: 1, yellow: 1 };

  const percentOf = useCallback(
    (shop: ShopRow): string =>
      edits.draft(date, shop.code, 'percent') ?? (shop.percent == null ? '' : String(shop.percent)),
    [edits, date],
  );
  const noteOf = useCallback(
    (shop: ShopRow): string => edits.draft(date, shop.code, 'note') ?? shop.note,
    [edits, date],
  );

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
        if (onlyEmpty && !emptyLock.has(s.code) && percentOf(s) !== '') return false;
        return true;
      }),
    [shops, region, shopCode, onlyEmpty, emptyLock, percentOf],
  );

  const filled = shops.filter((s) => percentOf(s) !== '').length;
  /** Сколько строк остались в списке только благодаря замку — их можно спрятать. */
  const doneInView = onlyEmpty ? visible.filter((s) => percentOf(s) !== '').length : 0;
  const relock = () => setEmptyLock(new Set(shops.filter((s) => percentOf(s) === '').map((s) => s.code)));
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
          <StepButton label="←" title="Предыдущий день" onClick={() => onDate(shiftDate(date, -1))} />
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && onDate(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
            style={FIELD_STYLE}
          />
          <StepButton label="→" title="Следующий день" onClick={() => onDate(shiftDate(date, 1))} />
        </div>

        {/* Нативное поле даты показывает формат системы — подписываем по-русски. */}
        <span className="text-sm font-medium">{humanDate(date)}</span>

        <span className="text-sm">
          Заполнено <b className="tabular-nums">{filled}</b> из {shops.length}{' '}
          {plural(shops.length, 'лавки', 'лавок', 'лавок')}
        </span>

        <SaveBadge save={edits.save} queued={edits.queued} updatedAt={data?.updatedAt} />

        {edits.undo.length > 0 && !readOnly && (
          <UndoButton
            count={edits.undo.length}
            label={edits.undo[edits.undo.length - 1].label}
            onClick={edits.undoLast}
          />
        )}

        {data?.tokenRequired && <TokenInput value={edits.token} onChange={edits.setToken} />}
      </div>

      {readOnly && (
        <p className="surface p-3 text-sm" style={{ borderColor: 'var(--yellow)' }}>
          {data?.hint}
        </p>
      )}
      {edits.error && (
        <p className="surface p-3 text-sm ink-red" style={{ borderColor: 'var(--red)' }}>
          {edits.error}
        </p>
      )}

      {/* --- Фильтры: список из 80 лавок нужно уметь сузить --- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className={`relative w-40 ${shopCode ? 'has-clear' : ''}`}>
          <select value={shopCode} onChange={(e) => onShopCode(e.target.value)} aria-label="Лавка">
            <option value="">Все лавки</option>
            {shopOptions.map((s) => (
              // В списке только код: с названием строка «М12 Покровка» вдвое
              // длиннее, а ищут здесь по номеру.
              <option key={s.code} value={s.code} title={s.name}>
                {s.code}
              </option>
            ))}
          </select>
          {shopCode && <ClearButton onClick={() => onShopCode('')} label="Сбросить фильтр по лавке" />}
        </div>
        <div className={`relative w-56 ${region ? 'has-clear' : ''}`}>
          <select
            value={region}
            onChange={(e) => {
              const next = e.target.value;
              onRegion(next);
              // Выбранная лавка могла выпасть из списка нового РМ — снимаем,
              // иначе фильтры противоречат друг другу и список пуст.
              if (next && shopCode && !shops.some((s) => s.code === shopCode && s.region === next)) {
                onShopCode('');
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
          {region && <ClearButton onClick={() => onRegion('')} label="Сбросить фильтр по РМ" />}
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
            style={FIELD_STYLE}
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
              const value = percentOf(shop);
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

                  {/*
                    Процент стоит в разметке раньше комментария, а на экране
                    остаётся справа от него (order): так устроен порядок Tab.

                    Раньше поля шли в обратном порядке, и Tab из процента уводил
                    в комментарий СОСЕДНЕЙ лавки — человек, проходящий день по
                    списку, через раз оказывался не там, где думал. Теперь Tab
                    остаётся внутри строки: процент → комментарий той же лавки →
                    процент следующей.
                  */}
                  <div className="order-2 flex items-center gap-1.5">
                    <input
                      ref={(el) => {
                        if (el) inputs.current.set(shop.code, el);
                        else inputs.current.delete(shop.code);
                      }}
                      value={value}
                      onChange={(e) =>
                        edits.edit(date, shop.code, 'percent', e.target.value, value, `${shop.code}: наполнение`)
                      }
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
                      style={FIELD_STYLE}
                    />
                    <span className="w-4 text-xs muted">%</span>
                    <span
                      className={`st-${statusOf(value, thresholds)} w-16 shrink-0 rounded px-2 py-1 text-center text-xs font-medium`}
                    >
                      {statusLabel(statusOf(value, thresholds))}
                    </span>
                  </div>

                  {/* Комментарий: поле без рамки, пока пустое, — восемьдесят
                      строк с рамками превратили бы список в решётку. Рамка
                      появляется, когда в поле что-то есть или на нём фокус. */}
                  <input
                    value={noteOf(shop)}
                    onChange={(e) =>
                      edits.edit(date, shop.code, 'note', e.target.value, noteOf(shop), `${shop.code}: комментарий`)
                    }
                    onKeyDown={(e) => {
                      // Дописал пояснение — Enter продолжает тот же ритм, что
                      // и в поле процента: вниз, к следующей лавке.
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        focusNext(i);
                      }
                    }}
                    disabled={readOnly}
                    placeholder="комментарий"
                    title={noteOf(shop) || 'Комментарий к лавке за этот день'}
                    aria-label={`Комментарий, ${shop.code}`}
                    className="showcase-note order-1 min-w-0 flex-1 basis-40 rounded-lg px-2 py-1.5 text-sm disabled:opacity-50 sm:max-w-xs"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs muted">
        Значение вводится в процентах. Enter или ↓ — следующая лавка, ↑ — предыдущая,
        Tab — комментарий этой же лавки. Пустое поле
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
