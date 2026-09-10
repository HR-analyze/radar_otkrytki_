'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { findShops } from '@/lib/shops';
import { ClearButton } from './ClearButton';

export interface ShopOption {
  code: string;
  name: string;
}

/**
 * Поиск лавки: поле ввода со списком подсказок, а не выпадающий список на
 * восемьдесят строк. Код набирается за два символа, название — за три, и
 * «М1» при этом означает ровно М1, а не М1 вместе с М10–М19 (см. findShops).
 *
 * Значение уходит не на каждую букву: 400 мс тишины — тогда запрос. Enter
 * отправляет сразу, Esc очищает.
 */
export function ShopSearch({
  value,
  shops,
  onChange,
  listId,
  placeholder = 'Все',
  pending = false,
}: {
  value: string;
  shops: readonly ShopOption[];
  onChange: (value: string | undefined) => void;
  /** id для <datalist>: на странице таких полей может быть несколько. */
  listId: string;
  placeholder?: string;
  /** Страница пересобирается под новый запрос — показываем это в поле. */
  pending?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [typing, setTyping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Значение могли поменять снаружи — например, кнопкой «назад» в браузере
  // или переходом на другую лавку.
  useEffect(() => setDraft(value), [value]);

  // Таймер переживает размонтирование: без уборки он дёрнул бы onChange уже
  // после ухода со страницы.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function edit(next: string) {
    setDraft(next);
    setTyping(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setTyping(false);
      onChange(next.trim() || undefined);
    }, 400);
  }

  /**
   * Пока идут те самые 400 мс тишины плюс сборка страницы, поле ничем не
   * отвечало: человек набирал «Покров», полсекунды смотрел на неизменившийся
   * список и успевал решить, что поиск сломан.
   */
  const busy = typing || pending;

  return (
    <div className="relative">
      <input
        value={draft}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (timer.current) clearTimeout(timer.current);
            setTyping(false);
            onChange(draft.trim() || undefined);
          }
          if (e.key === 'Escape') {
            if (timer.current) clearTimeout(timer.current);
            setDraft('');
            setTyping(false);
            onChange(undefined);
          }
        }}
        list={listId}
        placeholder={placeholder}
        aria-label="Лавка: код или название"
        aria-busy={busy}
        className="w-full rounded-lg border px-3 py-2 pr-8 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
      />
      {busy ? (
        <span
          aria-hidden
          title="Ищу…"
          className="absolute top-1/2 right-2.5 -translate-y-1/2 text-xs muted"
        >
          ⌛
        </span>
      ) : (
        draft && (
          <ClearButton
            onClick={() => {
              if (timer.current) clearTimeout(timer.current);
              setDraft('');
              setTyping(false);
              onChange(undefined);
            }}
            label="Сбросить фильтр по лавке"
          />
        )
      )}
      {/*
        Раньше в подсказку клали код, а название — текстом опции: Chrome
        показывал их рядом, Firefox — только код, и искать по названию через
        подсказки было нельзя. Кладём название целиком («М12 Даниловская
        мануфактура») — оно и так начинается с кода, поэтому находится и по
        нему, и по слову из названия (см. matchesShop).
      */}
      <datalist id={listId}>
        {shops.map((s) => (
          <option key={s.code} value={s.name} />
        ))}
      </datalist>
    </div>
  );
}

/**
 * То же поле, но в карточке лавки: там фильтровать нечего — карточка всегда
 * про одну лавку, поэтому поле работает переключателем.
 *
 * Куда ведёт запрос:
 *   · одна лавка («М12», «Покровка») → её карточка, период сохраняется;
 *   · несколько («ская») → радар с этим же фильтром: выбрать из списка
 *     можно только там;
 *   · ничего не нашлось → остаёмся на месте и говорим об этом. Уводить
 *     человека на пустой радар за опечатку — худшее, что можно сделать;
 *   · пусто (крестик или Esc) → радар по всем лавкам: «все лавки» — это он.
 */
export function ShopSwitcher({
  code,
  shops,
  from,
  to,
}: {
  /** Код лавки, чья карточка открыта. */
  code: string;
  shops: readonly ShopOption[];
  from: string;
  to: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [missed, setMissed] = useState<string | null>(null);

  const period = `from=${from}&to=${to}`;

  function go(query: string | undefined) {
    if (!query) {
      setMissed(null);
      startTransition(() => router.push(`/radar?${period}`));
      return;
    }

    const found = findShops(shops, query);
    if (found.length === 0) {
      setMissed(query);
      return;
    }

    setMissed(null);
    // Уже на этой карточке — лишний переход только моргнёт экраном.
    if (found.length === 1 && found[0].code === code) return;

    const href =
      found.length === 1
        ? `/shop/${encodeURIComponent(found[0].code)}?${period}`
        : `/radar?${period}&shop=${encodeURIComponent(query)}`;
    startTransition(() => router.push(href));
  }

  return (
    <div
      className="surface flex flex-wrap items-end gap-x-4 gap-y-2 p-3"
      style={{ cursor: pending ? 'progress' : undefined }}
    >
      <label className="flex min-w-0 flex-col gap-1 sm:w-64">
        <span className="text-xs muted">Лавка</span>
        <ShopSearch
          value={code}
          shops={shops}
          onChange={go}
          listId="shop-switcher"
          pending={pending}
        />
      </label>

      <p className="text-xs muted">
        {missed ? (
          <span className="ink-yellow">
            По запросу «{missed}» лавок нет — попробуй код (М17) или часть названия.
          </span>
        ) : (
          'Код или часть названия — перейдём на её карточку за тот же период.'
        )}
      </p>
    </div>
  );
}
