'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Status } from '@/lib/types';

/**
 * Общая машинка сохранения для обоих редакторов витрин — дневного
 * (день → лавки) и полавочного (лавка → дни).
 *
 * Оба правят одну и ту же таблицу «дата + лавка», и всё осторожное, что
 * накопилось вокруг записи, должно работать одинаково:
 *
 *  · сохранение само, через полсекунды после ввода — кнопки «Сохранить»,
 *    которую можно забыть, нет;
 *  · уход со страницы дописывает очередь keepalive-запросом;
 *  · сетевой сбой возвращает пачку в очередь, а не теряет её;
 *  · Ctrl+Z отменяет последнее изменение.
 *
 * Ключ правки — **дата и лавка**, а не одна лавка. Дневной редактор помнил
 * только код лавки, а дату подставлял из своего состояния в момент отправки.
 * Пока дата на экране была одна, это почти сходилось; ломалось на очереди,
 * пережившей сетевой сбой: не отправленная правка лежала в очереди без даты,
 * и следующая отправка — уже с другого дня — записывала её в тот день, что
 * открыт сейчас. В полавочном режиме, где дата своя у каждой строки, такой
 * ключ не работал бы вовсе.
 */

/** Столько же, сколько принимает сервер (см. /api/showcase). */
export const MAX_NOTE = 300;

const TOKEN_KEY = 'radar.uploadToken';
/** Пауза после последнего нажатия клавиши, чтобы не слать запрос на каждую цифру. */
const SAVE_DEBOUNCE_MS = 500;
/** Сколько «Сохранено» висит на экране, прежде чем погаснуть. */
const SAVED_BADGE_MS = 2500;
/** Глубина отмены: дальше вспомнить, что именно правил, всё равно нельзя. */
const UNDO_DEPTH = 50;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
/** percent — утренний замер, afternoonPercent — замер в 16:00. */
export type EditField = 'percent' | 'afternoonPercent' | 'note';

/** Строка, как её вернул сервер после сохранения: по ней красят ячейку. */
export interface SavedRow {
  date: string;
  shopCode: string;
  percent: number | null;
  afternoonPercent: number | null;
  /** Статус итога дня — среднего двух замеров. */
  status: Status;
  note: string;
}

/** Одна отменяемая правка: что было в поле до того, как его тронули. */
interface UndoStep {
  date: string;
  shopCode: string;
  field: EditField;
  before: string;
  label: string;
}

const cellKey = (date: string, shopCode: string, field: EditField): string =>
  `${date}|${shopCode}|${field}`;
const rowKey = (date: string, shopCode: string): string => `${date}|${shopCode}`;

export interface ShowcaseEdits {
  /** Код доступа к записи: его спрашивают, когда задан RADAR_UPLOAD_TOKEN. */
  token: string;
  setToken: (value: string) => void;
  save: SaveState;
  error: string | null;
  /** Сколько правок ещё не доехало до сервера — видно человеку, а не только коду. */
  queued: number;
  undo: UndoStep[];
  undoLast: () => void;
  /** Набранное, но, возможно, ещё не сохранённое значение ячейки. */
  draft: (date: string, shopCode: string, field: EditField) => string | undefined;
  /** Правка поля: чистит ввод, кладёт в очередь и в стек отмены. */
  edit: (
    date: string,
    shopCode: string,
    field: EditField,
    raw: string,
    before: string,
    label: string,
  ) => void;
  /** Дописать очередь немедленно — перед сменой дня, лавки или периода. */
  flush: () => void;
  /** Забыть черновики и отмену: под редактором сменился набор данных. */
  reset: () => void;
  setError: (message: string | null) => void;
}

