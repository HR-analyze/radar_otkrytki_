import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addFill,
  averagePercent,
  emptyAverage,
  formatPercent,
  leaderKey,
  leaderOf,
  leaderOptions,
  mergeAverages,
  parseLeaderKey,
} from './kpi';

const of = (...fills: number[]) => fills.reduce((acc, f) => addFill(acc, f), emptyAverage());

test('среднее за период — с одним знаком после запятой', () => {
  assert.equal(averagePercent(of(0.95, 0.94)), 94.5);
  assert.equal(averagePercent(of(1, 0.9, 0.9)), 93.3);
  assert.equal(averagePercent(of(0.8)), 80);
});

test('не мерили ни разу — среднего нет, а не 0%', () => {
  assert.equal(averagePercent(emptyAverage()), null);
  assert.equal(formatPercent(null), '—');
});

test('сумма в целых процентах: доли не копят хвост на границе порога', () => {
  // 0.95 * 3 / 3 в долях — 0.9499999…, и среднее съехало бы в жёлтую зону.
  assert.equal(averagePercent(of(0.95, 0.95, 0.95)), 95);
});

test('ТД и РМ усредняются по лавко-дням, а не по средним лавок', () => {
  const busy = of(1, 1); // две лавко-дня по 100%
  const rare = of(0.7); // один день, 70%

  // По средним лавок вышло бы (100 + 70) / 2 = 85.
  assert.equal(averagePercent(mergeAverages([busy, rare])), 90);
  assert.equal(mergeAverages([busy, rare]).days, 3);
});

test('процент пишется через запятую и всегда с одним знаком', () => {
  assert.equal(formatPercent(94.6), '94,6%');
  assert.equal(formatPercent(95), '95,0%');
  assert.equal(formatPercent(100), '100,0%');
});

test('руководитель: таблица «Лавки» важнее старого справочника', () => {
  assert.deepEqual(leaderOf({ director: 'Абрамова Дарья', territorial: null }, 'Старый ТД'), {
    kind: 'director',
    name: 'Абрамова Дарья',
  });
  assert.deepEqual(leaderOf({ director: null, territorial: 'Макарова Дарья' }, null), {
    kind: 'territorial',
    name: 'Макарова Дарья',
  });
  // Лавки нет в таблице — ТД из справочника, директор без имени.
  assert.deepEqual(leaderOf(undefined, 'Репников Алексей'), { kind: 'territorial', name: 'Репников Алексей' });
  assert.deepEqual(leaderOf(undefined, null), { kind: 'director', name: null });
});

test('фильтр «Руководитель»: ключ в адресе туда и обратно', () => {
  const td = { kind: 'territorial' as const, name: 'Макарова Дарья' };
  assert.equal(leaderKey(td), 'td:Макарова Дарья');
  assert.deepEqual(parseLeaderKey('td:Макарова Дарья'), td);
  assert.deepEqual(parseLeaderKey('dir:Абрамова Дарья'), { kind: 'director', name: 'Абрамова Дарья' });
  assert.equal(leaderKey({ kind: 'director', name: null }), null, 'безымянного директора не выбрать');
  assert.equal(parseLeaderKey('Макарова Дарья'), null, 'без приставки — мусор');
});

test('варианты фильтра: без повторов, по алфавиту, безымянных нет', () => {
  const options = leaderOptions([
    { kind: 'director', name: 'Елесина Анастасия' },
    { kind: 'director', name: 'Абрамова Дарья' },
    { kind: 'director', name: 'Абрамова Дарья' },
    { kind: 'territorial', name: 'Макарова Дарья' },
    { kind: 'director', name: null },
  ]);
  assert.deepEqual(options, { territorial: ['Макарова Дарья'], directors: ['Абрамова Дарья', 'Елесина Анастасия'] });
});
