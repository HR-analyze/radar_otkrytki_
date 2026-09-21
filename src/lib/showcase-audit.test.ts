import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Журнал правок витрин. База — своя, во временной папке: переменные окружения
 * выставляются до первого импорта модуля, как и в showcase-store.test.ts.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-audit-'));
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'seed.json');

fs.writeFileSync(
  process.env.RADAR_SHOWCASE_PATH,
  JSON.stringify({
    updatedAt: '2026-09-01T00:00:00.000Z',
    touched: { '2026-09-01': '2026-09-01T00:00:00.000Z' },
    days: { '2026-09-01': { М22: 0.95 } },
  }),
);

let store: typeof import('./showcase-store');
let audit: typeof import('./showcase-audit');
before(async () => {
  store = await import('./showcase-store');
  audit = await import('./showcase-audit');
});

test('журнал хранит прежнее значение — ради него он и заведён', async () => {
  // Ровно тот вопрос, с которого всё началось: утром лавка была зелёная, днём
  // жёлтая. В showcase_fill к этому моменту лежит только 0.9.
  await store.saveShowcaseEdits([{ date: '2026-09-21', shopCode: 'М22', fill: 0.97 }], {
    source: 'ui',
    now: '2026-09-21T06:10:00.000Z',
  });
  await store.saveShowcaseEdits([{ date: '2026-09-21', shopCode: 'М22', fill: 0.9 }], {
    source: 'ui',
    now: '2026-09-21T10:40:00.000Z',
  });

  const log = await audit.readShowcaseAudit({ date: '2026-09-21', shopCode: 'М22' });
  assert.equal(log.length, 2, 'обе правки на месте');
  assert.deepEqual(
    log.map((e) => [e.from, e.to]),
    [
      ['0.97', '0.9'],
      [null, '0.97'],
    ],
    'свежая сверху; первая правка пришла на пустое место',
  );
  assert.equal(log[0].at, '2026-09-21T10:40:00.000Z');
  assert.equal(log[0].source, 'ui');
});

test('повтор того же значения в журнал не попадает', async () => {
  const before = (await audit.readShowcaseAudit({ date: '2026-09-22' })).length;
  await store.saveShowcaseEdits([{ date: '2026-09-22', shopCode: 'М1', fill: 0.8 }]);
  await store.saveShowcaseEdits([{ date: '2026-09-22', shopCode: 'М1', fill: 0.8 }]);

  const log = await audit.readShowcaseAudit({ date: '2026-09-22' });
  assert.equal(log.length - before, 1, 'сохранение того же числа — не правка');
});

test('стирание значения видно в журнале, хотя строки в базе уже нет', async () => {
  await store.saveShowcaseEdits([{ date: '2026-09-23', shopCode: 'М5', fill: 0.7 }]);
  await store.saveShowcaseEdits([{ date: '2026-09-23', shopCode: 'М5', fill: null }]);

  const log = await audit.readShowcaseAudit({ date: '2026-09-23', shopCode: 'М5' });
  assert.deepEqual([log[0].from, log[0].to], ['0.7', null], 'было 70%, стёрли');

  const read = await store.readShowcase();
  assert.equal(read.days['2026-09-23']?.['М5'], undefined, 'в самих витринах следа не осталось');
});

test('комментарий пишется в журнал отдельным полем', async () => {
  await store.saveShowcaseEdits([
    { date: '2026-09-24', shopCode: 'М7', fill: 0.6, note: 'не привезли ягоды' },
  ]);

  const log = await audit.readShowcaseAudit({ date: '2026-09-24', shopCode: 'М7' });
  assert.deepEqual(
    log.map((e) => e.field).sort(),
    ['fill', 'note'],
    'одна правка, два изменённых поля — две записи',
  );
  assert.equal(log.find((e) => e.field === 'note')?.to, 'не привезли ягоды');
});

test('источник правки различает сайт и залитую книгу', async () => {
  await store.saveShowcaseEdits([{ date: '2026-09-25', shopCode: 'М9', fill: 0.5 }], {
    source: 'upload',
  });

  const [entry] = await audit.readShowcaseAudit({ date: '2026-09-25', shopCode: 'М9' });
  assert.equal(entry.source, 'upload');
  assert.equal(audit.SOURCE_TITLE[entry.source], 'из книги «Витрины»');
});

test('код лавки в отборе ищется в любом написании', async () => {
  // «м22» строчными и «M22» латиницей — то же самое, что М22: код вводят руками.
  for (const asked of ['м22', 'M22', ' М22 ']) {
    const log = await audit.readShowcaseAudit({ date: '2026-09-21', shopCode: asked });
    assert.ok(log.length > 0, `«${asked}» должно находить М22`);
  }
});

test('отбор по несуществующей правке пуст — это ответ «не меняли»', async () => {
  const log = await audit.readShowcaseAudit({ date: '2026-09-21', shopCode: 'М70' });
  assert.deepEqual(log, []);
  assert.ok((await audit.showcaseAuditCount()) > 0, 'при этом сам журнал не пуст');
});

test('значения показываются человеку процентами, пустое — прочерком', () => {
  assert.equal(audit.formatAuditValue('fill', '0.95'), '95%');
  assert.equal(audit.formatAuditValue('fill', null), '—');
  assert.equal(audit.formatAuditValue('note', 'чинили витрину'), 'чинили витрину');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
