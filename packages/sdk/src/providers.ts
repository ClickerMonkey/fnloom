/**
 * Model providers a system brings: `provider()` declares one in the contract (the models it serves, their prices and
 * abilities), and the system's implementation gives the aeye `Provider` that serves them. The hub registers each as
 * a remote provider named `<system>/<name>`, so a chat or embedding call to one of its models runs here, over the
 * link, and is recorded and priced like any other model call.
 */
import type { Provider } from '@aeye/ai';
import { ProviderModelDecl, type SystemProviderDecl } from '@harness/core';
import type { SystemCtx } from './ctx.ts';

/** A provider as the contract declares it. */
export interface ProviderDef {
  readonly description: string;
  readonly models: readonly ProviderModelDecl[];
}

/** What `provider()` takes. */
export interface ProviderInput {
  description: string;
  /** Every model it serves. A call for any other model is refused. */
  models: ProviderModelDecl[];
}

/**
 * Declare a provider: `provider({ description: 'Models on our GPU box', models: [{ id: 'small', capabilities: ['chat'],
 * contextWindow: 8192, pricing: { input: 0, output: 0 }, caching: false }] })`. Each model is checked now, so a wrong
 * one fails as the contract is built.
 */
export function provider(def: ProviderInput): ProviderDef {
  const models = ProviderModelDecl.array().parse(def.models);
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) { throw new Error(`provider: model ${model.id} is declared twice`); }
    ids.add(model.id);
  }
  return { description: def.description, models };
}

/**
 * The implementation of a declared provider: make the aeye `Provider` for the current config. It is made again when
 * the config changes, and kept otherwise.
 */
export type ProviderImpl<Cfg = unknown> = (ctx: SystemCtx<Cfg>) => Provider;

/** A provider declaration on the wire. */
export function providerDecl(name: SystemProviderDecl['name'], def: ProviderDef): SystemProviderDecl {
  return { name, description: def.description, models: def.models.map((model) => ({ ...model, capabilities: [...model.capabilities] })) };
}
