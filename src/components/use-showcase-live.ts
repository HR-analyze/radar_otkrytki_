'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PresenceEntry, PresenceFocus } from '@/lib/showcase-presence';

/**
 * Живая связь редактора витрин с остальными, кто сейчас заполняет.
 *
 * Раз в POLL_MS вкладка сообщает серверу, на какой строке стоит курсор, и
 * получает версию данных и метки остальных (см. /api/showcase/live). Редакторы
 * по смене версии тихо перечитывают свой день или лавку — цифры соседа
 * появляются без перезагрузки, — а по меткам рисуют «✍️ Иванова Ирина» на
 * строке, которую она сейчас заполняет.
 *
 * Опрос, а не веб-сокеты: на хостинге за прокси долгие соединения рвутся и
 * буферизуются, а запрос раз в четыре секунды проходит везде. Свёрнутая
 * вкладка не опрашивает вовсе и снимает свою метку.
 */

const POLL_MS = 4000;
const WHO_KEY = 'radar.who';

export interface ShowcaseLive {
  /** Как назвался человек: подписывает его метку у остальных. */
  who: string;
  setWho: (value: string) => void;
  /** Метки остальных: кто на какой строке стоит. */
  others: PresenceEntry[];
  /** Версия данных витрин на сервере; null — ещё не спрашивали. */
  version: string | null;
  /** Счётчик опросов: редактор повторяет отложенное перечитывание на каждом. */
  tick: number;
  /** Встал на строку (date + лавка) или ушёл с неё (null). */
  setFocus: (focus: PresenceFocus | null) => void;
}

function newClientId(): string {
  return `${Math.random().toString(36).slice(2, 12)}-${Date.now().toString(36)}`;
}

export function useShowcaseLive(): ShowcaseLive {
  const [client] = useState(newClientId);
  const [who, setWhoState] = useState('');
  const [others, setOthers] = useState<PresenceEntry[]>([]);
  const [version, setVersion] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const focus = useRef<PresenceFocus | null>(null);
  const whoRef = useRef('');
  const nudge = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(WHO_KEY) ?? '';
      setWhoState(saved);
      whoRef.current = saved;
    } catch {
      // Приватное окно — метка будет «кто-то».
    }
  }, []);

  const setWho = useCallback((value: string) => {
    setWhoState(value);
    whoRef.current = value;
    try {
      localStorage.setItem(WHO_KEY, value);
    } catch {
      // не запомнили — спросим в следующий раз
    }
  }, []);

  const send = useCallback(
    async (leaving = false) => {
      try {
        const res = await fetch('/api/showcase/live', {
          method: 'POST',
          keepalive: leaving,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client,
            who: whoRef.current,
            focus: leaving ? null : focus.current,
          }),
        });
        if (leaving) return;
        const body = (await res.json()) as { ok: boolean; version?: string; presence?: PresenceEntry[] };
        if (!body.ok) return;
        setVersion(body.version ?? null);
        setOthers(body.presence ?? []);
        setTick((n) => n + 1);
      } catch {
        // Сеть мигнула — следующий опрос через пару секунд.
      }
    },
    [client],
  );

  useEffect(() => {
    void send();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void send();
    }, POLL_MS);
    const onVisibility = () => {
      // Свернули — снимаем метку сразу, а не через 15 секунд тишины.
      if (document.visibilityState === 'hidden') void send(true);
      else void send();
    };
    const onLeave = () => void send(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onLeave);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onLeave);
      void send(true);
    };
  }, [send]);

  /**
   * Переход между строками — это blur одной и focus другой подряд. Отправляем
   * с маленькой задержкой, чтобы не слать «ушёл» и «пришёл» двумя запросами.
   */
  const setFocus = useCallback(
    (next: PresenceFocus | null) => {
      const same =
        next?.date === focus.current?.date && next?.shopCode === focus.current?.shopCode;
      focus.current = next;
      if (same) return;
      if (nudge.current) clearTimeout(nudge.current);
      nudge.current = setTimeout(() => void send(), 150);
    },
    [send],
  );

  return { who, setWho, others, version, tick, setFocus };
}

/**
 * Тихое перечитывание по смене версии: редактор отдаёт `refetch`, который
 * сам скачивает свой день или лавку и возвращает false, если ответ применять
 * нельзя (человек успел что-то набрать, сменил день). Тогда попробуем на
 * следующем опросе — версия всё ещё «не увиденная».
 */
export function useLiveRefresh(
  live: ShowcaseLive,
  isIdle: () => boolean,
  refetch: () => Promise<boolean>,
): void {
  const seen = useRef<string | null>(null);
  const busy = useRef(false);
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    const v = live.version;
    if (!v || v === seen.current || busy.current || !isIdle()) return;
    busy.current = true;
    void refetchRef
      .current()
      .then((ok) => {
        if (ok) seen.current = v;
      })
      .catch(() => {})
      .finally(() => {
        busy.current = false;
      });
  }, [live.version, live.tick, isIdle]);
}

/** Сколько держится подсветка «только что заполнил кто-то другой». */
export const FRESH_MS = 4000;
