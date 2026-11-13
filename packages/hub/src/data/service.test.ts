import { ActorId, IDS, QualifiedName, SystemName, type IndexedKind, type Manifest, type SearchHit } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { openScope, type AccessScope } from '../access/index.ts';
import { StoreCatalog } from '../catalog/catalog.ts';
import { manifestFor, shop } from '../catalog/fixtures.ts';
import { memoryLog, RecordingBus, testStore } from '../testing.ts';
import { dataEnv } from './env.ts';
import type { DataAsker } from './index.ts';
import { StoreDataService } from './service.ts';

const NOTE = QualifiedName.parse('shop/Note');
const PREFS = QualifiedName.parse('shop/Prefs');
const ANN = ActorId.parse('act_ann');
const BEN = ActorId.parse('act_ben');

/** A member's scope: sees everything, but is no admin. */
const member = (actor: ActorId): AccessScope => ({ ...openScope(actor), admin: false });

async function world(depth?: number) {
  const store = await testStore();
  const catalog = new StoreCatalog({ store, bus: new RecordingBus(), log: memoryLog().log, clock: () => 1, describer: { describe: () => Promise.resolve({ problems: [] }) } });
  const base = await manifestFor(shop);
  const manifest: Manifest = {
    ...base,
    types: [
      ...base.types,
      {
        name: 'Note', description: 'A note someone keeps.', display: { label: 'Note', title: 'title' }, methods: [],
        def: { name: 'obj', props: { title: { type: { name: 'text' } }, body: { type: { name: 'text' } }, stars: { type: { name: 'num' } }, done: { type: { name: 'bool' } } } },
        records: { shape: 'table', owner: 'shared', search: { text: ['title', 'body'], embed: false } },
      },
      {
        name: 'Prefs', description: 'One person keeps their own preferences.', display: { label: 'Preferences' }, methods: [],
        def: { name: 'obj', props: { theme: { type: { name: 'text' } } } },
        records: { shape: 'value', owner: 'person', search: { text: [], embed: false } },
      },
    ],
  };
  expect((await catalog.importManifest(manifest)).refused).toEqual([]);
  let now = 100;
  let counter = 0;
  const embedded: Array<{ kind: IndexedKind; key: string }> = [];
  const data = new StoreDataService({
    store, catalog, settings: { ...dataEnv.parse(), ...(depth === undefined ? {} : { HARNESS_RECORD_SEARCH_DEPTH: depth }) }, clock: () => ++now, random: () => String(++counter).padStart(6, '0'),
    indexer: () => ({ upsert: (items) => { embedded.push(...items); return Promise.resolve(); }, remove: () => Promise.resolve() }),
    search: () => ({ search: (): Promise<SearchHit[]> => Promise.resolve([]) }),
  });
  const ann: DataAsker = { actor: ANN, access: member(ANN), system: SystemName.parse('shop') };
  const ben: DataAsker = { actor: BEN, access: member(BEN) };
  return { store, data, ann, ben, embedded };
}

