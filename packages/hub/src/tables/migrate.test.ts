import { accessKey, ActorId, itemVersionId, jsonOf, QualifiedName, SystemName, WIDGET_KIND, WIDGET_KIND_V1, WidgetSpec, type FnRecord, type WidgetSpecV1 } from '@harness/core';
import { fn, g } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { TestCatalog } from '../execution/testing.ts';
import { memoryLog, testStore } from '../testing.ts';
import { migrateWidgets } from './migrate.ts';

const HUB = SystemName.parse('hub');
const ANN = ActorId.parse('act_ann');
const OLD = QualifiedName.parse('hub/open_tasks');
const NEW = QualifiedName.parse('widgets/open_tasks');

const spec: WidgetSpecV1 = {
  title: 'Open tasks', source: QualifiedName.parse('hub/records_table'),
  visuals: [{ visual: 'bar', bind: { label: ['owner'], value: ['count'] } }, { visual: 'table', bind: {} }],
  controls: [{ arg: 'type', pinned: 'tasks/Task' }, { arg: 'search', label: 'Search' }], paging: { offset: 'offset', limit: 'limit', size: 20 },
};

/** A build 8 widget fn as the hub stored it. */
function oldWidget(): FnRecord {
  const base = new TestCatalog().add('hub', 'open_tasks', fn({ description: 'Open tasks.', args: g.obj({ search: g.optional(g.text()) }), returns: g.text() }));
  return { ...base, origin: 'runtime', addedBy: ANN, decl: { ...base.decl, kind: WIDGET_KIND_V1, payload: jsonOf(spec), group: 'widgets' } };
}

describe('the widget migration', () => {
  it('moves each hub/widget fn to the widgets system with its spec upgraded, its history, owner and sharing', async () => {
    const store = await testStore();
    const old = oldWidget();
    await store.table('fns').put(old);
    await store.table('fnLinks').putAll([{ fn: OLD, to: WIDGET_KIND_V1, link: 'kind', system: HUB }, { fn: OLD, to: spec.source, link: 'dep', system: HUB }]);
    await store.table('itemVersions').put({ id: itemVersionId(HUB, 'fns', OLD, 1), system: HUB, section: 'fns', name: OLD, number: 1, change: 'added', decl: jsonOf(old.decl), hash: 'h', declaredBy: 'runtime', savedAt: 5 });
    const target = { kind: 'fn' as const, fn: OLD };
    await store.table('access').put({ key: accessKey(target), target, sharing: { owner: ANN, visibility: 'private', with: [] }, scoped: true, setBy: ANN, updatedAt: 1 });

    // its search entry under the old name
    const DOC = QualifiedName.parse('embedder/document');
    await store.table('index').put({ embedder: DOC, kind: 'fn', key: OLD, text: 'open tasks', hash: 'h', updatedAt: 1, system: HUB });
    await store.text.upsert([{ kind: 'fn', key: OLD, text: 'open tasks widget' }]);

    const { log } = memoryLog();
    expect(await migrateWidgets(store, log)).toBe(1);

    expect(await store.table('fns').get(OLD)).toBeUndefined();
    const moved = await store.table('fns').get(NEW);
    expect(moved).toMatchObject({ system: 'widgets', origin: 'runtime', addedBy: ANN, decl: { kind: WIDGET_KIND, args: { name: 'any' }, returns: { name: 'any' }, deps: ['hub/records_table'] } });
    const upgraded = WidgetSpec.parse(moved?.decl.payload);
    expect(upgraded.visuals.map((v) => [v.visual, v.style, v.bind])).toEqual([['category', 'bar', { x: ['owner'], y: ['count'] }], ['table', 'table', {}]]);
    expect(upgraded.args).toEqual({ type: { show: 'pinned', value: { literal: 'tasks/Task' } }, search: { show: 'control', label: 'Search' } });
    expect(upgraded.paging).toEqual({ offset: 'offset', limit: 'limit' });

    const links = await store.table('fnLinks').find({ where: { fn: NEW }, limit: 10 });
    expect(links.items.map((l) => `${l.link}:${l.to}`).sort()).toEqual(['dep:hub/records_table', `kind:${WIDGET_KIND}`]);
    expect((await store.table('fnLinks').find({ where: { fn: OLD }, limit: 10 })).items).toEqual([]);
    const version = await store.table('itemVersions').get(itemVersionId(SystemName.parse('widgets'), 'fns', NEW, 1));
    expect(version).toMatchObject({ system: 'widgets', name: NEW, number: 1, decl: { kind: WIDGET_KIND } });
    expect(await store.table('itemVersions').get(itemVersionId(HUB, 'fns', OLD, 1))).toBeUndefined();
    expect(await store.table('access').get(accessKey({ kind: 'fn', fn: NEW }))).toMatchObject({ sharing: { owner: ANN, visibility: 'private' }, target: { fn: NEW } });
    expect(await store.table('access').get(accessKey(target))).toBeUndefined();

    expect(await store.table('index').get({ embedder: DOC, kind: 'fn', key: OLD })).toBeUndefined();
    expect(await store.text.search({ text: 'open tasks widget', kinds: ['fn'], limit: 5 })).toEqual([]);

    // a second start finds nothing to move
    expect(await migrateWidgets(store, log)).toBe(0);
  });
});
