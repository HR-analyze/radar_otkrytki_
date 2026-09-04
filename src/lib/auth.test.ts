import test from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE, isManaged, isPublic, isUnlocked, openScopes, passwordFor, tokenFor } from './auth';

/**
 * Пароли на вход. Главное, что здесь проверяется, — что «пароль не задан»
 * никогда не притворяется «пароль сошёлся».
 */

function withEnv(env: Record<string, string | undefined>, run: () => Promise<void> | void) {
  const was: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    was[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  const out = run();
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return undefined;
}

test('верный пароль открывает, неверный — нет', async () => {
  await withEnv({ RADAR_PASSWORD: 'секрет-для-теста' }, async () => {
    const good = await tokenFor('site', 'секрет-для-теста');
    assert.equal(await isUnlocked('site', good), true);

    assert.equal(await isUnlocked('site', await tokenFor('site', 'другой-пароль')), false);
    assert.equal(await isUnlocked('site', 'что-то своё'), false);
    assert.equal(await isUnlocked('site', undefined), false, 'без куки — закрыто');
  });
});

test('в куке лежит отпечаток, а не сам пароль', async () => {
  const token = await tokenFor('site', 'секрет-для-теста');

  assert.match(token, /^[0-9a-f]{64}$/, 'SHA-256 в hex');
  assert.ok(!token.includes('секрет'), 'пароль не должен читаться из куки');
});

test('кука одного уровня не открывает другой', async () => {
  // Иначе общий пароль от сайта пускал бы и в «Витрины».
  await withEnv({ RADAR_PASSWORD: 'один', RADAR_MANAGE_PASSWORD: 'один' }, async () => {
    const site = await tokenFor('site', 'один');
    assert.equal(await isUnlocked('site', site), true);
    assert.equal(await isUnlocked('manage', site), false, 'область входит в отпечаток');
  });
  assert.notEqual(COOKIE.site, COOKIE.manage, 'куки разных уровней не должны совпадать');
});

test('без пароля уровень открыт, и это видно в openScopes', async () => {
  await withEnv({ RADAR_PASSWORD: undefined, RADAR_MANAGE_PASSWORD: undefined }, async () => {
    assert.equal(await isUnlocked('site', undefined), true, 'иначе dev и тесты требовали бы пароль');
    assert.deepEqual(openScopes(), ['site', 'manage']);
  });

  await withEnv({ RADAR_PASSWORD: 'есть', RADAR_MANAGE_PASSWORD: undefined }, () => {
    assert.deepEqual(openScopes(), ['manage'], 'шапка должна назвать именно открытый уровень');
  });
});

test('пустая строка в переменной — это «пароля нет», а не пустой пароль', () => {
  withEnv({ RADAR_PASSWORD: '' }, () => {
    assert.equal(passwordFor('site'), undefined);
  });
});

test('крон-роуты и страница входа паролем не закрываются', () => {
  // Крон ходит без браузера и куку завести не может: закрой его паролем —
  // расписание молча перестанет работать. У него свой секрет.
  for (const p of ['/login', '/api/login', '/api/cron/attendance', '/api/cron/showcase']) {
    assert.equal(isPublic(p), true, `${p} должен открываться без пароля`);
  }
  for (const p of ['/', '/radar', '/showcase', '/api/showcase', '/api/upload']) {
    assert.equal(isPublic(p), false, `${p} без пароля пускать нельзя`);
  }
});

test('отдельный пароль спрашивается ровно на «Витринах» и «Истории»', () => {
  for (const p of ['/showcase', '/history', '/api/showcase', '/showcase/что-то']) {
    assert.equal(isManaged(p), true, `${p} должен быть под вторым паролем`);
  }
  for (const p of ['/', '/radar', '/settings', '/shop/М1', '/api/upload', '/showcases']) {
    assert.equal(isManaged(p), false, `${p} под вторым паролем быть не должен`);
  }
});
