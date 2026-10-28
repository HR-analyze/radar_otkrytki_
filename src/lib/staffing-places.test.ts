import test from 'node:test';
import assert from 'node:assert/strict';
import { readStaffing } from './staffing-store';
import { STAFF_ROLES, findStaffNorm, type StaffNorm } from './staffing';
import {
  DEFAULT_PLACE_ALIASES,
  applyPlaceAliases,
  collectPlaces,
  parsePlaceAliases,
  placeAliasMap,
  resolvePlace,
} from './staffing-places';

const { norms } = readStaffing();

const allPlaces = (list: readonly StaffNorm[]) =>
  new Set(
    list.flatMap((n) => [
      ...STAFF_ROLES.flatMap((r) => (n.roles[r].posts ?? []).flat().map((p) => p.place)),
      ...(n.layout?.stations ?? []).map((p) => p.place),
    ]),
  );

test('словарь по умолчанию сводит опечатки: «разог» и «разлгрев» — это «разогрев»', () => {
  const aliases = placeAliasMap([]);
  assert.equal(resolvePlace('разог', aliases), 'разогрев');
  assert.equal(resolvePlace('Разлгрев', aliases), 'разогрев');
  assert.equal(resolvePlace('официант+дост', aliases), 'официант + доставка');
  assert.equal(resolvePlace('касса', aliases), 'касса', 'нет в словаре — как написано');

  const before = allPlaces(norms);
  assert.ok(before.has('разог'), 'в книгах опечатка есть — иначе тест ничего не проверяет');
  const after = allPlaces(applyPlaceAliases(norms, aliases));
  for (const a of DEFAULT_PLACE_ALIASES) assert.ok(!after.has(a.place), a.place);
});

test('правка с сайта главнее словаря по умолчанию и тянет за собой цепочку', () => {
  // Вернуть «разог» как есть.
  assert.equal(resolvePlace('разог', placeAliasMap([{ place: 'разог', name: 'разог' }])), 'разог');
  // «разогрев» → «разогрев блюд»: опечатки, сведённые к «разогреву», едут следом.
  const aliases = placeAliasMap([{ place: 'разогрев', name: 'разогрев блюд' }]);
  assert.equal(resolvePlace('разлгрев', aliases), 'разогрев блюд');
  // Петля не вешает разбор.
  const loop = placeAliasMap([
    { place: 'а', name: 'б' },
    { place: 'б', name: 'а' },
  ]);
  assert.ok(['а', 'б'].includes(resolvePlace('а', loop)));
});

test('места, совпавшие после переименования, складываются в окне', () => {
  const m50 = findStaffNorm(norms, 'М50')!;
  const norm: StaffNorm = {
    ...m50,
    roles: {
      ...m50.roles,
      cook: {
        ...m50.roles.cook,
        posts: m50.roles.cook.slots.map((_, i) =>
          i === 0
            ? [
                { count: 1, place: 'разог' },
                { count: 2, place: 'разогрев' },
                { count: null, place: 'разлгрев' },
              ]
            : [],
        ),
      },
    },
  };
  const [renamed] = applyPlaceAliases([norm], placeAliasMap([]));
  assert.deepEqual(renamed.roles.cook.posts![0], [
    { count: 3, place: 'разогрев' },
    { count: null, place: 'разогрев' },
  ]);
});

test('список написаний — до словаря, со счётом, лавками и должностями', () => {
  const places = collectPlaces(norms);
  const razog = places.find((p) => p.key === 'разог')!;
  assert.ok(razog.uses > 0 && razog.shops.length > 0);
  assert.ok(razog.sources.includes('cook'));
  // «ЗД бар» и «зд бар» — одно написание, показываем самое частое.
  assert.equal(places.filter((p) => p.key === 'зд бар').length, 1);
  assert.equal(places.find((p) => p.key === 'зд бар')!.place, 'ЗД бар');
  assert.equal(new Set(places.map((p) => p.key)).size, places.length);
});

test('словарь из запроса: пустое название — как написано, мусор не проходит', () => {
  const ok = parsePlaceAliases({ aliases: [{ place: ' Разог ', name: '' }, { place: 'витр', name: 'витрина' }] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.aliases, [
    { place: 'Разог', name: 'Разог' },
    { place: 'витр', name: 'витрина' },
  ]);
  assert.equal(parsePlaceAliases({}).ok, false);
  assert.equal(parsePlaceAliases({ aliases: [] }).ok, false);
  assert.equal(parsePlaceAliases({ aliases: [{ place: '', name: 'х' }] }).ok, false);
  assert.equal(parsePlaceAliases({ aliases: [{ place: 'х', name: 'х'.repeat(81) }] }).ok, false);
});
