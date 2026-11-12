/**
 * The contextor module's factory: model limits (admin records, provider probes, aeye, defaults), token estimates
 * with calibration, the context graph over the store, fn views, and the prompt planner the agent loop calls. Other
 * modules are read lazily, inside methods, never while the module is built.
 */
import { models as knownModels } from '@aeye/models';
import type { ModuleFactory } from '../boot/index.ts';
import type { Catalog } from '../catalog/index.ts';
import { People } from '../chat/people.ts';
import { ModelResolver } from '../execution/models.ts';
import type { HubSettings } from '../boot/env.ts';
import type { Search } from '../index/index.ts';
import type { Logger } from '@ayepi/log';
import type { ActorId, ManifestSection, ModelInfo, SystemName } from '@harness/core';
import { openScope, type AccessScope } from '../access/index.ts';
import type { InstanceRouter } from '../link/index.ts';
import type { ModelRoles } from '../models/index.ts';
import type { FnsForPrompt } from '../fns/index.ts';
import type { HubStore } from '../store/index.ts';
import { StoreTokenEstimates } from './calibration.ts';
import type { ContextorEnv } from './env.ts';
import { StoreContextGraph } from './graph.ts';
import { LinkDynamicContext, NO_DYNAMIC_CONTEXT } from './dynamic.ts';
import type { ContextorServices, DynamicContext } from './index.ts';
import { defaultProbes, HubModelLimits, type ProbeFactory } from './limits.ts';
import { HubPromptPlanner } from './planner.ts';
import { CatalogFnViews } from './views.ts';

/** What the contextor's services are built from. */
export interface ContextorModuleInput {
  readonly store: HubStore;
  readonly catalog: Pick<Catalog, 'fn' | 'context' | 'entries' | 'signature' | 'typeClosure' | 'type'>;
  readonly search: Pick<Search, 'search'>;
  readonly settings: ContextorEnv;
  /** The default model, for previews of a session whose agent names none. */
  readonly modelSettings: Pick<HubSettings['modelEnv'], 'HARNESS_DEFAULT_MODEL'>;
  /** The chat models the hub AI can call now. */
  readonly models: () => Promise<readonly ModelInfo[]>;
  readonly log: Logger;
  readonly clock: () => number;
  /** How providers are asked what they serve (default: Ollama's native API over `fetch`). */
  readonly probes?: ProbeFactory;
  /** A fleet's connected instances (default: none, so no fn gets an `on` choice). */
  readonly instances?: Pick<InstanceRouter, 'connected'>;
  /** The model roles, for a preview's model when the agent names none (default: no roles, so the default model). */
  readonly roles?: Pick<ModelRoles, 'resolve'>;
  /** Dynamic context's text from its system (default: none fetched, so dynamic items show their summary). */
  readonly dynamic?: DynamicContext;
  /** What a person may see and use (default: everything, for tests and the hub's own work). */
  readonly access?: (actor: ActorId) => Promise<AccessScope>;
  /** Examples by relevance and fns' modes (default: declared examples, no chat fn mode filtering). */
  readonly fns?: FnsForPrompt;
}

/** Build the contextor's services. */
export function createContextor(input: ContextorModuleInput): ContextorServices {
  const { store, catalog, search, settings, log, clock } = input;
  const limits = new HubModelLimits({
    store, settings, models: input.models, registry: knownModels, probes: input.probes ?? defaultProbes(settings.HARNESS_OLLAMA_DEFAULT_CTX), log, clock,
  });
  const tokens = new StoreTokenEstimates({ store, limits, clock });
  const graph = new StoreContextGraph({ store, catalog, clock, halfLife: settings.HARNESS_LINK_HALF_LIFE });
  const facts = input.fns;
  const views = new CatalogFnViews(catalog, undefined, {
    ...(facts?.registry === undefined ? {} : { registry: (names) => facts.registry?.(names) ?? Promise.resolve(new Map()) }),
    ...(facts?.notices === undefined ? {} : { notices: (names) => facts.notices?.(names) ?? Promise.resolve(new Map()) }),
  });
  const resolver = new ModelResolver({
    store, settings: { model: { HARNESS_DEFAULT_MODEL: input.modelSettings.HARNESS_DEFAULT_MODEL } }, roles: input.roles ?? { resolve: () => Promise.resolve(undefined) },
  });
  const instances = input.instances ?? { connected: () => [] };
  const dynamic = input.dynamic ?? NO_DYNAMIC_CONTEXT;
  const access = input.access ?? ((actor: ActorId) => Promise.resolve(openScope(actor)));
  const planner = new HubPromptPlanner({
    store, catalog, search, views, graph, instances, dynamic, access, settings, log, clock, limits, tokens, models: input.models, resolver, ...(input.fns === undefined ? {} : { fns: input.fns }),
  });
  return { planner, limits, tokens, graph, views, dynamic };
}

/** Builds the contextor module over the hub's store, catalog, index and the hub AI's model list. */
export const contextorModule: ModuleFactory<'contextor'> = ({ hub }) => ({
  services: createContextor({
    store: hub.store,
    catalog: {
      fn: (name) => hub.catalog.fn(name), context: (name) => hub.catalog.context(name), signature: (fn) => hub.catalog.signature(fn),
      entries: <S extends ManifestSection>(section: S, filter?: { system?: SystemName }) => hub.catalog.entries(section, filter),
      typeClosure: (names) => hub.catalog.typeClosure(names), type: (name) => hub.catalog.type(name),
    },
    search: { search: (query) => hub.index.search.search(query) },
    settings: hub.settings.contextorEnv,
    modelSettings: hub.settings.modelEnv,
    models: () => hub.execution.llm.models(),
    log: hub.log,
    clock: () => hub.clock(),
    instances: { connected: (system) => hub.link.instances.connected(system) },
    fns: {
      examples: (fn, text) => hub.fns.examples.forPrompt(fn, text, fn.decl.promptExamples ?? hub.settings.fnsEnv.HARNESS_FN_PROMPT_EXAMPLES),
      modes: (names) => hub.fns.facts.modes(names),
      registry: (names) => hub.fns.facts.registry(names),
      notices: (names) => hub.fns.facts.notices(names),
    },
    roles: { resolve: (role) => hub.models.roles.resolve(role) },
    dynamic: new LinkDynamicContext({
      write: (system, body, timeout) => {
        const connection = hub.link.connections.connection(system);
        return connection?.peer.call('context', body, { signal: AbortSignal.any([connection.signal, AbortSignal.timeout(timeout)]) });
      },
      person: (actor) => new People({ store: hub.store, clock: () => hub.clock(), catalog: hub.catalog }).info(actor),
      settings: hub.settings.contextorEnv, log: hub.log, clock: () => hub.clock(),
    }),
  }),
});
