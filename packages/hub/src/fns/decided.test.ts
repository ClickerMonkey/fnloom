/**
 * The admin's search decisions over a page of hits: stored per item kind, a decision model's yes/no per hit (through
 * the one `HubDecider`, split by its question cap), an LLM's picks, every call recorded under its purpose and charged
 * to the run, and every hit kept when the model fails.
 */
import { ActorId, IDS, QualifiedName, SystemName, type FnSearchHit, type FnSearchPage, type FnSearchQuery } from '@harness/core';
import type { LlmGateway } from '../execution/index.ts';
import type { ModelSite } from '../models/index.ts';
import { describe, expect, it } from 'vitest';
import { FixtureDecisions, FixtureLlm } from '../chat/testing.ts';
import { HubDecider } from '../models/decide.ts';
import { memoryLog, testStore } from '../testing.ts';
import { DecidedFnSearch, exactNames, filterPrompt, hitQuestions, purposeText, SEARCH_DECISION_PURPOSES, SearchDecisions } from './decided.ts';
import { openScope } from '../access/index.ts';

const ADMIN = ActorId.parse('act_admin');
const RUN = IDS.run.parse('run_1');

const hit = (item: FnSearchHit['item'], name: string, description: string): FnSearchHit => ({
  item, name: QualifiedName.parse(name), system: SystemName.parse(name.split('/')[0] ?? 'x'), description, available: true,
});
const PAGE: FnSearchPage = {
  items: [
    hit('fn', 'web/search', 'Search the web.'),
    hit('context', 'web/guide', 'How to use the web.'),
    hit('fn', 'web/fetch_raw', 'Fetch a URL\'s raw bytes for the hub.'),
    hit('context', 'fs/authoring', 'Writing a harness system.'),
  ],
  next: 4,
};

/** The fixture decision calls, with the site each was recorded under. */
class SitedDecisions extends FixtureDecisions {
  readonly sites: ModelSite[] = [];
  override decide(input: Parameters<FixtureDecisions['decide']>[0], site?: ModelSite): ReturnType<FixtureDecisions['decide']> {
    if (site !== undefined) this.sites.push(site);
    return super.decide(input);
  }
}

/** An LLM fixture that records each call's site. */
class SitedLlm extends FixtureLlm {
  readonly sites: ModelSite[] = [];
  override chat(input: Parameters<LlmGateway['chat']>[0], site?: ModelSite): ReturnType<FixtureLlm['chat']> {
    if (site !== undefined) this.sites.push(site);
    return super.chat(input);
  }
}

async function world() {
  const store = await testStore();
  const decisions = new SitedDecisions();
  const llm = new SitedLlm();
  const decider = new HubDecider({ roles: decisions, llm: decisions });
  const { log, records } = memoryLog();
  const search = new SearchDecisions({ store: () => store, decider: () => decider, llm: () => llm, clock: () => 7, log, tuning: { HARNESS_SEARCH_DECISION_TIMEOUT: 5_000 } });
  return { store, decisions, llm, search, records };
}