describe('the data system', () => {
  it('saves records checked against their type, with a version per change, and refuses a stale change', async () => {
    const { data, ann, store } = await world();
    const saved = await data.save({ type: NOTE, value: { title: 'Oslo trip', body: 'Book the train.', stars: 3, done: false } }, ann);
    expect(saved).toMatchObject({ type: NOTE, title: 'Oslo trip', version: 1, updatedBy: ANN, updatedBySystem: 'shop' });
    await expect(data.save({ type: NOTE, value: { title: 'x', body: 'y', stars: 'many', done: false } }, ann)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    const changed = await data.save({ type: NOTE, id: saved.id, value: { title: 'Oslo trip', body: 'Train booked.', stars: 4, done: true }, expect: 1 }, ann);
    expect(changed.version).toBe(2);
    await expect(data.save({ type: NOTE, id: saved.id, value: { title: 'Oslo', body: 'b', stars: 1, done: false }, expect: 1 }, ann)).rejects.toMatchObject({ code: 'RECORD_MOVED_ON' });
    const history = await data.versions({ type: NOTE, id: saved.id }, ann);
    expect(history.items.map((v) => [v.number, v.change])).toEqual([[2, 'updated'], [1, 'created']]);
    expect(await data.remove({ type: NOTE, id: saved.id }, ann)).toBe(true);
    expect(await data.get({ type: NOTE, id: saved.id }, ann)).toBeUndefined();
    expect((await data.versions({ type: NOTE, id: saved.id }, ann)).items[0]?.change).toBe('removed');
    expect(await store.table('records').count()).toBe(0);
  });

  it('filters, sorts, searches and pages in the database, refusing unknown fields', async () => {
    const { data, ann } = await world();
    const notes: ReadonlyArray<readonly [string, number, boolean]> = [['Alpha', 1, false], ['Bravo', 5, true], ['Charlie', 3, false], ['Delta oslo', 4, false]];
    for (const [title, stars, done] of notes) {
      await data.save({ type: NOTE, value: { title, body: `About ${title}`, stars, done } }, ann);
    }
    const open = await data.find({ type: NOTE, query: { filters: [{ field: 'done', op: 'is', value: false }], sort: [{ field: 'stars', dir: 'desc' }], limit: 2 } }, ann);
    expect(open.items.map((r) => r.title)).toEqual(['Delta oslo', 'Charlie']);
    const next = await data.find({ type: NOTE, query: { filters: [{ field: 'done', op: 'is', value: false }], sort: [{ field: 'stars', dir: 'desc' }], limit: 2, cursor: open.cursor } }, ann);
    expect(next.items.map((r) => r.title)).toEqual(['Alpha']);
    expect(next.cursor).toBeUndefined();
    expect((await data.find({ type: NOTE, query: { filters: [{ field: 'stars', op: 'between', from: 3, to: 4 }] } }, ann)).items).toHaveLength(2);
    expect((await data.find({ type: NOTE, search: 'oslo' }, ann)).items.map((r) => r.title)).toEqual(['Delta oslo']);
    await expect(data.find({ type: NOTE, query: { filters: [{ field: 'secret', op: 'is', value: 1 }] } }, ann)).rejects.toMatchObject({ code: 'BAD_RECORD_QUERY' });
    await expect(data.find({ type: NOTE, query: { sort: [{ field: 'body); drop table records; --', dir: 'asc' }] } }, ann)).rejects.toMatchObject({ code: 'BAD_RECORD_QUERY' });
    const table = await data.table({ type: NOTE, query: { sort: [{ field: 'title', dir: 'asc' }] }, limit: 3 }, ann);
    expect(table.columns.map((c) => [c.name, c.kind])).toEqual([['title', 'text'], ['body', 'text'], ['stars', 'number'], ['done', 'boolean'], ['id', 'text']]);
    expect(table.columns.at(-1)?.ref).toBe(NOTE);
    expect(table.rows.map((row) => row[0])).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(table.truncated).toBe(true);
  });

  it('keeps a person-owned type to each person, one value each, and counts what each sees', async () => {
    const { data, ann, ben } = await world();
    const mine = await data.save({ type: PREFS, value: { theme: 'dark' } }, ann);
    const again = await data.save({ type: PREFS, value: { theme: 'light' } }, ann);
    expect(again.id).toBe(mine.id);
    expect(again.version).toBe(2);
    await data.save({ type: PREFS, value: { theme: 'blue' } }, ben);
    expect((await data.find({ type: PREFS }, ben)).items.map((r) => r.value)).toEqual([{ theme: 'blue' }]);
    expect(await data.get({ type: PREFS, id: mine.id }, ben)).toBeUndefined();
    await expect(data.save({ type: PREFS, id: mine.id, value: { theme: 'red' } }, ben)).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' });
    const admin: DataAsker = { actor: IDS.actor.parse('act_admin'), access: openScope(IDS.actor.parse('act_admin')) };
    expect((await data.find({ type: PREFS }, admin)).items).toHaveLength(2);
    const sets = await data.sets({}, ben);
    expect(sets.items.map((s) => [s.type, s.records])).toEqual([['shop/Note', 0], ['shop/Prefs', 1]]);
    await expect(data.find({ type: QualifiedName.parse('shop/Product') }, ann)).rejects.toMatchObject({ code: 'NO_STORED_TYPE' });
  });

  it('searches within one type and the asker’s own records, so other matches never use up the depth', async () => {
    const { data, ann, ben } = await world(10);
    for (let n = 0; n < 12; n += 1) { await data.save({ type: NOTE, value: { title: `oslo ${String(n)}`, body: 'oslo oslo', stars: n, done: false } }, ann); }
    const annPrefs = await data.save({ type: PREFS, value: { theme: 'oslo' } }, ann);
    const benPrefs = await data.save({ type: PREFS, value: { theme: 'oslo' }, run: IDS.run.parse('run_forged') }, ben);
    expect((await data.find({ type: PREFS, search: 'oslo' }, ben)).items.map((r) => r.id)).toEqual([benPrefs.id]);
    expect((await data.find({ type: PREFS, search: 'oslo' }, ann)).items.map((r) => r.id)).toEqual([annPrefs.id]);
    // the run of a change is the asker's, never one named in the input
    expect(benPrefs.run).toBeUndefined();
  });
});
