import { IDS } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { actorId } from '../chat/testing.ts';
import { testStore } from '../testing.ts';
import { filteredPage, someRows } from './rows.ts';

describe('paging', () => {
  it('collects filtered rows across store pages with an exact cursor', async () => {
    const s = await testStore();
    for (let i = 0; i < 10; i++) {
      await s.table('sessions').insert({
        id: IDS.session.parse(`ses_${i}`), title: i % 2 === 0 ? `even ${i}` : `odd ${i}`, owner: actorId('act_a'), agent: 'hub/chat', participants: [], systems: 'all', tools: [], context: [],
        status: 'idle', transcript: [], createdAt: i, updatedAt: i, archived: false,
      });
    }
    const table = s.table('sessions');
    const query = { order: [['createdAt', 'asc']] as const, limit: 2 };
    const first = await filteredPage(table, query, (r) => r.title.startsWith('even'));
    expect(first.items.map((r) => r.title)).toEqual(['even 0', 'even 2']);
    const second = await filteredPage(table, { ...query, cursor: first.cursor }, (r) => r.title.startsWith('even'));
    expect(second.items.map((r) => r.title)).toEqual(['even 4', 'even 6']);
    const third = await filteredPage(table, { ...query, cursor: second.cursor }, (r) => r.title.startsWith('even'));
    expect(third.items.map((r) => r.title)).toEqual(['even 8']);
    expect(third.cursor).toBeUndefined();
  });

  it('stops a long scan with a cursor to go on from', async () => {
    const s = await testStore();
    for (let i = 0; i < 6; i++) {
      await s.table('sessions').insert({
        id: IDS.session.parse(`ses_${i}`), title: `t${i}`, owner: actorId('act_a'), agent: 'hub/chat', participants: [], systems: 'all', tools: [], context: [],
        status: 'idle', transcript: [], createdAt: i, updatedAt: i, archived: false,
      });
    }
    const page = await filteredPage(s.table('sessions'), { order: [['createdAt', 'asc']], limit: 1 }, () => false, 2);
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeDefined();
  });

  it('refuses a cursor it did not give out', async () => {
    await expect(filteredPage((await testStore()).table('sessions'), { limit: 1, cursor: 'nonsense' }, () => true)).rejects.toMatchObject({ status: 400 });
  });

  it('reads every row up to a maximum', async () => {
    const s = await testStore();
    for (let i = 0; i < 5; i++) { await s.table('memberships').insert({ group: actorId('act_g'), user: actorId(`act_${i}`), addedBy: actorId('act_a'), addedAt: i }); }
    expect(await someRows(s.table('memberships'), { where: { group: actorId('act_g') } }, 3)).toHaveLength(3);
    expect(await someRows(s.table('memberships'), {}, 100)).toHaveLength(5);
  });
});
