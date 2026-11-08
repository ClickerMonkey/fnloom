/**
 * The metrics module's factory. Until the hub-platform lane builds it, every service answers `NOT_BUILT`.
 */
import { notBuiltService } from '../boot/not-built.ts';
import type { ModuleFactory } from '../boot/index.ts';
import type { FnMetricsService, ModelCallLog } from './index.ts';

/** Builds the metrics module. */
export const metricsModule: ModuleFactory<'metrics'> = () => ({
  services: {
    calls: notBuiltService<ModelCallLog>('metrics.calls'),
    fns: notBuiltService<FnMetricsService>('metrics.fns'),
  },
});
