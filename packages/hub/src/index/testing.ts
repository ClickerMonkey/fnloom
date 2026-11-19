/**
 * Test rigs for search over a real store with no embedder connected: words alone (FTS5), as the hub searches before an
 * embedder system is up. `wordsIndex` indexes items through the real indexer (`StoreIndexer.upsert`: a context item
 * with its heading sections), and `wordsFnSearch` is the one fns and context search over them. `rigHubAi` is the hub's AI
 * the index embeds through, over a link rig's systems' providers.
 */
import type { Providers } from '@aeye/ai';
import { limiter } from '@ayepi/rate';
import { ActorId, QualifiedName, type ContextRecord } from '@harness/core';
import { FixtureCatalog } from '../chat/testing.ts';
import type { ResourceRouter } from '../link/index.ts';
import { memoryLog, RecordingBus } from '../testing.ts';
import type { Catalog } from '../catalog/index.ts';
import type { AccessService } from '../access/index.ts';
import type { FnViewSource } from '../contextor/index.ts';
import type { FnSearch } from '../fns/index.ts';
import { StoreFnSearch } from '../fns/search.ts';
import { HybridSearch } from '../store/hybrid.ts';
import type { HubStore } from '../store/index.ts';
import { AeyeLlm, createHubAi, HubAiHooks, SwitchingLlm } from '../execution/ai.ts';
import { HubLlmGateway } from '../execution/gateway.ts';
import { InteractionRecorder } from '../execution/interactions.ts';
import { HubLedger } from '../execution/ledger.ts';
import { LedgerSpend } from '../execution/spend.ts';
import { testSettings } from '../execution/testing.ts';
import type { LinkRig } from '../link/rig.ts';
import { StoreModelCallLog } from '../metrics/calls.ts';
import { OfferedProviders, offeredBy, RemoteProvider } from '../models/remote.ts';
import { EmbedBatcher } from './batch.ts';
import type { HubEmbeds } from './embedders.ts';
import { contextText, StoreIndexer } from './indexer.ts';
import type { Embedders, IndexItem } from './index.ts';
import { IndexSearch } from './search.ts';
import { Sectioning } from './sectioning.ts';

/** The document embedder the rows are stored under. */
export const TEST_DOCUMENT = QualifiedName.parse('vectors/document');

/** No embedder connected. */
export const NO_EMBEDDERS: Embedders = { get: () => undefined, active: () => undefined, images: () => undefined, onChange: () => () => undefined };

/** For list sources in tests that never search context by text. */
export const NO_FN_SEARCH: { readonly search: Pick<FnSearch, 'search'> } = { search: { search: () => Promise.reject(new Error('this test has no search')) } };

/** No resources served: the rigs index and search fns and context only. */
const NO_RESOURCES: ResourceRouter = {
  roots: () => [], route: () => undefined, refresh: () => Promise.resolve(), stat: () => Promise.resolve(undefined), list: () => Promise.resolve({ items: [] }), changed: () => undefined,
  read: (uri) => Promise.reject(new Error(`no resource ${uri}`)), text: (uri) => Promise.reject(new Error(`no resource ${uri}`)),
  sections: (_sectioner, uri) => Promise.reject(new Error(`no resource ${uri}`)),
};

/** Index items by their words alone, through the real indexer with no embedder (a context item with its sections). */
export async function wordsIndex(store: HubStore, items: readonly IndexItem[]): Promise<void> {
  const { log } = memoryLog();
  const catalog = new FixtureCatalog();
  const batcher = new EmbedBatcher({ embedders: NO_EMBEDDERS, log, size: 8, wait: 1, poll: 2, concurrency: { interactive: 1, background: 1 } });
  const indexer = new StoreIndexer({
    store, bus: new RecordingBus(), log, clock: () => 1, catalog, embedders: NO_EMBEDDERS, batcher, router: NO_RESOURCES,
    sectioning: new Sectioning({ store, catalog, router: NO_RESOURCES }), document: TEST_DOCUMENT, maxText: 4000, maxCrawl: 10, chunk: 8, retry: { first: 20, most: 80 },
  });
  try { await indexer.upsert(items); } finally { await batcher.stop(); }
}

