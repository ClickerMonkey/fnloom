/**
 * The fns module over a real store, catalog and index search (words in FTS5, meaning in sqlite-vec, with a word-count
 * embedder): search with filters and paging, examples kept in step and ranked, facts worked out deeply with cost and
 * time estimates, the chat fn mode gate, the auto classifier, and browser logs rolled by size and quiet.
 */
import {
  ActorId, compositeKey, ModelCallId, QualifiedName, ResourceUri, RunId, SessionId, SystemName, noFnStats, noOutcomes,
  type FnMetricsDay, type FnRecord, type IndexedKind, type ModelInfo, type Session, type SystemStatus,
} from '@harness/core';
import { context, fn, g, hub, system, type as typeDecl } from '@harness/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openScope } from '../access/index.ts';
import { StoreCatalog } from '../catalog/catalog.ts';
import { CatalogFnViews } from '../contextor/views.ts';
import { Estimator } from '../contextor/tokens.ts';
import { manifestFor, systemRow } from '../catalog/fixtures.ts';
import { HybridSearch } from '../store/hybrid.ts';
import { EmbedBatcher } from '../index/batch.ts';
import { contextText, fnText } from '../index/indexer.ts';
import { IndexSearch } from '../index/search.ts';
import type { Embedder, Embedders, IndexItem, Indexer } from '../index/index.ts';
import { emptyDurations, addDuration } from '../metrics/rollup.ts';
import { RecordingBus, memoryLog, testStore } from '../testing.ts';
import type { HubStore } from '../store/index.ts';
import { LlmAutoClassifier } from './auto.ts';
import { ResourceClientLogs, logFileName } from './client-logs.ts';
import { AgentCostEstimator, DeclaredCostEstimator, FreeCostEstimator, HistoryCostEstimator, KindCostEstimator, UnknownCostEstimator } from './costs.ts';
import { StoreFnExamples } from './examples.ts';
import { aboutDuration, StoreFnFacts } from './facts.ts';
import { SessionModeGate } from './gate.ts';
import type { Asker } from './index.ts';
import { StoreFnSearch } from './search.ts';

const DOCUMENT = QualifiedName.parse('vectors/document');
const QUERY = QualifiedName.parse('vectors/query');
const ME = ActorId.parse('act_me');
const q = (name: string) => QualifiedName.parse(name);

/** Three dimensions: how much a text is about invoices, about trips, and a constant. */
function wordVector(text: string): number[] {
  const words = text.toLowerCase().split(/\W+/);
  const count = (...of: string[]) => words.filter((w) => of.includes(w)).length;
  return [count('invoice', 'invoices', 'overdue', 'unpaid'), count('trip', 'trips', 'travel', 'flight'), 0.1];
}

class WordEmbedder implements Embedder {
  readonly maxInput = 1_000;
  readonly dimensions = 3;
  readonly name: QualifiedName;
  constructor(name: QualifiedName) { this.name = name; }
  embed(texts: readonly string[]): Promise<number[][]> { return Promise.resolve(texts.map(wordVector)); }
}

