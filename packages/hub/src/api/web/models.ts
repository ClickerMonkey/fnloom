/**
 * The models slice (hub-platform lane, admins): which model and provider each role uses (transcription, dictation,
 * speech, image description, text in images, the default chat model), through `hub.models` (`models/index.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { modelsSlice } from '@harness/core';
import { notBuilt, type FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The models plugin. Requires the systems plugin, which binds `adminOnly`. */
export function modelsPlugin(systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.models', spec: modelsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof modelsSlice> => ({
      modelRoles: notBuilt('Model roles'),
      setModelRole: notBuilt('Setting model roles'),
      clearModelRole: notBuilt('Clearing model roles'),
    }));
}
