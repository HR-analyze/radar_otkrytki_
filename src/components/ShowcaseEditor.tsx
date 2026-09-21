'use client';

import { useState } from 'react';
import { ShowcaseDayEditor } from './ShowcaseDayEditor';
import { ShowcaseShopEditor } from './ShowcaseShopEditor';

/**
 * Редактор наполнения витрин — два разреза одних и тех же данных.
 *
 * Раньше разрез был один: выбран день, в списке восемьдесят лавок. Он
 * рассчитан на заполнение по горячим следам и ровно для этого хорош. Но
 * заполнять приходится и задним числом — за неделю отпуска, за дни, которые
 * РМ прислал пачкой, — и тогда тот же экран заставляет переключать дату после
 * каждой цифры: одна лавка за пять дней стоит пяти перезагрузок списка.
 *
 * Поэтому разрезов теперь два, и переключаются они здесь:
 *
 *  · **день → лавки** (ShowcaseDayEditor) — как было;
 *  · **лавка → дни** (ShowcaseShopEditor) — одна лавка, дни столбиком.
 *
 * Данные общие: обе вкладки правят таблицу «дата + лавка» и шлют одинаковые
 * правки в /api/showcase. Общими остаются и фильтры — выбранные лавка и РМ
 * переезжают из режима в режим: человек, нашедший проблемную лавку в дневном
 * списке, переключается и видит её же по дням, а не начинает поиск заново.
 */

type Mode = 'day' | 'shop';

export function ShowcaseEditor({
  initialDate,
  initialMode = 'day',
  initialShop = '',
}: {
  initialDate: string;
  initialMode?: Mode;
  initialShop?: string;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [date, setDate] = useState(initialDate);
  // Лавка и РМ живут здесь, а не внутри режимов: в дневном это фильтр списка,
  // в полавочном — предмет работы, но человек считает их одним выбором.
  const [shopCode, setShopCode] = useState(initialShop);
  const [region, setRegion] = useState('');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex overflow-hidden rounded-lg border"
          style={{ borderColor: 'var(--border)' }}
          role="tablist"
          aria-label="Способ заполнения"
        >
          <ModeTab
            active={mode === 'day'}
            onClick={() => setMode('day')}
            title="Один день, все лавки: заполнение по горячим следам"
          >
            📅 День → лавки
          </ModeTab>
          <ModeTab
            active={mode === 'shop'}
            onClick={() => setMode('shop')}
            title="Одна лавка, несколько дней: дозаполнение задним числом без переключения дат"
          >
            🏪 Лавка → дни
          </ModeTab>
        </div>
        <span className="text-xs muted">
          {mode === 'day'
            ? 'Выбран день — в списке лавки.'
            : 'Выбрана лавка — в списке дни: вносить за несколько дней подряд, не переключая дату.'}
        </span>
      </div>

      {mode === 'day' ? (
        <ShowcaseDayEditor
          date={date}
          onDate={setDate}
          shopCode={shopCode}
          onShopCode={setShopCode}
          region={region}
          onRegion={setRegion}
        />
      ) : (
        <ShowcaseShopEditor
          shopCode={shopCode}
          onShopCode={setShopCode}
          region={region}
          onRegion={setRegion}
        />
      )}
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      role="tab"
      aria-selected={active}
      className="px-3 py-2 text-sm font-medium"
      style={{
        background: active ? 'var(--text)' : 'var(--surface)',
        color: active ? 'var(--surface)' : 'var(--text)',
      }}
    >
      {children}
    </button>
  );
}
