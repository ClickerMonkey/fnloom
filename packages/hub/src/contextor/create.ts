/**
 * The contextor module's factory: model limits (admin records, provider probes, aeye, defaults), token estimates
 * with calibration, the context graph over the store, fn views, and the prompt planner the agent loop calls. Other
 * modules are read lazily, inside methods, never while the module is built.
 */
import { models as knownModels } from '@aeye/models';
import type { ModuleFactory } from '../boot/index.ts';
import type { Catalog } from '../catalog/index.ts';
import { ModelResolver } from '../execution/models.ts';
import type { HubSettings } from '../boot/env.ts';
import type { Search } from '../index/index.ts';
import type { Logger } from '@ayepi/log';
import type { ManifestSection, ModelInfo, SystemName } from '@harness/core';
import type { InstanceRouter } from '../link/index.ts';
import type { ModelRoles } from '../models/index.ts';
import type { HubStore } from '../store/index.ts';
import { StoreTokenEstimates } from './calibration.ts';
import type { ContextorEnv } from './env.ts';
import { StoreContextGraph } from './graph.ts';
import type { ContextorServices } from './index.ts';
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
}

/** Build the contextor's services. */
export function createContextor(input: ContextorModuleInput): ContextorServices {
  const { store, catalog, search, settings, log, clock } = input;
  const limits = new HubModelLimits({
    store, settings, models: input.models, registry: knownModels, probes: input.probes ?? defaultProbes(settings.HARNESS_OLLAMA_DEFAULT_CTX), log, clock,
  });
  const tokens = new StoreTokenEstimates({ store, limits, clock });
  const graph = new StoreContextGraph({ store, catalog, clock, halfLife: settings.HARNESS_LINK_HALF_LIFE });
  const views = new CatalogFnViews(catalog);
  const resolver = new ModelResolver({
    store, settings: { model: { HARNESS_DEFAULT_MODEL: input.modelSettings.HARNESS_DEFAULT_MODEL } }, roles: input.roles ?? { resolve: () => Promise.resolve(undefined) },
  });
  const instances = input.instances ?? { connected: () => [] };
  const planner = new HubPromptPlanner({ store, catalog, search, views, graph, instances, settings, log, clock, limits, tokens, models: input.models, resolver });
  return { planner, limits, tokens, graph, views };
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
    roles: { resolve: (role) => hub.models.roles.resolve(role) },
  }),
});
