import { IDS, SessionId, SystemName, type SearchHit } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { openScope } from '../access/index.ts';
import type { SearchQuery } from '../index/index.ts';
import { testStore } from '../testing.ts';
import { StoreMentionRequests } from './mention-requests.ts';
import { searchForMention, type MentionSearchDeps } from './mention-search.ts';
import { chatWorld } from './testing.ts';

const web = SystemName.parse('web');
const ann = IDS.actor.parse('act_ann');

describe('mention requests', () => {
  it('stand for the person asking, only for the system asked, until they expire', async () => {
    let now = 1_000;
    const store = await testStore({ now: () => now });
    const requests = new StoreMentionRequests({ keys: () => store.ports.work.store, ttl: 60_000 });
    const session = SessionId.parse('ses_1');
    const id = await requests.mint({ system: web, actor: ann, session });
    expect(await requests.check(id, web)).toEqual({ system: web, actor: ann, session });
    await expect(requests.check(id, SystemName.parse('fs'))).rejects.toMatchObject({ code: 'MENTION_REQUEST_NOT_YOURS' });
    await expect(requests.check(IDS.mentionRequest.parse('mrq_none'), web)).rejects.toMatchObject({ code: 'MENTION_REQUEST_UNKNOWN' });
    now += 60_001;
    await expect(requests.check(id, web)).rejects.toMatchObject({ code: 'MENTION_REQUEST_UNKNOWN' });
  });
});

describe('a system\'s resource search for a mention', () => {
  it('runs as the person mentioning, inside the roots the system names', async () => {
    const w = await chatWorld();
    const requests = new StoreMentionRequests({ keys: () => w.store.ports.work.store, ttl: 60_000 });
    const hits: SearchHit[] = [
      { kind: 'section', key: 'https://example.com/a#intro', rank: 0.9, similarity: 0.9, text: 'Example A\nabout a' },
      { kind: 'section', key: 'file:///repo/notes.md', rank: 0.8, similarity: 0.8, text: 'Notes' },
    ];
    const asked: SearchQuery[] = [];
    const scopes: string[] = [];
    const deps = {
      requests: () => requests, store: () => w.store, catalog: () => w.catalog,
      access: (actor) => { scopes.push(actor); return Promise.resolve(openScope(actor)); },
      search: () => ({
        search: async (query) => {
          asked.push(query);
          const kept: SearchHit[] = [];
          for (const hit of hits) { if (await query.keep?.(hit) !== false) { kept.push(hit); } }
          return kept;
        },
      }),
    } satisfies MentionSearchDeps;
    const request = await requests.mint({ system: web, actor: w.admin.id, session: w.session.id });
    const answer = await searchForMention(deps, { request, query: 'example', roots: ['https://'], limit: 5 }, web);
    expect(answer.hits).toEqual([{ uri: 'https://example.com/a', section: 'intro', title: 'Example A', preview: 'Example A\nabout a', score: 0.9 }]);
    expect(scopes).toEqual([w.admin.id]);
    expect(asked[0]).toMatchObject({ text: 'example', kinds: ['section'], limit: 5 });
    await expect(searchForMention(deps, { request, query: 'x', limit: 5 }, SystemName.parse('fs'))).rejects.toMatchObject({ code: 'MENTION_REQUEST_NOT_YOURS' });
  });
});
