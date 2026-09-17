import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-contest-store-'));
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_STORAGE = 'snapshot';
process.env.RADAR_MANAGE_PASSWORD = 'contest-test';
delete process.env.RADAR_UPLOAD_TOKEN;
const id = 'bb27c61c-7d38-4297-9c2b-57c346f06680';
const payload = { id, shopCode: 'M1', reason: 'Нарушение правил конкурса' };

async function request(method: string, body?: unknown, authenticated = true, query = '') {
  const { COOKIE, tokenFor } = await import('./auth');
  return new NextRequest(`http://localhost/api/contest/violations${query}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { cookie: `${COOKIE}=${await tokenFor('contest-test')}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('API не разрешает менять конкурс без пароля и с неверными данными', async () => {
  const { POST, DELETE } = await import('../app/api/contest/violations/route');
  assert.equal((await POST(await request('POST', payload, false))).status, 401);
  assert.equal((await DELETE(await request('DELETE', undefined, false, `?id=${id}`))).status, 401);
  for (const body of [null, {}, { ...payload, reason: ' ' }, { ...payload, reason: 'x'.repeat(301) }, { ...payload, shopCode: 'М9999' }]) {
    assert.equal((await POST(await request('POST', body))).status, 400);
  }
  process.env.RADAR_UPLOAD_TOKEN = 'upload-test';
  try { assert.equal((await POST(await request('POST', payload))).status, 401); }
  finally { delete process.env.RADAR_UPLOAD_TOKEN; }
});

test('новое нарушение сохраняется, повтор не удваивает штраф, РМ берётся с сервера', async () => {
  const { POST } = await import('../app/api/contest/violations/route');
  const { contest, listShops } = await import('./queries');
  const filters = { from: '2026-10-01', to: '2026-10-01', shop: 'М1' };
  assert.equal((await contest(filters)).total.points, 0);
  for (let i = 0; i < 2; i++) {
    assert.equal((await POST(await request('POST', { ...payload, region: 'Поддельный РМ' }))).status, 200);
  }
  const result = await contest(filters);
  assert.equal(result.total.points, -1);
  assert.equal(result.total.violations, 1);
  assert.equal(result.total.rated, 0);
  assert.equal(result.regions[0].region, (await listShops()).find((s) => s.code === 'М1')!.region);
  assert.equal(result.regions[0].score.points, -1);

  // Другой процесс заново открывает файл: запись переживает перезапуск.
  const script = "import { readContestViolations } from './src/lib/contest-violations-store'; readContestViolations().then(v => console.log(JSON.stringify(v)))";
  const read = (env = process.env) => JSON.parse(execFileSync(process.execPath,
    ['node_modules/tsx/dist/cli.mjs', '-e', script], { env, encoding: 'utf8' }));
  assert.equal(read().filter((v: { id: string }) => v.id === id).length, 1);
  const fallback = read({ ...process.env, VERCEL: '1' });
  assert.deepEqual(fallback.map((v: { shopCode: string }) => v.shopCode), ['М25']);
});

test('удаление ошибочной записи возвращает балл, постоянный М25 защищён', async () => {
  const { DELETE } = await import('../app/api/contest/violations/route');
  const { contest } = await import('./queries');
  assert.equal((await DELETE(await request('DELETE', undefined, true, '?id=m25-permanent'))).status, 400);
  assert.equal((await DELETE(await request('DELETE', undefined, true, `?id=${id}`))).status, 200);
  assert.equal((await contest({ from: '2026-10-01', to: '2026-10-01', shop: 'М1' })).total.points, 0);
  assert.equal((await contest({ from: '2026-10-01', to: '2026-10-01', shop: 'М25' })).total.points, -1);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
