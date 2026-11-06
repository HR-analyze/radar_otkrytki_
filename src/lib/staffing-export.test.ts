import test from 'node:test';
import assert from 'node:assert/strict';
import { readStaffing } from './staffing-store';
import { selectStaffing, staffingFilename } from './staffing-export';

test('выгрузка «Графика пиков»: без лавки — вся сеть, с лавкой — она одна, как на вкладке', () => {
  const seed = readStaffing();
  const all = selectStaffing(seed, null);
  assert.ok(!('error' in all));
  assert.equal(all.shop, null);
  assert.equal(all.shown.length, seed.norms.length);

  // Лавку ищем так же, как страница: «м50» и «M50» латиницей — тоже М50.
  for (const q of ['М50', 'м50', 'M50', ' М50 ']) {
    const one = selectStaffing(seed, q);
    assert.ok(!('error' in one), q);
    assert.equal(one.shop?.code, 'М50', q);
    assert.deepEqual(one.shown.map((n) => n.code), ['М50'], q);
  }
});

test('выгрузка «Графика пиков»: неизвестная лавка и пустой шаблон — ошибка, а не пустой файл', () => {
  assert.match((selectStaffing(readStaffing(), 'М999') as { error: string }).error, /М999/);
  assert.ok('error' in selectStaffing({ norms: [] }, null));
});

test('имя файла латиницей, с лавкой и датой', () => {
  const m50 = readStaffing().norms.find((n) => n.code === 'М50')!;
  assert.equal(staffingFilename('pdf', null, '2026-10-28'), 'grafik-pikov-2026-10-28.pdf');
  assert.equal(staffingFilename('xlsx', m50, '2026-10-28'), 'grafik-pikov-M50-2026-10-28.xlsx');
});

test('выгрузка «Графика пиков» по РМ: только его лавки, лавка важнее РМ', () => {
  const seed = readStaffing();
  const codes = new Set(['М1', 'М50']);
  const byRegion = selectStaffing(seed, null, { name: 'Иванов', codes });
  assert.ok(!('error' in byRegion));
  assert.equal(byRegion.region, 'Иванов');
  assert.deepEqual(byRegion.shown.map((n) => n.code).sort(), ['М1', 'М50']);

  const shop = selectStaffing(seed, 'М9', { name: 'Иванов', codes });
  assert.ok(!('error' in shop));
  assert.deepEqual(shop.shown.map((n) => n.code), ['М9']);

  assert.match((selectStaffing(seed, null, { name: 'Никто', codes: new Set() }) as { error: string }).error, /Никто/);
  assert.equal(staffingFilename('pdf', null, '2026-10-28', 'Иванов'), 'grafik-pikov-Ivanov-2026-10-28.pdf');
  assert.equal(staffingFilename('xlsx', null, '2026-10-28', 'Карабак Денис'), 'grafik-pikov-Karabak-Denis-2026-10-28.xlsx');
});
