/**
 * Builds the fns module: search, examples, facts, the chat mode gate with its auto classifier, and browser logs. As
 * the hub starts it gives the run service the gate, keeps examples and facts in step with the catalog (every
 * `catalog.changed`), and catches up on fns stored before (those with no facts yet). It serves `searchFns` and
 * `fnExamples` on the system link; the web slice is served by `api/web/build5.ts`.
 */
import { reject, spec } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, type FnRecord, type QualifiedName, type RunId, type SystemName } from '@harness/core';
import type { HubServices, ModuleFactory } from '../boot/index.ts';
import { messageOf } from '../execution/errors.ts';
import { rows } from '../store/rows.ts';
import { LlmAutoClassifier } from './auto.ts';
import { ResourceClientLogs } from './client-logs.ts';
import { AgentCostEstimator, DeclaredCostEstimator, FreeCostEstimator, HistoryCostEstimator, KindCostEstimator, UnknownCostEstimator } from './costs.ts';
import { StoreFnExamples } from './examples.ts';
import { StoreFnFacts } from './facts.ts';
import { SessionModeGate } from './gate.ts';
import type { Asker, FnsServices } from './index.ts';
import { StoreFnSearch } from './search.ts';

/** The slice of `hubLinkSpec` this module answers. */
export const FNS_LINK_SPEC = spec({ endpoints: { searchFns: hubLinkSpec.endpoints.searchFns, fnExamples: hubLinkSpec.endpoints.fnExamples, examples: hubLinkSpec.endpoints.examples } });

/** Build the module's services over the hub's (read lazily). */
export function fnsServices(hub: HubServices): FnsServices {
  const tuning = hub.settings.fnsEnv;
  const store = () => hub.store;
  const search = new StoreFnSearch({
    store, catalog: () => hub.catalog, search: () => hub.index.search, views: () => hub.contextor.views, access: () => hub.access, tuning,
  });
  const examples = new StoreFnExamples({ store, catalog: () => hub.catalog, indexer: () => hub.index.indexer, search: () => hub.index.search, clock: () => hub.clock(), tuning });
  const facts = new StoreFnFacts({
    store, catalog: () => hub.catalog, metrics: () => hub.metrics.fns, clock: () => hub.clock(), tuning,
    estimators: [
      new FreeCostEstimator(),
      new KindCostEstimator({
        kind: (name) => hub.catalog.kind(name),
        // a kind's system that isn't connected or can't answer leaves it to the history and the declared cost
        ask: async (system, request) => {
          const connection = hub.link.connections.connection(system);
          if (connection === undefined) return undefined;
          try {
            return await connection.peer.call('estimate', request, { signal: AbortSignal.any([connection.signal, AbortSignal.timeout(tuning.HARNESS_FN_ESTIMATE_TIMEOUT)]) });
          } catch (error) {
            hub.log.warn('fns.estimate.failed', { system, kind: request.kind, error: error instanceof Error ? error.message : String(error) });
            return undefined;
          }
        },
      }),
      new HistoryCostEstimator(),
      new AgentCostEstimator({ models: () => hub.execution.llm.models(), defaultModel: () => Promise.resolve(hub.settings.modelEnv.HARNESS_DEFAULT_MODEL), tokens: (model) => hub.contextor.tokens.forModel(model) }),
      new DeclaredCostEstimator(),
      new UnknownCostEstimator(),
    ],
  });
  const classifier = new LlmAutoClassifier({ store, llm: () => hub.execution.llm, clock: () => hub.clock(), log: hub.log, tuning });
  const gate = new SessionModeGate(() => facts, () => classifier);
  const clientLogs = new ResourceClientLogs({
    content: () => hub.api.content, library: () => hub.resources.library, access: () => hub.access, clock: () => hub.clock(), log: hub.log, tuning,
  });
  return { search, examples, facts, gate, classifier, clientLogs };
}

/** Keep examples and facts in step with what changed in the catalog. */
async function follow(services: FnsServices, changed: readonly FnRecord[], removed: readonly QualifiedName[]): Promise<void> {
  await services.examples.sync(changed, removed);
  await services.facts.refresh(changed, removed);
}

/** Work out the facts and store the examples of every fn that has no facts yet (stored before this build). */
async function catchUp(hub: HubServices, services: FnsServices): Promise<number> {
  let done = 0;
  for await (const fn of rows(hub.store.table('fns'), { order: [['name', 'asc']] })) {
    if ((await hub.store.table('fnFacts').get(fn.name)) !== undefined) continue;
    await follow(services, [fn], []);
    done++;
  }
  return done;
}

/** The asker a system's search is for: the person of its run, or the system itself. */
async function linkAsker(hub: HubServices, system: SystemName, run: RunId | undefined): Promise<Asker> {
  const record = run === undefined ? undefined : await hub.store.table('runs').get(run);
  // a run of another system is no one's to ask for: the system asks as itself
  const actor = (record?.system === system ? record.actor : undefined) ?? (await hub.store.table('systems').get(system))?.actor;
  if (actor === undefined) throw reject(404, 'NO_SYSTEM', `${system} has no actor`);
  return { actor, access: await hub.access.scope(actor) };
}

/** The fns module's factory. */
export const fnsModule: ModuleFactory<'fns'> = ({ hub }) => {
  const services = fnsServices(hub);
  const stops: Array<() => void> = [];
  return {
    services,
    hooks: {
      work: {
        up: () => {
          hub.execution.runs.gateWith(services.gate);
          stops.push(hub.bus.subscribe('catalog.changed', ({ removed, fns }) => {
            void follow(services, fns, removed).catch((error: unknown) => { hub.log.warn('fns.follow.failed', { error: messageOf(error) }); });
          }));
          void catchUp(hub, services).then(
            (done) => { if (done > 0) hub.log.info('fns.catch-up', { fns: done }); },
            (error: unknown) => { hub.log.warn('fns.catch-up.failed', { error: messageOf(error) }); },
          );
          return Promise.resolve();
        },
        pre: () => { for (const stop of stops.splice(0)) stop(); return Promise.resolve(); },
      },
    },
    linkPlugins: [plugin({ name: 'fns', spec: FNS_LINK_SPEC }).handlers(() => ({
      searchFns: async ({ data, link }) => {
        const { run, ...query } = data;
        return services.search.search(query, await linkAsker(hub, link.system, run));
      },
      fnExamples: async ({ data, link }) => services.examples.page(data, await linkAsker(hub, link.system, undefined)),
      // a system's own fn only: the examples it adds while running live with the declared ones, searchable alike
      examples: ({ data, link }) => services.examples.patch(link.system, data),
    }))],
  };
};
