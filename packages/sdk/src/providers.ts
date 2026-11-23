/**
 * Model providers a system brings: `provider()` declares one in the contract (the models it serves, their prices and
 * abilities), and the system's implementation gives the aeye `Provider` that serves them. The hub registers each as
 * a remote provider named `<system>/<name>`, so a chat or embedding call to one of its models runs here, over the
 * link, and is recorded and priced like any other model call.
 *
 * A **runtime** provider (`provider({ description, models: 'runtime' })`) has no models in the contract: the running
 * system sets them (`running.models(contract.providers.<name>, models)`) from what an admin chose, and each fleet
 * instance sends its own, named after the instance (`ollama/desk`), so calls to it go to that instance. A contract has
 * at most one.
 */
import type { Provider } from '@aeye/ai';
import { ProviderModelDecl, type InstanceName, type SystemProviderDecl } from '@harness/core';
import type { Own, SystemCtx } from './ctx.ts';

/** A provider as the contract declares it. */
export interface ProviderDef {
  readonly description: string;
  /** Its models; none for a runtime provider, whose models the running system sets. */
  readonly models: readonly ProviderModelDecl[];
  /** Its models are set while the system runs (`RunningSystem.models`), one provider per instance. */
  readonly runtime: boolean;
}

/** What `provider()` takes. */
export interface ProviderInput {
  description: string;
  /**
   * Every model it serves; a call for any other model is refused. `'runtime'`: the running system sets them
   * (`running.models`), from what an admin chose, and the provider is one per instance, named after it.
   */
  models: ProviderModelDecl[] | 'runtime';
}

/**
 * Declare a provider: `provider({ description: 'Models on our GPU box', models: [{ id: 'small', capabilities: ['chat'],
 * contextWindow: 8192, pricing: { input: 0, output: 0 }, caching: false }] })`. Each model is checked now, so a wrong
 * one fails as the contract is built.
 */
export function provider(def: ProviderInput): ProviderDef {
  if (def.models === 'runtime') { return { description: def.description, models: [], runtime: true }; }
  return { description: def.description, models: checkedModels(def.models), runtime: false };
}

/** Models checked as a provider declares them: each one's shape, and no id twice. */
export function checkedModels(input: readonly ProviderModelDecl[]): ProviderModelDecl[] {
  const models = ProviderModelDecl.array().parse(input);
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) { throw new Error(`provider: model ${model.id} is declared twice`); }
    ids.add(model.id);
  }
  return models;
}

/**
 * The implementation of a declared provider: make the aeye `Provider` for the current config. It is made again when
 * the config changes, and kept otherwise.
 */
export type ProviderImpl<Cfg = unknown, O extends Own = Own> = (ctx: SystemCtx<Cfg, O>) => Provider;

/** A provider declaration on the wire. */
export function providerDecl(name: SystemProviderDecl['name'], def: ProviderDef): SystemProviderDecl {
  return { name, description: def.description, models: def.models.map((model) => ({ ...model, capabilities: [...model.capabilities] })) };
}

/** A runtime provider's declaration on the wire for one instance: named after it, owned by it, with its models now. */
export function runtimeProviderDecl(instance: InstanceName, def: ProviderDef, models: readonly ProviderModelDecl[]): SystemProviderDecl {
  return { name: instance, description: def.description, models: models.map((model) => ({ ...model, capabilities: [...model.capabilities] })), runtime: true, instance };
}

/** The contract's runtime provider (its local name), if it has one; more than one is refused. */
export function runtimeProviderOf(system: string, defs: Readonly<Record<string, ProviderDef>>): string | undefined {
  const names = Object.entries(defs).filter(([, def]) => def.runtime).map(([name]) => name);
  if (names.length > 1) { throw new Error(`${system} declares more than one runtime provider (${names.join(', ')}): a contract has at most one, named after each instance as it runs.`); }
  return names[0];
}