describe('search decisions', () => {
  it('filter nothing until an admin chooses, and store each item kind\'s choice apart', async () => {
    const w = await world();
    expect(await w.search.settings()).toEqual({ fn: { value: { by: 'none' } }, context: { value: { by: 'none' } } });
    expect(await w.search.filter(PAGE, { text: 'search the web' }, {})).toBe(PAGE);
    const set = await w.search.set('fn', { by: 'decision' }, ADMIN);
    expect(set).toEqual({ fn: { value: { by: 'decision' }, setBy: ADMIN, updatedAt: 7 }, context: { value: { by: 'none' } } });
    expect((await w.store.table('hubOptions').get('fnsSearchDecision'))?.value).toEqual({ by: 'decision' });
  });

  it('by a decision model: one yes/no per hit of its kind, split by the question cap, kept at the decide threshold in order', async () => {
    const w = await world();
    w.decisions.role = { model: 'judge', threshold: 0.6, maxQuestions: 1 };
    w.decisions.answer = (instructions) => (instructions.includes('web/search') ? 0.9 : 0.2);
    await w.search.set('fn', { by: 'decision' }, ADMIN);
    const page = await w.search.filter(PAGE, { text: 'find pages about heat pumps' }, { run: RUN, latest: 'Is a heat pump worth it?' });
    // fns are filtered; context, whose setting is none, is left as it was
    expect(page.items.map((h) => h.name)).toEqual(['web/search', 'web/guide', 'fs/authoring']);
    expect(page.next).toBe(4);
    expect(page.filtered).toEqual([{ item: 'fn', by: 'decision', dropped: [{ name: 'web/fetch_raw', note: '20% likely' }], calls: ['mdl_d1', 'mdl_d2'] }]);
    // two fn hits at one question a call: two calls, each recorded as fns-search and charged to the run
    expect(w.decisions.asked).toEqual([['h0'], ['h1']]);
    expect(w.decisions.sites).toEqual([{ purpose: SEARCH_DECISION_PURPOSES.fn, run: RUN }, { purpose: 'fns-search', run: RUN }]);
  });

  it('by an LLM: its picks are kept, with the reasons for what it dropped, under the context purpose', async () => {
    const w = await world();
    await w.search.set('context', { by: 'llm', model: { model: { model: 'tiny' } } }, ADMIN);
    w.llm.answers = ['{"keep":[{"name":"web/guide"}],"dropped":[{"name":"fs/authoring","reason":"about writing systems"}]}'];
    const page = await w.search.filter(PAGE, { text: 'search the web' }, { latest: 'Find me sources' });
    expect(page.items.map((h) => h.name)).toEqual(['web/search', 'web/guide', 'web/fetch_raw']);
    expect(page.filtered).toEqual([{ item: 'context', by: 'llm', dropped: [{ name: 'fs/authoring', note: 'about writing systems' }], calls: ['mdl_1'] }]);
    expect(w.llm.sites).toEqual([{ purpose: 'context-search' }]);
    const prompt = JSON.stringify(w.llm.asked[0]?.request.messages);
    expect(prompt).toContain('Search: search the web');
    expect(prompt).toContain('Latest user message: Find me sources');
    expect(prompt).not.toContain('web/fetch_raw');
    // an action of load marks the record so (hub/fns_search loads the kept hits); the filter itself loads nothing
    await w.search.set('context', { by: 'llm', model: { model: { model: 'tiny' } }, action: 'load' }, ADMIN);
    w.llm.answers = ['{"keep":[{"name":"web/guide"}]}'];
    const loads = await w.search.filter(PAGE, { text: 'search the web' }, {});
    expect(loads.filtered).toEqual([{ item: 'context', by: 'llm', dropped: [{ name: 'fs/authoring' }], calls: ['mdl_2'], action: 'load' }]);
    expect(loads.loaded).toBeUndefined();
  });

  it('keeps every hit when the model fails, and says so', async () => {
    const w = await world();
    await w.search.set('fn', { by: 'llm', model: { model: { model: 'tiny' } } }, ADMIN);
    w.llm.answers = ['not json'];
    const page = await w.search.filter(PAGE, { text: 'search the web' }, {});
    expect(page.items).toEqual(PAGE.items);
    expect(page.filtered?.[0]).toMatchObject({ item: 'fn', by: 'llm', dropped: [], calls: ['mdl_1'] });
    expect(page.filtered?.[0]?.failed).toMatch(/LLM failed .*every hit was kept/);
    // a decision model with no decide role set fails before any call
    await w.search.set('fn', { by: 'decision' }, ADMIN);
    const none = await w.search.filter(PAGE, { text: 'search the web' }, {});
    expect(none.items).toEqual(PAGE.items);
    expect(none.filtered?.[0]?.failed).toMatch(/decision model failed/);
    expect(w.records.some((l) => l.msg === 'fns.search-decision.failed')).toBe(true);
  });

  it('leaves a search by name, for named items or with no text as it is', async () => {
    const w = await world();
    w.decisions.role = { model: 'judge', threshold: 0.5 };
    await w.search.set('fn', { by: 'decision' }, ADMIN);
    for (const query of [{}, { text: ' ' }, { text: 'web', order: 'name' as const }, { text: 'web', names: [QualifiedName.parse('web/search')] }]) {
      expect(await w.search.filter(PAGE, query, {})).toBe(PAGE);
    }
    expect(w.decisions.asked).toEqual([]);
  });

  it('wraps the database search, so every caller of the operation gets the filtered page', async () => {
    const w = await world();
    w.decisions.role = { model: 'judge', threshold: 0.5 };
    w.decisions.answer = (instructions) => (instructions.includes('web/fetch_raw') ? 0 : 1);
    await w.search.set('fn', { by: 'decision' }, ADMIN);
    const wrapped = new DecidedFnSearch({ search: () => Promise.resolve(PAGE) }, w.search);
    const page = await wrapped.search({ text: 'web' }, { actor: ADMIN, access: openScope(ADMIN) });
    expect(page.items.map((h) => h.name)).not.toContain('web/fetch_raw');
  });

  /** A database search over PAGE's items: a ranked search finds what `ranked` says, a lookup by name finds those names. */
  const byName = (ranked: (query: FnSearchQuery) => FnSearchHit[]) => ({
    queries: [] as FnSearchQuery[],
    search(query: FnSearchQuery): Promise<FnSearchPage> {
      this.queries.push(query);
      if (query.order === 'name' && query.names !== undefined && query.text === undefined) {
        const names = new Set<string>(query.names);
        return Promise.resolve({ items: PAGE.items.filter((h) => names.has(h.name) && (query.items === undefined || query.items.includes(h.item))) });
      }
      return Promise.resolve({ items: ranked(query) });
    },
  });

  it('gives an item named exactly first, marked exact, even when the decision drops it (iteration 2)', async () => {
    const w = await world();
    w.decisions.role = { model: 'judge', threshold: 0.5 };
    // the decision model finds no hit likely: a search whose text is a guide's name lost the guide
    w.decisions.answer = () => 0.2;
    await w.search.set('context', { by: 'decision' }, ADMIN);
    const inner = byName(() => PAGE.items.filter((h) => h.item === 'context'));
    const wrapped = new DecidedFnSearch(inner, w.search);
    const page = await wrapped.search({ text: 'web/guide', items: ['context'] }, { actor: ADMIN, access: openScope(ADMIN) });
    expect(page.items).toEqual([{ ...PAGE.items[1], exact: true }]);
    // the dropped list no longer names what came back
    expect(page.filtered?.[0]?.dropped.map((d) => d.name)).toEqual(['fs/authoring']);
    // a name-like word in a longer text, and a fn as a model spells it, are named exactly too
    const words = await wrapped.search({ text: 'how to use `web/guide` and web__search', items: ['context', 'fn'] }, { actor: ADMIN, access: openScope(ADMIN) });
    expect(words.items.filter((h) => h.exact === true).map((h) => h.name)).toEqual(['web/search', 'web/guide']);
  });

  it('finds an item named in `names` whatever the other filters, and says which names nothing has (iteration 2)', async () => {
    const w = await world();
    // names with a memory scope: the ranked search finds nothing (a system guide is no memory)
    const inner = byName(() => []);
    const wrapped = new DecidedFnSearch(inner, w.search);
    const page = await wrapped.search(
      { text: 'web guide search and read pages', names: [QualifiedName.parse('web/guide'), QualifiedName.parse('web/nope')], scopes: ['everyone'], items: ['context'] },
      { actor: ADMIN, access: openScope(ADMIN) },
    );
    expect(page.items.map((h) => [h.name, h.exact])).toEqual([['web/guide', true]]);
    expect(page.missing).toEqual({ names: ['web/nope'], note: 'No context item you may use here is named web/nope: check the spelling, or search by what it does or is about instead.' });
    // the lookup is by name alone: no scopes, no text
    expect(inner.queries.at(-1)).toEqual({ names: ['web/guide', 'web/nope'], order: 'name', limit: 2, items: ['context'] });
    // a later page doesn't repeat them
    expect((await wrapped.search({ text: 'web/guide', offset: 10 }, { actor: ADMIN, access: openScope(ADMIN) })).items).toEqual([]);
  });

  it('names words that are names, and leaves plain words alone', () => {
    expect(exactNames({ text: 'fs/guide' })).toEqual(['fs/guide']);
    expect(exactNames({ text: 'read "web/api.pages", then web__read.' })).toEqual(['web/api.pages', 'web/read']);
    expect(exactNames({ text: 'and/or either way', names: [QualifiedName.parse('x/y')] })).toEqual(['x/y', 'and/or']);
    expect(exactNames({ text: 'plain words only' })).toEqual([]);
  });

  it('asks whether each hit fits what the search is for, with the turn\'s latest message when there is one', () => {
    expect(purposeText({ text: 'groceries' })).toBe('Search: groceries');
    expect(purposeText({ text: 'groceries', latest: 'Help me track groceries' })).toBe('Search: groceries\nLatest user message: Help me track groceries');
    expect(hitQuestions(PAGE.items.slice(0, 1))).toEqual({ h0: { type: 'predicate', instructions: 'Does this tool fit what the search is for? web/search: Search the web.' } });
    const system = filterPrompt({ text: 'x' }, []).at(0)?.content;
    expect(system).toContain('keep the tools and context items that fit what the search is for');
  });
});