export function useShowcaseEdits(onSaved: (rows: SavedRow[]) => void): ShowcaseEdits {
  const router = useRouter();
  const [token, setTokenState] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoStep[]>([]);
  const [queued, setQueued] = useState(0);

  // Копим правки по полям: оба замера и комментарий одной строки правят
  // независимо, и отправить нужно ровно то, что человек трогал.
  const pending = useRef<Map<string, Partial<Record<EditField, string>>>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Состояние сохранения для обработчиков, живущих вне рендера (см. beforeunload). */
  const saveRef = useRef<SaveState>('idle');
  /**
   * Свежая отправка для reset(). Сама отправка пересоздаётся при смене кода
   * доступа, и если бы reset зависел от неё напрямую, то каждая буква,
   * набранная в поле кода, меняла бы reset — а редакторы держат его в
   * зависимостях загрузки и перезапрашивали бы день на каждое нажатие.
   */
  const flushRef = useRef<(leaving?: boolean) => Promise<void>>(async () => {});
  /** Свежий обработчик ответа, чтобы отправка не пересоздавалась на каждый рендер. */
  const savedRef = useRef(onSaved);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    savedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    try {
      setTokenState(localStorage.getItem(TOKEN_KEY) ?? '');
    } catch {
      // Приватное окно — код спросим заново.
    }
  }, []);

  const setToken = useCallback((value: string) => {
    setTokenState(value);
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {
      // не запомнили — спросим ещё раз
    }
  }, []);

  /**
   * Отправляем накопленные правки одной пачкой.
   *
   * `leaving` — уходим со страницы. Тогда запрос помечается keepalive: браузер
   * обязуется доставить его, даже если вкладку уже закрыли. Без этой пометки
   * обработчик beforeunload запускал обычный fetch и вкладка закрывалась
   * раньше, чем он уходил, — последние полсекунды ввода пропадали молча.
   */
  const flush = useCallback(
    async (leaving = false) => {
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
            edits: batch.map(([key, fields]) => {
              const [date, shopCode] = key.split('|');
              return {
                date,
                shopCode,
                // Ключ кладём только для тронутого поля: иначе правка
                // комментария стёрла бы процент, и наоборот.
                ...(fields.percent !== undefined ? { percent: fields.percent || null } : {}),
                ...(fields.afternoonPercent !== undefined
                  ? { afternoonPercent: fields.afternoonPercent || null }
                  : {}),
                ...(fields.note !== undefined ? { note: fields.note } : {}),
              };
            }),
          }),
        });
        const body = (await res.json()) as { ok: boolean; error?: string; saved?: SavedRow[] };
        if (!res.ok || !body.ok) throw new Error(body.error ?? `Сервер ответил ${res.status}`);

        savedRef.current(body.saved ?? []);
        setSave('saved');
        setError(null);
        router.refresh();
      } catch (e) {
        /*
         * Пачку возвращаем в очередь: она была вычищена перед отправкой, и при
         * сетевом сбое правки исчезали совсем — человек видел «не удалось
         * сохранить», нажимал ещё раз и отправлял пустоту.
         */
        for (const [key, fields] of batch) {
          pending.current.set(key, { ...fields, ...pending.current.get(key) });
        }
        setQueued(pending.current.size);
        setSave('error');
        setError(e instanceof Error ? e.message : 'Не удалось сохранить');
      }
    },
    [router, token],
  );

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

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

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [flush]);

  const queue = useCallback(
    (date: string, shopCode: string, patch: Partial<Record<EditField, string>>) => {
      const key = rowKey(date, shopCode);
      pending.current.set(key, { ...pending.current.get(key), ...patch });
      setQueued(pending.current.size);
      schedule();
    },
    [schedule],
  );

  /**
   * Кладём в стек отмены прежнее значение поля — но только первую правку
   * подряд: иначе набранные «9», «95» дали бы два шага отмены на одно
   * осмысленное действие, и «отменить» пришлось бы жать по букве.
   */
  const remember = useCallback((step: UndoStep) => {
    setUndo((prev) => {
      const last = prev[prev.length - 1];
      if (
        last &&
        last.date === step.date &&
        last.shopCode === step.shopCode &&
        last.field === step.field
      ) {
        return prev;
      }
      return [...prev, step].slice(-UNDO_DEPTH);
    });
  }, []);

  const edit = useCallback<ShowcaseEdits['edit']>(
    (date, shopCode, field, raw, before, label) => {
      const value =
        field === 'note'
          ? raw.slice(0, MAX_NOTE)
          : raw.replace(',', '.').replace(/[^\d.]/g, '').slice(0, 5);

      remember({ date, shopCode, field, before, label });
      setDrafts((d) => ({ ...d, [cellKey(date, shopCode, field)]: value }));
      queue(date, shopCode, { [field]: value });
    },
    [queue, remember],
  );

  /** Вернуть последнее изменённое поле к тому, что в нём было. */
  const undoLast = useCallback(() => {
    setUndo((prev) => {
      const step = prev[prev.length - 1];
      if (!step) return prev;

      setDrafts((d) => ({ ...d, [cellKey(step.date, step.shopCode, step.field)]: step.before }));
      const key = rowKey(step.date, step.shopCode);
      pending.current.set(key, {
        ...pending.current.get(key),
        [step.field]: step.before,
      });

      setQueued(pending.current.size);
      schedule();
      return prev.slice(0, -1);
    });
  }, [schedule]);

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

  const draft = useCallback(
    (date: string, shopCode: string, field: EditField) => drafts[cellKey(date, shopCode, field)],
    [drafts],
  );

  /**
   * Смена дня, лавки или периода. Очередь перед этим дописываем, а не бросаем:
   * у каждой правки своя дата, потеряться ей незачем.
   *
   * Стек отмены обнуляется вместе с набором данных: «отменить» должно вернуть
   * то поле, которое человек видит, а не то, которое он оставил два экрана
   * назад.
   */
  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void flushRef.current();
    setDrafts({});
    setUndo([]);
    setError(null);
  }, []);

  return {
    token,
    setToken,
    save,
    error,
    queued,
    undo,
    undoLast,
    draft,
    edit,
    flush: () => void flush(),
    reset,
    setError,
  };
}
