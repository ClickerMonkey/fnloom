/**
 * The models module's factory: model roles over the hub store, the model gateway over the execution module's gateway
 * and the content store, the decider (the hub's own decision calls), and the `model` link endpoint systems forward
 * non-chat calls to. Other modules are read when a method runs, never while building.
 */
import { spec } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, type HubModelInfo, type ModelForwardResult, type ModelRole, type ModelRoleView } from '@harness/core';
import type { EngineModel } from '../execution/ports.ts';
import type { ModuleFactory } from '../boot/index.ts';
import { HubDecider } from './decide.ts';
import { HubModelGateway } from './gateway.ts';
import { StoreModelRoles } from './roles.ts';

/** The slice of the hub link the models module serves: the same endpoint object, so its types are the spec's. */
export const MODELS_LINK_SPEC = spec({ endpoints: { model: hubLinkSpec.endpoints.model, models: hubLinkSpec.endpoints.models } });

/**
 * The models a system's aeye picks from (`models` on the hub link), each with the hub roles it fills now. The hub still
 * checks access, rates and budgets on every call, so a listed model is one the system may ask for, not one it is owed.
 */
export function linkModels(models: readonly EngineModel[], roles: readonly ModelRoleView[]): HubModelInfo[] {
  const filled = new Map<string, ModelRole[]>();
  for (const view of roles) {
    const resolved = view.resolved;
    if (resolved === undefined || !('model' in resolved)) continue;
    const key = `${resolved.provider}/${resolved.model}`;
    filled.set(key, [...(filled.get(key) ?? []), view.role]);
  }
  return models.map(({ tier, maxOutputTokens, ...info }) => ({
    ...info, tier: tier ?? 'efficient', ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), roles: filled.get(`${info.provider}/${info.id}`) ?? [],
  }));
}

/** Builds the models module. */
export const modelsModule: ModuleFactory<'models'> = ({ hub }) => {
  const roles = new StoreModelRoles({
    store: hub.store, bus: hub.bus, clock: () => hub.clock(), log: hub.log, defaults: hub.settings.modelEnv,
    models: () => hub.execution.llm.models(),
  });
  const gateway = new HubModelGateway({
    store: hub.store, log: hub.log, roles,
    llm: {
      embed: (input, site, signal) => hub.execution.llm.embed(input, site, signal),
      image: (input, site, signal) => hub.execution.llm.image(input, site, signal),
      transcribe: (input, site, signal) => hub.execution.llm.transcribe(input, site, signal),
      speech: (input, site, signal) => hub.execution.llm.speech(input, site, signal),
      decide: (input, site, signal) => hub.execution.llm.decide(input, site, signal),
    },
    content: { put: (bytes, mime) => hub.api.content.put(bytes, mime), read: (ref, offset, length) => hub.api.content.read(ref, offset, length) },
  });
  const decider = new HubDecider({
    roles,
    llm: { decide: (input, site, signal) => hub.execution.llm.decide(input, site, signal), models: () => hub.execution.llm.models() },
  });
  return {
    services: { roles, gateway, decider },
    linkPlugins: [plugin({ name: 'models', spec: MODELS_LINK_SPEC }).handlers(() => ({
      // a system's call is paid by its own run; the gateway refuses a run that isn't the system's
      model: ({ data, link, signal }): Promise<ModelForwardResult> => gateway.forward(data, { system: link.system, instance: link.instance, ...(data.run === undefined ? {} : { run: data.run }) }, signal),
      models: async () => linkModels(await hub.execution.llm.models(), await roles.list()),
    }))],
  };
};
