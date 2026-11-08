/**
 * The contextor slice: each model's resolved limits and where each came from, an admin's limits for a model (the
 * admin operation the hub's `set_model_limits` fn runs too), and a dry run of what a session's contextor would put in
 * the prompt for a message, through `hub.contextor` (`contextor/index.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { contextorSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { limitsFor } from '../../contextor/limits.ts';
import type { AdminOperations } from '../admin-ops.ts';
import { visibleSession, type FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The contextor plugin. Requires the systems plugin, which binds `adminOnly`. */
export function contextorPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, ops: AdminOperations) {
  return plugin({ name: 'web.contextor', spec: contextorSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof contextorSlice> => ({
      modelLimits: ({ data }) => limitsFor(hub.contextor.limits, data.model),
      previewSelection: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return hub.contextor.planner.preview(data.session, data.text, user.id);
      },
      setModelLimits: ({ data, user }) => ops.set_model_limits(data, user.id),
    }));
}
