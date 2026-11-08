/**
 * The metrics module's factory: the model call log and fn metrics over the hub store. Fn metrics are fed by the
 * execution module as each run settles (`FnMetricsService.settled`), so this module starts nothing of its own.
 */
import type { ModuleFactory } from '../boot/index.ts';
import { StoreModelCallLog } from './calls.ts';
import { StoreFnMetrics } from './fn-metrics.ts';

/** Builds the metrics module. */
export const metricsModule: ModuleFactory<'metrics'> = ({ hub }) => ({
  services: {
    calls: new StoreModelCallLog({ store: hub.store, clock: () => hub.clock(), log: hub.log }),
    fns: new StoreFnMetrics({ store: hub.store, bus: hub.bus, clock: () => hub.clock(), log: hub.log }),
  },
});
