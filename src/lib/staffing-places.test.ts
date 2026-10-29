import test from 'node:test';
import assert from 'node:assert/strict';
import { readStaffing } from './staffing-store';
import { STAFF_ROLES, findStaffNorm, type StaffNorm } from './staffing';
import {
  DEFAULT_PLACE_ALIASES,
  applyPlaceAliases,
  collectPlaces,
  defaultPlaceName,
  functionCatalog,
  isReviewedPlace,
  parsePlaceAliases,
  placeAliasMap,
  placeWindows,
  previewAliasChange,
  resolvePlace,
  unusedAliases,
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
  // Счёт по должностям — для фильтра и группировки на вкладке: в сумме — весь счёт.
  for (const p of places) {
    assert.deepEqual(Object.keys(p.bySource).sort(), [...p.sources].sort());
    assert.equal(Object.values(p.bySource).reduce((s, b) => s + b!.uses, 0), p.uses);
  }
  const heat = places.find((p) => p.key === 'разогрев')!;
  assert.ok(heat.bySource.cook!.uses < heat.uses, '«разогрев» есть и у повара, и у кассира');
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

test('новое написание — не правленное на сайте и не известная опечатка', () => {
  const saved = new Set(['официант']);
  assert.equal(isReviewedPlace('официант', saved), true, 'сохраняли на сайте');
  assert.equal(isReviewedPlace('разог', saved), true, 'опечатка из словаря по умолчанию');
  assert.equal(isReviewedPlace('разогр', saved), false, 'пришло из книги, никто не разбирал');
  assert.equal(defaultPlaceName('Разог'), 'разогрев');
  assert.equal(defaultPlaceName('касса'), 'касса');
});

test('справочник для правки лавки: единые названия, свои должности и добавленные на вкладке', () => {
  const saved = [
    { place: 'разогрев', name: 'разогрев блюд' },
    { place: 'мойка витрин', name: 'мойка витрин' },
  ];
  const live = applyPlaceAliases(norms, placeAliasMap(saved));
  const catalog = functionCatalog(live, saved);
  const names = catalog.map((f) => f.name);
  assert.ok(names.includes('разогрев блюд'));
  assert.ok(!names.includes('разогрев') && !names.includes('разог'), 'старые написания в список не идут');
  assert.deepEqual(catalog.find((f) => f.name === 'мойка витрин')?.roles, [], 'добавлен, пока нигде не стоит');
  assert.ok(catalog.find((f) => f.name === 'разогрев блюд')!.roles.includes('cook'));
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'без повторов');
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ru')));
});

test('строки словаря без написаний: добавленный функционал и пропавшая опечатка, но не звено цепочки', () => {
  const usages = [{ key: 'разог' }, { key: 'касса' }];
  const unused = unusedAliases(
    [
      { place: 'разогрев', name: 'разогрев блюд' }, // «разог → разогрев → разогрев блюд» — в деле
      { place: 'мойка витрин', name: 'мойка витрин' },
      { place: 'разгрев', name: 'разогрев' },
      { place: 'касса', name: 'касса' },
    ],
    usages,
  );
  assert.deepEqual(unused, [
    { place: 'мойка витрин', name: 'мойка витрин', kind: 'added' },
    { place: 'разгрев', name: 'разогрев', kind: 'gone' },
  ]);
});

test('предпросмотр правки словаря: окна, лавки и слияния', () => {
  const windows = [
    { shop: 'М1', places: ['разог', 'разогрев'] },
    { shop: 'М1', places: ['витрина', 'разогрев'] },
    { shop: 'М2', places: ['касса'] },
  ];
  // По умолчанию «разог» уже «разогрев» — в первом окне он и так один.
  assert.deepEqual(previewAliasChange(windows, [], [{ place: 'разогрев', name: 'разогрев блюд' }]), {
    windows: 2,
    shops: 1,
    merged: 0,
  });
  assert.deepEqual(previewAliasChange(windows, [], [{ place: 'витрина', name: 'разогрев' }]), { windows: 1, shops: 1, merged: 1 });
  assert.deepEqual(previewAliasChange(windows, [], [{ place: 'бар', name: 'кофе' }]), { windows: 0, shops: 0, merged: 0 });
});

test('окна для предпросмотра — все непустые окна сети с написаниями как в книгах', () => {
  const windows = placeWindows(norms);
  assert.ok(windows.length > 1000);
  assert.ok(windows.every((w) => w.places.length > 0 && w.shop));
  assert.ok(windows.some((w) => w.places.includes('разог')));
});
