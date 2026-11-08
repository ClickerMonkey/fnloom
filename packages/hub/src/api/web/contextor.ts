/**
 * The contextor slice (contextor lane): each model's resolved limits and where they came from, an admin's limits for
 * a model, and a dry run of what a session's contextor would put in a prompt, through `hub.contextor`
 * (`contextor/index.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { contextorSlice } from '@harness/core';
import { notBuilt, type FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The contextor plugin. Requires the systems plugin, which binds `adminOnly`. */
export function contextorPlugin(systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.contextor', spec: contextorSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof contextorSlice> => ({
      modelLimits: notBuilt('Model limits'),
      previewSelection: notBuilt('Selection previews'),
      setModelLimits: notBuilt('Setting model limits'),
    }));
}