class WordEmbedders implements Embedders {
  readonly #pair = { document: new WordEmbedder(DOCUMENT), query: new WordEmbedder(QUERY) };
  get(name: QualifiedName): Embedder | undefined { return name === DOCUMENT ? this.#pair.document : name === QUERY ? this.#pair.query : undefined; }
  active(): { document: Embedder; query: Embedder } { return this.#pair; }
  onChange(): () => void { return () => undefined; }
}

/** An indexer that writes rows, words and vectors at once (the real one batches through the embedder queue). */
class DirectIndexer implements Pick<Indexer, 'upsert' | 'remove'> {
  readonly #store: HubStore;
  constructor(store: HubStore) { this.#store = store; }
  async upsert(items: readonly IndexItem[]): Promise<void> {
    for (const item of items) {
      await this.#store.table('index').put({ embedder: DOCUMENT, kind: item.kind, key: item.key, text: item.text, hash: item.text, vectorHash: item.text, updatedAt: 1, ...(item.system === undefined ? {} : { system: item.system }) });
    }
    await this.#store.text.upsert(items.map((item) => ({ kind: item.kind, key: item.key, text: item.text })));
    await this.#store.vectors.upsert(DOCUMENT, items.map((item) => ({ kind: item.kind, key: item.key, vector: wordVector(item.text) })));
  }
  async remove(kind: IndexedKind, keys: readonly string[]): Promise<void> {
    await this.#store.text.remove(kind, keys);
    await this.#store.vectors.remove(DOCUMENT, kind, keys);
    for (const key of keys) await this.#store.table('index').remove({ embedder: DOCUMENT, kind, key });
  }
}

/** Saved queries of a database instance, a form system, and a read-only notes system with context. */
const Invoice = typeDecl({ description: 'An invoice.', shape: g.obj({ id: g.text(), total: g.num() }), display: { label: 'Invoice' } });
const books = system('books', { description: 'Bookkeeping.' }).with({ types: { Invoice } }).with(({ types }) => ({
  fns: {
    overdue: fn({
      description: 'Invoices that are overdue and unpaid.', args: g.obj({ days: g.num() }), returns: g.list(types.Invoice), tags: ['read'],
      examples: [{ args: { days: 30 }, note: 'a month late' }, { args: { days: 90 }, note: 'a quarter late, unpaid invoices' }, { args: { days: 1 }, note: 'any late invoice at all' }],
    }),
    void_invoice: fn({ description: 'Void an invoice.', args: g.obj({ invoice: types.Invoice }), returns: g.bool() }),
    book_trip: fn({ description: 'Book travel for a trip.', args: g.obj({ to: g.text() }), returns: g.text(), limits: { cost: 0.5 } }),
  },
})).with(({ fns }) => ({ fns: { close_month: fn({ description: 'Close the month: voids unpaid invoices.', args: g.obj({}), returns: g.bool(), deps: { void_invoice: fns.void_invoice } }) } }));
const notes = system('notes', { description: 'Notes.' }).with({
  fns: { read_note: fn({ description: 'Read a travel note about a trip.', args: g.obj({ id: g.text() }), returns: g.text(), tags: ['read'] }) },
  context: { travel: context({ description: 'How trips and travel are planned.', content: 'Plan the flight first.' }) },
});

// every test imports the hub's whole contract into a fresh store: under a full parallel run that can pass the 5 s default
vi.setConfig({ testTimeout: 20_000 });

async function setup(options: { status?: SystemStatus } = {}) {
  const store = await testStore({ dimensions: { [DOCUMENT]: 3 } });
  const bus = new RecordingBus();
  const { log } = memoryLog();
  for (const name of ['books', 'notes']) await store.table('systems').put(systemRow(name, options.status ?? 'connected'));
  const catalog = new StoreCatalog({ store, bus, log, clock: () => 5, describer: { describe: (kind) => Promise.resolve(kind === 'hub/llm' ? { problems: [], description: AGENT_DESCRIPTION } : { problems: ['no kinds'] }) } });
  await catalog.importManifest(await manifestFor(hub));
  // what the SDK's fn builder doesn't set yet: the fn's own effects and its prompt example count
  const booksManifest = await manifestFor(books);
  await catalog.importManifest({
    ...booksManifest,
    fns: booksManifest.fns.map((decl) => (decl.name === 'void_invoice' ? { ...decl, effects: { mode: 'delete' as const } } : decl.name === 'overdue' ? { ...decl, promptExamples: 1 } : decl)),
  });
  await catalog.importManifest(await manifestFor(notes));
  const indexer = new DirectIndexer(store);
  const fns = await catalog.fns({});
  await indexer.upsert([
    ...fns.map((f) => ({ kind: 'fn' as const, key: f.name, text: fnText(f.name, f.decl), system: f.system })),
    ...(await catalog.entries('context')).map((c) => ({ kind: 'context' as const, key: c.name, text: contextText(c.name, c.decl), system: c.system })),
  ]);
  const embedders = new WordEmbedders();
  const batcher = new EmbedBatcher({ embedders, log, size: 8, wait: 1, poll: 2, concurrency: { interactive: 1, background: 1 } });
  stops.push(() => batcher.stop());
  const hybrid = new HybridSearch({ vectors: store.vectors, text: store.text }, { HARNESS_SEARCH_RRF_K: 60, HARNESS_SEARCH_DEPTH: 4 });
  const index = new IndexSearch({ store, hybrid, embedders, batcher, log, document: DOCUMENT, overfetch: 3, embedWait: 1_000 });
  const days: FnMetricsDay[] = [];
  const facts = new StoreFnFacts({
    store: () => store, catalog: () => catalog, metrics: () => ({ days: () => Promise.resolve(days) }), clock: () => 7,
    estimators: [new FreeCostEstimator(), new HistoryCostEstimator(), new AgentCostEstimator({ models: () => Promise.resolve(MODELS), defaultModel: () => Promise.resolve('cheap'), tokens: (model) => Promise.resolve(new Estimator(model, LIMITS, 1)) }), new DeclaredCostEstimator(), new UnknownCostEstimator()],
    tuning: { HARNESS_FN_FACTS_DEPTH: 8, HARNESS_FN_LONG_RUNNING: 60_000, HARNESS_FN_HISTORY_DAYS: 30 },
  });
  await facts.refresh(fns, []);
  const examples = new StoreFnExamples({ store: () => store, catalog: () => catalog, indexer: () => indexer, search: () => index, clock: () => 9, tuning: { HARNESS_FN_EXAMPLES_PAGE: 2, HARNESS_FN_SEARCH_CANDIDATES: 100 } });
  await examples.sync(fns, []);
  const owners = new Map<string, ActorId>();
  const views = new CatalogFnViews(catalog);
  const search = new StoreFnSearch({
    store: () => store, catalog: () => catalog, search: () => index,
    views: () => views,
    access: () => ({ sharing: (target) => Promise.resolve({ owner: (target.kind === 'fn' ? owners.get(target.fn) : undefined) ?? ActorId.parse('act_hub'), visibility: target.kind === 'fn' && owners.has(target.fn) ? 'private' : 'public', with: [] }) }),
    tuning: { HARNESS_FN_SEARCH_LIMIT: 20, HARNESS_FN_SEARCH_CANDIDATES: 100 },
  });
  const asker: Asker = { actor: ME, access: openScope(ME) };
  return { store, catalog, indexer, index, facts, examples, search, asker, days, owners };
}

/** How the hub's `llm` kind describes an agent here (its own system is the hub). */
const AGENT_DESCRIPTION = { args: { name: 'any' }, returns: { name: 'text' }, deps: [], operations: { cancel: true, pause: false, undo: false, background: false } };

/** The test model's limits. */
const LIMITS = { contextWindow: 32_000, maxOutputTokens: 4_000, reasoningTokens: 0, charsPerToken: 4 };
const MODELS: ModelInfo[] = [{ id: 'cheap', provider: 'openrouter', name: 'Cheap', pricing: { input: 1, output: 2 }, capabilities: ['chat'] }];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

describe('fns search in the hub database', () => {
  it('ranks by words and meaning, filters by system, kind, mode, types and name, and pages', async () => {
    const { search, asker } = await setup();
    const found = await search.search({ text: 'unpaid overdue invoices', items: ['fn'], systems: [SystemName.parse('books')] }, asker);
    expect(found.items[0]?.name).toBe('books/overdue');
    expect(found.items[0]).toMatchObject({ item: 'fn', kind: 'native', mode: 'read', available: true });
    expect(found.items[0]?.signature).toContain('books/overdue(');
    // by meaning alone, still within the filter
    const semantic = await search.search({ text: 'travel', match: 'semantic', systems: [SystemName.parse('notes')] }, asker);
    expect(semantic.items.map((h) => h.name).sort()).toEqual(['notes/read_note', 'notes/travel']);
    // modes: deletes are the void and, deeply, closing the month
    const deletes = await search.search({ modes: ['delete'], systems: [SystemName.parse('books')] }, asker);
    expect(deletes.items.map((h) => h.name)).toEqual(['books/close_month', 'books/void_invoice']);
    // a hub fn that removes something from the registry (its declared effects) is a delete too
    expect((await search.search({ modes: ['delete'], systems: [SystemName.parse('hub')], limit: 100 }, asker)).items.map((h) => h.name)).toContain('hub/resource_delete');
    // types: what writes invoices, and what reads them
    expect((await search.search({ types: { writes: [q('books/Invoice')] } }, asker)).items.map((h) => h.name)).toEqual(['books/close_month', 'books/void_invoice']);
    expect((await search.search({ types: { reads: [q('books/Invoice')] } }, asker)).items.map((h) => h.name)).toEqual(['books/overdue']);
    // paging by name
    const first = await search.search({ systems: [SystemName.parse('books')], items: ['fn'], limit: 2 }, asker);
    expect(first.items.map((h) => h.name)).toEqual(['books/book_trip', 'books/close_month']);
    expect(first.next).toBe(2);
    const second = await search.search({ systems: [SystemName.parse('books')], items: ['fn'], limit: 2, offset: 2 }, asker);
    expect(second.items.map((h) => h.name)).toEqual(['books/overdue', 'books/void_invoice']);
    expect(second.next).toBeUndefined();
    // names: exactly the fns asked for, whatever ranks above them
    expect((await search.search({ names: [q('books/void_invoice'), q('notes/read_note')], items: ['fn'] }, asker)).items.map((h) => h.name)).toEqual(['books/void_invoice', 'notes/read_note']);
    expect((await search.search({ names: [q('books/overdue')], text: 'travel notes' }, asker)).items.map((h) => h.name)).toEqual(['books/overdue']);
  });

  it('keeps to what the asker may see and use, and to whose fns they are', async () => {
    const { search, asker, owners } = await setup();
    const hidden: Asker = { actor: ME, access: { ...openScope(ME), seesFn: (f) => f.name !== 'books/overdue' } };
    expect((await search.search({ text: 'overdue invoices', items: ['fn'] }, hidden)).items.map((h) => h.name)).not.toContain('books/overdue');
    owners.set('books/overdue', ME);
    expect((await search.search({ visibility: 'mine' }, asker)).items.map((h) => h.name)).toEqual(['books/overdue']);
    expect((await search.search({ visibility: 'public', systems: [SystemName.parse('notes')] }, asker)).items.map((h) => h.name)).toEqual(['notes/read_note']);
  });

  it('leaves out fns that can\'t be used now unless asked for them', async () => {
    const { search, asker } = await setup({ status: 'disconnected' });
    expect((await search.search({ systems: [SystemName.parse('books')], items: ['fn'] }, asker)).items).toEqual([]);
    const all = await search.search({ systems: [SystemName.parse('books')], items: ['fn'], available: false }, asker);
    const anyReason: unknown = expect.any(String);
    expect(all.items[0]).toMatchObject({ available: false, unavailable: anyReason });
  });

  it('ranks inside the database: a `within` list reaches the vector and text indexes', async () => {
    const { store } = await setup();
    const near = await store.vectors.nearest(DOCUMENT, [1, 0, 0.1], 5, ['fn'], [{ kind: 'fn', key: 'books/void_invoice' }, { kind: 'fn', key: 'notes/read_note' }]);
    expect(near.map((h) => h.key)).toEqual(['books/void_invoice', 'notes/read_note']);
    const words = await store.text.search({ text: 'invoice', kinds: ['fn'], limit: 5, within: [{ kind: 'fn', key: 'books/close_month' }] });
    expect(words.map((h) => h.key)).toEqual(['books/close_month']);
    expect(compositeKey('fn', 'x')).toContain('fn');
  });
});

describe('fn examples', () => {
  it('keeps declared examples in their own table, pages them, ranks them by a query, and picks some for the prompt', async () => {
    const { examples, asker, catalog, store, indexer, index } = await setup();
    const page = await examples.page({ fn: q('books/overdue'), limit: 2 }, asker);
    expect(page).toMatchObject({ total: 3, next: 2 });
    expect(page.items.map((e) => e.args)).toEqual([{ days: 30 }, { days: 90 }]);
    const ranked = await examples.page({ fn: q('books/overdue'), query: 'quarter' }, asker);
    expect(ranked.items[0]?.note).toBe('a quarter late, unpaid invoices');
    // past the candidate cap the database ranks every example and only this fn's are kept
    const capped = new StoreFnExamples({ store: () => store, catalog: () => catalog, indexer: () => indexer, search: () => index, clock: () => 9, tuning: { HARNESS_FN_EXAMPLES_PAGE: 2, HARNESS_FN_SEARCH_CANDIDATES: 1 } });
    expect((await capped.page({ fn: q('books/overdue'), query: 'quarter' }, asker)).items[0]?.note).toBe('a quarter late, unpaid invoices');
    const overdue = await catalog.fn(q('books/overdue'));
    if (overdue === undefined) throw new Error('no fn');
    expect(await examples.forPrompt(overdue, 'any invoice at all', 1)).toEqual([{ args: { days: 1 }, note: 'any late invoice at all' }]);
    // an example an admin switched off (by the name the system page lists it by) stays out of the prompt
    await store.table('itemSwitches').put({ system: overdue.system, section: 'examples', name: 'books/overdue #1', by: ActorId.parse('act_admin'), at: 1 });
    expect((await examples.forPrompt(overdue, '', 3)).map((e) => e.args)).toEqual([{ days: 90 }, { days: 1 }]);
    await store.table('itemSwitches').remove({ system: overdue.system, section: 'examples', name: 'books/overdue #1' });
    // a changed declaration replaces what changed; a removed fn takes its examples with it
    await examples.sync([{ ...overdue, decl: { ...overdue.decl, examples: [{ args: { days: 30 }, note: 'a month late' }] } }], []);
    expect((await examples.page({ fn: q('books/overdue') }, asker)).total).toBe(1);
    await examples.sync([], [q('books/overdue')]);
    expect(await store.table('fnExamples').count({ fn: q('books/overdue') })).toBe(0);
    await expect(examples.page({ fn: q('books/nope') }, asker)).rejects.toThrow('no fn');
  });

  it('lets a system add, replace and remove examples of its own fns while running, leaving the declared ones (build 6)', async () => {
    const { examples, asker, store } = await setup();
    const books = SystemName.parse('books');
    expect(await examples.patch(books, { fn: 'overdue', upsert: [{ key: 'q1', args: { days: 7 }, note: 'a week late' }], remove: [] })).toEqual({ added: 1, removed: 0 });
    expect((await examples.page({ fn: q('books/overdue') }, asker)).total).toBe(4);
    const first = (await store.table('fnExamples').find({ where: { fn: q('books/overdue'), source: 'runtime' }, limit: 5 })).items;
    expect(await examples.patch(books, { fn: 'overdue', upsert: [{ key: 'q1', args: { days: 14 }, note: 'two weeks late' }], remove: [] })).toEqual({ added: 0, removed: 0 });
    const replaced = (await store.table('fnExamples').find({ where: { fn: q('books/overdue'), source: 'runtime' }, limit: 5 })).items;
    expect(replaced.map((row) => [row.id, row.args])).toEqual([[first[0]?.id, { days: 14 }]]);
    expect(await examples.patch(books, { fn: 'overdue', upsert: [], remove: ['q1'] })).toEqual({ added: 0, removed: 1 });
    expect((await examples.page({ fn: q('books/overdue') }, asker)).total).toBe(3);
    await expect(examples.patch(SystemName.parse('other'), { fn: 'overdue', upsert: [], remove: [] })).rejects.toThrow(/has no fn/);
  }, 20_000);
});

describe('fn facts', () => {
  it('works out mode, types and freedom deeply, costs from history, payload or declaration, and run times', async () => {
    const { facts, days } = await setup();
    const close = await facts.facts(q('books/close_month'));
    expect(close).toMatchObject({ mode: 'delete', writes: ['books/Invoice'], uses: ['books/void_invoice'], free: true, cost: { basis: 'free', typical: 0 }, longRunning: false });
    expect((await facts.facts(q('books/overdue'))).reads).toEqual(['books/Invoice']);
    expect((await facts.facts(q('books/book_trip'))).cost).toEqual({ min: 0.5, typical: 0.5, max: 0.5, basis: 'payload', runs: 0 });
    // the hub's chat agent spends on its model: priced from its instructions and the call's args
    const agent = await facts.facts(q('hub/chat'), { question: 'x'.repeat(4_000) });
    expect(agent.free).toBe(false);
    expect(agent.cost.basis).toBe('payload');
    expect(agent.cost.min).toBeGreaterThan(0.001);
    expect(agent.cost.max).toBeGreaterThan(agent.cost.typical);
    // with history: the day's averages bound it, and slow runs make it long-running with a notice
    let ran = emptyDurations();
    for (const ms of [200_000, 200_000, 250_000]) ran = addDuration(ran, ms);
    const day = (cost: number, runs: number): FnMetricsDay => ({
      fn: q('books/book_trip'), system: SystemName.parse('books'), day: '2026-11-09', outcomes: { ...noOutcomes(), done: runs }, queued: emptyDurations(), approval: emptyDurations(), ran,
      cost, tokens: 0, retries: 0, modelCalls: 0, updatedAt: 1,
    });
    days.push(day(2, 2), day(3, 1));
    const trip = await facts.facts(q('books/book_trip'));
    expect(trip.cost).toEqual({ min: 1, typical: 5 / 3, max: 3, basis: 'history', runs: 3 });
    expect(trip.longRunning).toBe(true);
    expect(trip.notice).toBe(`books/book_trip usually takes ${aboutDuration(trip.times?.typical ?? 0)}.`);
    expect(aboutDuration(185_000)).toBe('about 3 minutes');
    // the same warning, without the cost estimate, for the fn lines the model reads
    expect(await facts.notices([q('books/book_trip')])).toEqual(new Map([[q('books/book_trip'), trip.notice]]));
    days.length = 0;
    expect(await facts.notices([q('books/book_trip')])).toEqual(new Map());
  });

  it('works out again the facts of the fns that use a changed fn', async () => {
    const { facts, catalog, store } = await setup();
    expect(await store.table('fnUses').count({ uses: q('books/void_invoice') })).toBe(1);
    // void_invoice no longer declares that it deletes: close_month, which uses it, now only writes
    await catalog.importManifest(await manifestFor(books));
    const voided = await catalog.fn(q('books/void_invoice'));
    if (voided === undefined) throw new Error('no fn');
    await facts.refresh([voided], []);
    expect((await facts.modes([q('books/close_month')])).get(q('books/close_month'))).toBe('write');
  });
});

describe('chat fn mode', () => {
  const session = (fnMode?: Session['fnMode']): Session => ({
    id: SessionId.parse('ses_1'), title: '', owner: ME, agent: q('hub/chat'), participants: [], systems: 'all', tools: [], context: [], status: 'idle', transcript: [],
    createdAt: 0, updatedAt: 0, archived: false, ...(fnMode === undefined ? {} : { fnMode }),
  });
  const RUN = RunId.parse('run_1');

  it('passes, refuses or asks the classifier by the chat\'s mode and the fn\'s', async () => {
    const { facts, catalog } = await setup();
    const asked: string[] = [];
    const gate = new SessionModeGate(() => facts, () => ({ classify: (input) => { asked.push(input.fn.name); return Promise.resolve({ allow: input.fn.name === 'books/book_trip', reason: 'because' }); } }));
    const fnOf = async (name: string) => { const f = await catalog.fn(q(name)); if (f === undefined) throw new Error(name); return f; };
    const check = async (mode: Session['fnMode'], name: string) => (await gate.check({ session: session(mode), fn: await fnOf(name), args: {}, run: RUN, flags: [] })).effect;
    expect(await check(undefined, 'books/void_invoice')).toBe('pass');
    expect(await check('none', 'books/overdue')).toBe('refuse');
    expect(await check('read', 'books/overdue')).toBe('pass');
    expect(await check('read', 'books/book_trip')).toBe('refuse');
    expect(await check('write', 'books/book_trip')).toBe('pass');
    expect(await check('write', 'books/close_month')).toBe('refuse');
    expect(await check('delete', 'books/close_month')).toBe('pass');
    expect(await check('auto', 'books/overdue')).toBe('pass');
    expect(await check('auto', 'books/book_trip')).toBe('allow');
    expect(await check('auto', 'books/void_invoice')).toBe('ask');
    expect(asked).toEqual(['books/book_trip', 'books/void_invoice']);
  });

  it('asks the classifier model, and lets the person decide without one or when it fails', async () => {
    const { store, catalog } = await setup();
    const { log } = memoryLog();
    const answers: string[] = [];
    const sent: string[] = [];
    const formats: unknown[] = [];
    const classifier = new LlmAutoClassifier({
      store: () => store, clock: () => 3, log, tuning: { HARNESS_AUTO_CLASSIFIER_WAIT: 5_000 },
      llm: () => ({
        chat: (input) => {
          sent.push(JSON.stringify(input.request.messages));
          formats.push(input.request.responseFormat);
          const value = answers.shift();
          return value === undefined ? Promise.reject(new Error('down')) : Promise.resolve({ value, call: ModelCallId.parse('mdl_1'), cost: 0, model: 'cheap' });
        },
      }),
    });
    const trip = await catalog.fn(q('books/book_trip'));
    if (trip === undefined) throw new Error('no fn');
    const input = { session: session('auto'), fn: trip, mode: 'write' as const, args: { to: 'Oslo' }, run: RUN };
    expect((await classifier.classify(input)).allow).toBe(false);
    await classifier.set({ model: { model: { model: 'cheap' } }, messages: 2 }, ME);
    expect((await classifier.setting()).value.model).toEqual({ model: { model: 'cheap' } });
    answers.push('{"allow": true, "reason": "You asked to book it."}');
    expect(await classifier.classify(input)).toEqual({ allow: true, reason: 'You asked to book it.' });
    // the verdict is asked for as structured output, so no JSON is scraped out of free text
    expect(formats.at(-1)).toMatchObject({ strict: true, schema: { type: 'object', required: ['allow', 'reason'] } });
    expect(sent[0]).toContain('books/book_trip (write)');
    expect(sent[0]).toContain('Oslo');
    expect((await classifier.classify(input)).allow).toBe(false);
  });
});

describe('browser logs', () => {
  it('writes a person\'s lines to their own file, starting a new one after a quiet spell or past the size limit', async () => {
    const now = { at: Date.UTC(2026, 10, 10, 14, 0, 0) };
    const kept: Array<{ path: string; name: string; text: string }> = [];
    const owned: string[] = [];
    const logs = new ResourceClientLogs({
      clock: () => now.at, log: memoryLog().log, tuning: { HARNESS_CLIENT_LOG_MAX_BYTES: 400, HARNESS_CLIENT_LOG_QUIET: 300_000 },
      content: () => ({ put: (bytes) => Promise.resolve({ hash: 'a'.repeat(64), size: bytes.length, mime: 'application/x-ndjson' }) }),
      access: () => ({
        own: (target, owner, rule) => { owned.push(`${target.kind === 'root' ? target.uri : ''}:${owner}`); return Promise.resolve({ target, sharing: { owner, ...rule }, editable: true }); },
      }),
      library: () => ({
        keepMade: (input) => {
          kept.push({ path: input.path, name: input.name, text: String(input.content.size) });
          const uri = ResourceUri.parse(`hub://resources/${input.path}/${input.name}`);
          return Promise.resolve({ uri, system: SystemName.parse('hub'), stat: { uri, name: input.name, type: 'file', version: input.content.hash }, links: [], seenAt: now.at });
        },
      }),
    });
    const line = (message: string) => ({ entries: [{ type: 'log' as const, at: now.at, level: 'info' as const, message }] });
    const traffic = { entries: [{ type: 'traffic' as const, at: now.at, method: 'POST', endpoint: 'send', status: 200, duration: 30 }] };
    const first = await logs.write(ME, line('hello'));
    expect(first.uri).toBe(`hub://resources/logs/${ME}/${logFileName(now.at)}`);
    now.at += 60_000;
    expect((await logs.write(ME, traffic)).uri).toBe(first.uri);
    now.at += 300_001;
    const third = await logs.write(ME, line('later'));
    expect(third.uri).not.toBe(first.uri);
    now.at += 1_000;
    const big = await logs.write(ME, line('x'.repeat(380)));
    expect(big.uri).not.toBe(third.uri);
    expect(owned).toEqual(Array(3).fill(`hub://resources/logs/${ME}:${ME}`));
    expect(kept.map((k) => k.name)).toEqual([first.uri, first.uri, third.uri, big.uri].map((uri) => uri.split('/').at(-1)));
  });
});

describe('a kind estimates its fns\' cost (build 6)', () => {
  it('asks the kind\'s system with the payload, args and history, and falls through when it gives none', async () => {
    const asked: unknown[] = [];
    const record = { system: SystemName.parse('database'), decl: { name: 'query', description: '', applicability: '', payload: { name: 'any' }, approveChanges: false, estimates: true } };
    const estimator = new KindCostEstimator({
      kind: () => Promise.resolve(record),
      ask: (_system, request) => { asked.push(request); return Promise.resolve(request.args === undefined ? {} : { estimate: { min: 0, typical: 0.001, max: 0.002, basis: 'payload', runs: 0 } }); },
    });
    const fn: FnRecord = {
      name: q('database/main.sales'), system: SystemName.parse('database'), version: 'v1', origin: 'runtime', available: true, paused: false, disabled: false, stats: noFnStats(), updatedAt: 0,
      decl: {
        name: 'main.sales', description: 'Sales.', kind: q('database/query'), payload: { sql: 'select 1' }, args: { name: 'any' }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
        operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: [],
      },
    };
    expect(await estimator.estimate({ fn, free: false, args: { year: 2025 }, history: [] })).toEqual({ min: 0, typical: 0.001, max: 0.002, basis: 'payload', runs: 0 });
    expect(asked[0]).toEqual({ kind: 'database/query', payload: { sql: 'select 1' }, args: { year: 2025 } });
    expect(await estimator.estimate({ fn, free: false, history: [] })).toBeUndefined();
    expect(await estimator.estimate({ fn: { ...fn, decl: { ...fn.decl, kind: 'native' } }, free: false, history: [] })).toBeUndefined();
  });
});
