'use client';

import { useEffect, useState } from 'react';

/**
 * Переключатель темы: система → светлая → тёмная → снова система.
 *
 * До этого тема бралась только из настроек операционной системы. На практике
 * человек сидит в светлой системе, а радар открывает в тёмном кабинете лавки —
 * и наоборот; выбора у него не было никакого.
 *
 * Выбор ставит атрибут data-theme на <html> (его читает globals.css) и
 * запоминается в localStorage — хранилище браузера, которое переживает
 * перезагрузку вкладки. «Система» атрибут снимает и возвращает всё как было.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'radar.theme';

/**
 * Скрипт, который выставляет тему ДО первой отрисовки.
 *
 * Без него человек с выбранной тёмной темой ловит вспышку белого экрана:
 * разметка приезжает светлой, и только потом React успевает переключить.
 * Поэтому он идёт прямо в <head> обычным <script>, а не в компоненте.
 */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t}}catch(e){}`;

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const FACE: Record<ThemeChoice, { icon: string; title: string }> = {
  system: { icon: '🖥', title: 'Тема: как в системе' },
  light: { icon: '☀', title: 'Тема: светлая' },
  dark: { icon: '🌙', title: 'Тема: тёмная' },
};

export function ThemeToggle() {
  /**
   * Сервер не знает выбор человека, поэтому первый рендер всегда «система»:
   * иначе разметка на сервере и в браузере разошлись бы и React ругался бы
   * на несовпадение. Настоящее значение подставляем сразу после монтирования.
   */
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'dark' || saved === 'light') setChoice(saved);
    } catch {
      // Приватное окно — остаёмся на системной теме.
    }
    setReady(true);
  }, []);

  function apply(next: ThemeChoice) {
    setChoice(next);
    const root = document.documentElement;
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Не запомнили — переживём, в этой вкладке тема уже применена.
    }
  }

  const face = FACE[choice];

  return (
    <button
      type="button"
      onClick={() => apply(NEXT[choice])}
      title={`${face.title}. Нажмите, чтобы переключить`}
      aria-label={`${face.title}. Нажмите, чтобы переключить`}
      /* До того как прочитан выбор, кнопка неактивна: иначе первый клик
         увёл бы тему не от той отправной точки, которая на экране. */
      disabled={!ready}
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border text-sm transition-opacity disabled:opacity-40"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <span aria-hidden>{face.icon}</span>
    </button>
  );
}
