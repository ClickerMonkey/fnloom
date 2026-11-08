/**
 * The metrics slice (hub-platform lane, admins): every model call of every modality, and fn metrics rolled up per
 * day, through `hub.metrics` (`metrics/index.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { metricsSlice } from '@harness/core';
import { notBuilt, type FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The metrics plugin. Requires the systems plugin, which binds `adminOnly`. */
export function metricsPlugin(systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.metrics', spec: metricsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof metricsSlice> => ({
      modelCalls: notBuilt('Model calls'),
      modelCall: notBuilt('Model calls'),
      fnMetrics: notBuilt('Fn metrics'),
      fnMetricsDays: notBuilt('Fn metrics'),
    }));
}
