import test from 'node:test';
import assert from 'node:assert/strict';
import { isManaged, isPublic, isUnlocked, password, passwordSet, tokenFor } from './auth';

/**
 * Пароль на «Витрины» и «Историю». Главное, что здесь проверяется, —
 * что «пароль не задан» никогда не притворяется «пароль сошёлся».
 */

function withEnv(value: string | undefined, run: () => Promise<void> | void) {
  const was = process.env.RADAR_MANAGE_PASSWORD;
  if (value === undefined) delete process.env.RADAR_MANAGE_PASSWORD;
  else process.env.RADAR_MANAGE_PASSWORD = value;

  const restore = () => {
    if (was === undefined) delete process.env.RADAR_MANAGE_PASSWORD;
    else process.env.RADAR_MANAGE_PASSWORD = was;
  };

  const out = run();
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return undefined;
}

test('верный пароль открывает, неверный — нет', async () => {
  await withEnv('секрет-для-теста', async () => {
    assert.equal(await isUnlocked(await tokenFor('секрет-для-теста')), true);

    assert.equal(await isUnlocked(await tokenFor('другой-пароль')), false);
    assert.equal(await isUnlocked('что-то своё'), false);
    assert.equal(await isUnlocked(undefined), false, 'без куки — закрыто');
  });
});

test('в куке лежит отпечаток, а не сам пароль', async () => {
  const token = await tokenFor('секрет-для-теста');

  assert.match(token, /^[0-9a-f]{64}$/, 'SHA-256 в hex');
  assert.ok(!token.includes('секрет'), 'пароль не должен читаться из куки');
});

test('без пароля вкладки открыты, и это видно в passwordSet', async () => {
  await withEnv(undefined, async () => {
    assert.equal(await isUnlocked(undefined), true, 'иначе dev и тесты требовали бы пароль');
    assert.equal(passwordSet(), false, 'шапка должна показать полосу');
  });

  await withEnv('есть', () => {
    assert.equal(passwordSet(), true);
  });
});

test('пустая строка в переменной — это «пароля нет», а не пустой пароль', () => {
  withEnv('', () => {
    assert.equal(password(), undefined);
    assert.equal(passwordSet(), false);
  });
});

test('крон-роуты и страница входа паролем не закрываются', () => {
  // Крон ходит без браузера и куку завести не может: закрой его паролем —
  // расписание молча перестанет работать. У него свой секрет.
  for (const p of ['/login', '/api/login', '/api/cron/attendance', '/api/cron/showcase']) {
    assert.equal(isPublic(p), true, `${p} должен открываться без пароля`);
  }
});

test('пароль спрашивается ровно на «Витринах» и «Истории»', () => {
  for (const p of ['/showcase', '/history', '/api/showcase', '/showcase/что-то']) {
    assert.equal(isManaged(p), true, `${p} должен быть под паролем`);
  }
  // Сам радар открыт: цифры смотрит вся команда.
  for (const p of ['/', '/radar', '/settings', '/shop/М1', '/api/upload', '/showcases']) {
    assert.equal(isManaged(p), false, `${p} под паролем быть не должен`);
  }
});
