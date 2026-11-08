/**
 * The contextor module's factory. Until the contextor lane builds it, every service answers `NOT_BUILT`.
 */
import { notBuiltService } from '../boot/not-built.ts';
import type { ModuleFactory } from '../boot/index.ts';
import type { ContextGraph, ModelLimitsService, PromptPlanner, TokenEstimates } from './index.ts';

/** Builds the contextor module. */
export const contextorModule: ModuleFactory<'contextor'> = () => ({
  services: {
    planner: notBuiltService<PromptPlanner>('contextor.planner'),
    limits: notBuiltService<ModelLimitsService>('contextor.limits'),
    tokens: notBuiltService<TokenEstimates>('contextor.tokens'),
    graph: notBuiltService<ContextGraph>('contextor.graph'),
  },
});
