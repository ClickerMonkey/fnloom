/**
 * The models module's factory: model roles over the hub store and the model gateway over the execution module's
 * gateway and the content store, plus the `model` link endpoint systems forward non-chat calls to. Other modules are
 * read when a method runs, never while building.
 */
import { spec } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, type ModelForwardResult } from '@harness/core';
import type { ModuleFactory } from '../boot/index.ts';
import { HubModelGateway } from './gateway.ts';
import { StoreModelRoles } from './roles.ts';

/** The slice of the hub link the models module serves: the same endpoint object, so its types are the spec's. */
export const MODELS_LINK_SPEC = spec({ endpoints: { model: hubLinkSpec.endpoints.model } });

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
    },
    content: { put: (bytes, mime) => hub.api.content.put(bytes, mime), read: (ref, offset, length) => hub.api.content.read(ref, offset, length) },
  });
  return {
    services: { roles, gateway },
    linkPlugins: [plugin({ name: 'models', spec: MODELS_LINK_SPEC }).handlers(() => ({
      // a system's call is paid by its own run; the gateway refuses a run that isn't the system's
      model: ({ data, link, signal }): Promise<ModelForwardResult> => gateway.forward(data, { system: link.system, ...(data.run === undefined ? {} : { run: data.run }) }, signal),
    }))],
  };
};
