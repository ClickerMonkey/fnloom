/**
 * Token estimates that learn: an estimator per model at its resolved limits and calibration ratio, and the ratio
 * moved toward each call's measured input tokens over the estimate (`modelCalibration`).
 */
import type { HubStore } from '../store/index.ts';
import type { ModelLimitsService, TokenEstimates, TokenEstimator } from './index.ts';
import { CALIBRATION, Estimator, nextRatio } from './tokens.ts';

/** What the estimates read and write. */
export interface StoreTokenEstimatesDeps {
  readonly store: HubStore;
  readonly limits: Pick<ModelLimitsService, 'resolve'>;
  readonly clock: () => number;
}

/** Estimates over the store's calibration records. */
export class StoreTokenEstimates implements TokenEstimates {
  readonly #deps: StoreTokenEstimatesDeps;

  constructor(deps: StoreTokenEstimatesDeps) {
    this.#deps = deps;
  }

  async forModel(model: string): Promise<TokenEstimator> {
    const view = await this.#deps.limits.resolve(model);
    return new Estimator(model, view.limits, view.ratio);
  }

  async observe(model: string, estimated: number, actual: number): Promise<void> {
    const table = this.#deps.store.table('modelCalibration');
    const known = await table.get(model);
    const ratio = nextRatio(known?.ratio ?? CALIBRATION.start, estimated, actual);
    await table.put({ model, ratio, samples: (known?.samples ?? 0) + 1, updatedAt: this.#deps.clock() });
  }
}
