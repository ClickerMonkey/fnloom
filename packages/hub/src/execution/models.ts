/**
 * Which model a call uses, from a `ModelChoice`: a model id as it is, a category as its first model, and automatic
 * selection as aeye's selection weights. Without a choice the hub's default model is used.
 */
import type { ModelChoice } from '@harness/core';
import type { ExecutionBase, ExecutionSettings } from './ports.ts';
import type { HubCallMetadata } from './scope.ts';

/** What the resolver reads: model categories, and the default model. */
export interface ModelResolverDeps extends Pick<ExecutionBase, 'store'> {
  readonly settings: { readonly model: Pick<ExecutionSettings['model'], 'HARNESS_DEFAULT_MODEL'> };
}

/** Turns model choices into aeye metadata. */
export class ModelResolver {
  readonly #deps: ModelResolverDeps;

  constructor(deps: ModelResolverDeps) {
    this.#deps = deps;
  }

  async resolve(choice: ModelChoice | undefined): Promise<HubCallMetadata> {
    const fallback = { model: this.#deps.settings.model.HARNESS_DEFAULT_MODEL };
    if (choice === undefined) return fallback;
    if ('model' in choice) return { model: choice.model };
    if ('auto' in choice) {
      const { cost, speed, accuracy } = choice.auto;
      return { weights: { ...(cost === undefined ? {} : { cost }), ...(speed === undefined ? {} : { speed }), ...(accuracy === undefined ? {} : { accuracy }) } };
    }
    const categories = await this.#deps.store.table('modelCategories').find({ where: { name: choice.category }, limit: 1 });
    const first = categories.items[0]?.models[0];
    return first === undefined ? fallback : { model: first };
  }
}
