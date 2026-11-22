/**
 * The metrics slice (admins): every model call of every modality, and fn metrics rolled up per day, through
 * `hub.metrics` (`metrics/index.ts`). The hub's read fns `hub/model_calls` and `hub/fns_metrics` answer the same reads.
 */
import { plugin } from '@ayepi/plugin';
import { metricsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { HubReads } from '../reads.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** How many days a fn's chart covers when not asked. */
const CHART_DAYS = 30;

/** The metrics plugin. Requires the systems plugin, which binds `adminOnly`. */
export function metricsPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, reads: HubReads) {
  return plugin({ name: 'web.metrics', spec: metricsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof metricsSlice> => ({
      modelCalls: ({ data, user }) => reads.model_calls(data, user),
      modelCall: ({ data }) => reads.modelCall(data.id),
      fnMetrics: ({ data, user }) => reads.fns_metrics(data, user),
      fnMetricsDays: ({ data }) => hub.metrics.fns.days(data.fn, data.days ?? CHART_DAYS),
    }));
}
