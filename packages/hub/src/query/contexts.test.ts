/**
 * The context list (`/context`) over a real store: its filters, sort and page run as SQL (`HubStore.lists`), and its
 * text goes through the one fns and context search, words alone with no embedder, over each item's text and its heading
 * sections, with the list's filters in the same query; rows the viewer may not see are never listed.
 */
import { IDS, SystemName, type ContextListItem, type ContextRecord, type ListQuery } from '@harness/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openScope } from '../access/index.ts';
import { FixtureCatalog } from '../chat/testing.ts';
import { contextItem, wordsFnSearch, wordsIndex } from '../index/testing.ts';
import { testStore } from '../testing.ts';
import { queryEnv } from './env.ts';
import { HubQuery } from './service.ts';
import { listSources } from './sources.ts';

const ME = IDS.actor.parse('act_me');
const THEM = IDS.actor.parse('act_them');
const viewer = { id: ME, role: 'member' as const };

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

async function rig() {
  const store = await testStore();
  const catalog = new FixtureCatalog();
  const records: ContextRecord[] = [
    { ...catalog.addContext('fs', { name: 'guide', description: 'How fs reads files', tags: ['files', 'howto'], content: 'Start here.\n\n# Reading\nOpen the file first.\n\n## Encodings\nUTF-8 and latin1 are both read.\n' }), tokens: { full: 120, summary: 10 }, updatedAt: 3 },
    { ...catalog.addContext('fs', { name: 'style', description: 'House style for notes' }), disabled: true, updatedAt: 2 },
    { ...catalog.addContext('hub', { name: 'memory-mine', description: 'I like latin1 tables' }), origin: { type: 'memory', scope: { to: 'user', user: ME }, author: ME }, updatedAt: 1 },
    // another person's own memory: never listed to me, by any path
    { ...catalog.addContext('hub', { name: 'memory-theirs', description: 'They like latin1 too' }), origin: { type: 'memory', scope: { to: 'user', user: THEM }, author: THEM }, updatedAt: 4 },
  ];
  for (const record of records) { catalog.contexts.set(record.name, record); await store.table('context').put(record); }
  await wordsIndex(store, records.map(contextItem));
  const words = wordsFnSearch(store, catalog);
  stops.push(words.stop);
  const lists = new HubQuery(listSources({ store, catalog, access: { scope: (actor) => Promise.resolve(openScope(actor)) }, fns: words }, queryEnv.parse()));
  const page = (query: ListQuery) => lists.page('contexts', query, viewer);
  const names = async (query: ListQuery) => (await page(query)).items.map((c) => c.name);
  return { store, lists, page, names };
}

