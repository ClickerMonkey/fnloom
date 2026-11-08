/**
 * Which model a call uses, from a `ModelChoice`: a model id as it is, a category as its first model, and automatic
 * selection as aeye's selection weights. Without a choice (or with a category that has no models) the `chat` model
 * role decides (`ModelRoles.resolve('chat')`, served as `provider/model`), and without a role the hub's default model.
 */
import type { ModelChoice } from '@harness/core';
import type { ModelRoles } from '../models/index.ts';
import type { ExecutionBase, ExecutionSettings } from './ports.ts';
import type { HubCallMetadata } from './scope.ts';

/** What the resolver reads: model categories, the `chat` role, and the default model. */
export interface ModelResolverDeps extends Pick<ExecutionBase, 'store'> {
  readonly settings: { readonly model: Pick<ExecutionSettings['model'], 'HARNESS_DEFAULT_MODEL'> };
  readonly roles: Pick<ModelRoles, 'resolve'>;
}

/** Turns model choices into aeye metadata. */
export class ModelResolver {
  readonly #deps: ModelResolverDeps;

  constructor(deps: ModelResolverDeps) {
    this.#deps = deps;
  }

  async resolve(choice: ModelChoice | undefined): Promise<HubCallMetadata> {
    if (choice === undefined) return this.#fallback();
    if ('model' in choice) return { model: choice.model };
    if ('auto' in choice) {
      const { cost, speed, accuracy } = choice.auto;
      return { weights: { ...(cost === undefined ? {} : { cost }), ...(speed === undefined ? {} : { speed }), ...(accuracy === undefined ? {} : { accuracy }) } };
    }
    const categories = await this.#deps.store.table('modelCategories').find({ where: { name: choice.category }, limit: 1 });
    const first = categories.items[0]?.models[0];
    return first === undefined ? this.#fallback() : { model: first };
  }

  /** The `chat` role's model, else the hub's default. */
  async #fallback(): Promise<HubCallMetadata> {
    const chat = await this.#deps.roles.resolve('chat');
    return chat === undefined ? { model: this.#deps.settings.model.HARNESS_DEFAULT_MODEL } : { model: chat.model, provider: chat.provider };
  }
}
