/**
 * Providers and models: the configured providers (keys go in, never come back), the models they offer, and the
 * model categories (named, ordered lists of models the agents pick from).
 */
import type { ModelCategory, ModelCategoryId, ProviderId, ProviderInput } from '@harness/core';
import { computed } from 'vue';
import { Loaded, Task, type TaskResult } from '../../state/loaded.ts';
import type { ResponseOf } from '../../api/client.ts';
import type { AdminApi } from '../api.ts';
import type { ModelInfo } from '@harness/core';
import type { CategoryBody } from '../logic/forms.ts';

type ModelsApi = Pick<AdminApi, 'providers' | 'configureProvider' | 'models' | 'modelCategories' | 'setModelCategory' | 'removeRule'>;

/** A configured provider, as the hub lists it. */
export type ProviderRow = ResponseOf<'providers'>[number];

/** The providers and models page's state. */
export class ModelsStore {
  readonly #api: ModelsApi;
  readonly providers = new Loaded<readonly ProviderRow[]>();
  readonly models = new Loaded<readonly ModelInfo[]>();
  readonly categories = new Loaded<readonly ModelCategory[]>();
  readonly save = new Task();
  readonly remove = new Task();
  /** Every model id offered, for the category editor. */
  readonly modelIds = computed(() => (this.models.value.value ?? []).map((m) => m.id).sort());

  constructor(api: ModelsApi) {
    this.#api = api;
  }

  async load(quiet = false): Promise<void> {
    await Promise.all([
      this.providers.load(() => this.#api.providers.call({}), "Couldn't load providers.", quiet),
      this.models.load(() => this.#api.models.call({}), "Couldn't load models.", quiet),
      this.categories.load(() => this.#api.modelCategories.call({}), "Couldn't load model categories.", quiet),
    ]);
  }

  /** Add or replace a provider; answers how many models it offers. */
  async saveProvider(input: ProviderInput): Promise<TaskResult<{ models: number }>> {
    const result = await this.save.run(() => this.#api.configureProvider.call(input), "Couldn't save the provider.");
    if (result.ok) { void this.load(true); }
    return result;
  }

  async saveCategory(body: CategoryBody): Promise<TaskResult<{ id: string }>> {
    const result = await this.save.run(() => this.#api.setModelCategory.call(body), "Couldn't save the category.");
    if (result.ok) { void this.categories.load(() => this.#api.modelCategories.call({}), "Couldn't load model categories.", true); }
    return result;
  }

  async removeCategory(id: ModelCategoryId): Promise<boolean> {
    const result = await this.remove.run(() => this.#api.removeRule.call({ kind: 'category', id }), "Couldn't remove the category.");
    if (result.ok) { this.categories.set((this.categories.value.value ?? []).filter((c) => c.id !== id)); }
    return result.ok;
  }

  async removeProvider(id: ProviderId): Promise<boolean> {
    const result = await this.remove.run(() => this.#api.removeRule.call({ kind: 'provider', id }), "Couldn't remove the provider.");
    if (result.ok) { void this.load(true); }
    return result.ok;
  }
}