/** A context record as the item the indexer indexes for it. */
export function contextItem(record: ContextRecord): IndexItem {
  return { kind: 'context', key: record.name, text: contextText(record.name, record.decl), system: record.system };
}

/** The fns and context search over a store by words alone, everything public. */
export function wordsFnSearch(store: HubStore, catalog: Pick<Catalog, 'fn' | 'context'>): { search: StoreFnSearch; stop: () => Promise<void> } {
  const { log } = memoryLog();
  const batcher = new EmbedBatcher({ embedders: NO_EMBEDDERS, log, size: 8, wait: 1, poll: 2, concurrency: { interactive: 1, background: 1 } });
  const hybrid = new HybridSearch({ vectors: store.vectors, text: store.text }, { HARNESS_SEARCH_RRF_K: 60, HARNESS_SEARCH_DEPTH: 4 });
  const index = new IndexSearch({ store, hybrid, embedders: NO_EMBEDDERS, batcher, log, document: TEST_DOCUMENT, overfetch: 3, embedWait: 50 });
  const views: Pick<FnViewSource, 'view'> = { view: () => Promise.resolve(undefined) };
  const access: Pick<AccessService, 'sharing'> = { sharing: () => Promise.resolve({ owner: ActorId.parse('act_hub'), visibility: 'public', with: [] }) };
  const search = new StoreFnSearch({
    store: () => store, catalog: () => catalog, search: () => index, views: () => views, access: () => access,
    tuning: { HARNESS_FN_SEARCH_LIMIT: 20, HARNESS_FN_SEARCH_CANDIDATES: 100 },
  });
  return { search, stop: () => batcher.stop() };
}

/**
 * The hub's AI over the providers a link rig's systems offer, as the index embeds through it (`HubEmbeds`): the real
 * hub AI (its hooks price and record every call in the rig's store as a `ModelCall`) behind the real LLM gateway, with
 * the offered providers swapped in before each call, as the execution module does when they change.
 */
export function rigHubAi(rig: LinkRig): HubEmbeds & { readonly calls: StoreModelCallLog } {
  const offered = new OfferedProviders({ link: rig.links, catalog: rig.catalog, bus: rig.bus, log: rig.log, offered: offeredBy(rig.lifecycle) });
  const clock = (): number => rig.time.now;
  const settings = testSettings();
  const base = { store: rig.store, bus: rig.bus, clock, settings, log: rig.log };
  const calls = new StoreModelCallLog({ store: rig.store, clock, log: rig.log });
  const hooks = new HubAiHooks({
    ...base, ledger: new HubLedger(base, new LedgerSpend(rig.store)), recorder: new InteractionRecorder(base), calls,
    costs: { addCost: () => Promise.resolve(), addTokens: () => Promise.resolve() }, modelLimit: limiter({ limit: 1_000, window: 60_000 }),
  });
  const engine = new SwitchingLlm((providers: Providers) => new AeyeLlm(createHubAi({ providers, hooks, log: rig.log })), {});
  const gateway = new HubLlmGateway({
    ...base, llm: engine, models: { resolve: () => Promise.resolve({}) }, queues: { llm: (_priority, task) => task() },
    runs: { get: () => Promise.resolve(undefined), systemWork: () => Promise.reject(new Error('no system work here')), settle: () => Promise.resolve() },
  });
  return {
    calls,
    embed: async (input, site, signal, priority) => {
      const providers: Record<string, RemoteProvider> = {};
      for (const decl of await offered.list()) { providers[decl.key] = new RemoteProvider(decl.system, decl.provider, () => offered.link(decl.system)); }
      await engine.use(providers);
      return gateway.embed(input, site, signal, priority);
    },
  };
}