describe('the context list', () => {
  it('filters, sorts and pages in the database, by fields inside the record (origin, tags, tokens, off)', async () => {
    const { store, names, page } = await rig();
    const sql = vi.spyOn(store.lists, 'find');
    expect(await names({})).toEqual(['fs/guide', 'fs/style', 'hub/memory-mine']);
    expect(await names({ filters: [{ field: 'origin', op: 'is', value: 'memory' }] })).toEqual(['hub/memory-mine']);
    expect(await names({ filters: [{ field: 'origin', op: 'is', value: 'system' }] })).toEqual(['fs/guide', 'fs/style']);
    expect(await names({ filters: [{ field: 'tags', op: 'is', value: 'howto' }] })).toEqual(['fs/guide']);
    expect(await names({ filters: [{ field: 'tags', op: 'notIn', values: ['files'] }] })).toEqual(['fs/style', 'hub/memory-mine']);
    expect(await names({ filters: [{ field: 'tags', op: 'empty' }] })).toEqual(['fs/style', 'hub/memory-mine']);
    expect(await names({ filters: [{ field: 'disabled', op: 'is', value: true }] })).toEqual(['fs/style']);
    expect(await names({ filters: [{ field: 'disabled', op: 'is', value: false }] })).toEqual(['fs/guide', 'hub/memory-mine']);
    expect(await names({ filters: [{ field: 'tokens', op: 'gt', value: 100 }] })).toEqual(['fs/guide']);
    expect(await names({ filters: [{ field: 'name', op: 'contains', value: 'MEMORY' }] })).toEqual(['hub/memory-mine']);
    expect(await names({ sort: [{ field: 'name', dir: 'desc' }] })).toEqual(['hub/memory-mine', 'fs/style', 'fs/guide']);
    // every filter went to the database as it was asked
    expect(sql).toHaveBeenCalledWith(expect.objectContaining({ table: 'context', filters: [{ field: 'tags', op: 'is', value: 'howto' }] }));
    // pages past a row the viewer can't see without losing or repeating one
    const first = await page({ limit: 1, sort: [{ field: 'updatedAt', dir: 'desc' }] });
    expect(first.items.map((c) => c.name)).toEqual(['fs/guide']);
    const second = await page({ limit: 1, sort: [{ field: 'updatedAt', dir: 'desc' }], cursor: first.cursor });
    const third = await page({ limit: 1, sort: [{ field: 'updatedAt', dir: 'desc' }], cursor: second.cursor });
    expect([...second.items, ...third.items].map((c) => c.name)).toEqual(['fs/style', 'hub/memory-mine']);
    expect(third.cursor).toBeUndefined();
  });

  it('searches text through the one search, by words alone with no embedder, and says how each row was found', async () => {
    const { names, page } = await rig();
    const found = await page({ text: 'latin1' });
    // the guide by its Encodings section (past its own heading), my memory by its own text; never their memory
    expect(found.items.map((c) => c.name).sort()).toEqual(['fs/guide', 'hub/memory-mine']);
    const guide = found.items.find((c) => c.name === 'fs/guide');
    expect(guide?.found).toMatchObject({ matched: 'words', section: { title: 'Encodings', path: ['Reading', 'Encodings'] } });
    expect(guide?.found?.score).toBeGreaterThan(0);
    // words alone measure no fit
    expect(guide?.found?.similarity).toBeUndefined();
    const mine = found.items.find((c): c is ContextListItem => c.name === 'hub/memory-mine');
    expect(mine?.found).toMatchObject({ matched: 'words' });
    expect(mine?.found?.section).toBeUndefined();
    // the list's filters narrow the search in the same query
    expect(await names({ text: 'latin1', filters: [{ field: 'origin', op: 'is', value: 'memory' }] })).toEqual(['hub/memory-mine']);
    expect(await names({ text: 'latin1', filters: [{ field: 'tags', op: 'is', value: 'howto' }] })).toEqual(['fs/guide']);
    expect(await names({ text: 'latin1', filters: [{ field: 'origin', op: 'is', value: 'resource' }] })).toEqual([]);
    // an item switched off is still listed, as the list without text lists it
    expect(await names({ text: 'house style' })).toEqual(['fs/style']);
    // pages by the search's offset
    const one = await page({ text: 'latin1', limit: 1 });
    expect(one.items).toHaveLength(1);
    expect(one.cursor).toBe('1');
    expect((await page({ text: 'latin1', limit: 1, cursor: one.cursor })).items.map((c) => c.name)).not.toContain(one.items[0]?.name);
  });
});

describe('a list run whole in SQL (notifications)', () => {
  it('lists only the viewer\'s own, matches every word in kind, title or body in the database, and pages', async () => {
    const { store, lists } = await rig();
    const note = (id: string, user: typeof ME, title: string, body: string, createdAt: number) => store.table('notifications').insert({
      id: IDS.notification.parse(id), user, reason: 'message', title, body, link: { system: SystemName.parse('fs') }, read: false, pushed: false, createdAt,
    });
    await note('ntf_1', ME, 'Trip booked', 'Oslo on Friday', 1);
    await note('ntf_2', ME, 'Rent', 'Due on Friday', 2);
    await note('ntf_3', THEM, 'Their trip', 'Oslo on Friday', 3);
    const ids = async (query: ListQuery) => (await lists.page('notifications', query, viewer)).items.map((n) => n.id);
    const sql = vi.spyOn(store.lists, 'find');
    expect(await ids({})).toEqual(['ntf_2', 'ntf_1']);
    expect(await ids({ text: 'friday' })).toEqual(['ntf_2', 'ntf_1']);
    expect(await ids({ text: 'OSLO friday' })).toEqual(['ntf_1']);
    expect(await ids({ text: 'message rent' })).toEqual(['ntf_2']);
    expect(await ids({ text: 'oslo rent' })).toEqual([]);
    const wordsAsked: unknown = expect.objectContaining({ text: 'oslo rent' });
    expect(sql).toHaveBeenCalledWith(expect.objectContaining({ table: 'notifications', words: wordsAsked }));
    const first = await lists.page('notifications', { limit: 1 }, viewer);
    expect(first).toMatchObject({ items: [{ id: 'ntf_2' }], cursor: '1' });
    expect((await lists.page('notifications', { limit: 1, cursor: first.cursor }, viewer)).items.map((n) => n.id)).toEqual(['ntf_1']);
  });
});
