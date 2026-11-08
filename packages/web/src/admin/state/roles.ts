/**
 * Model roles and model limits on the models page: which model (and provider) each of the hub's own jobs uses
 * (transcription, dictation, speech, descriptions, text in images, the chat default), and each model's limits with
 * where each came from. A save answers with the role or model as the hub resolves it now, which replaces the row.
 */
import type { ModelLimits, ModelLimitsView, ModelRole, ModelRoleView, RoleChoice } from '@harness/core';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';

type RolesApi = Pick<AdminApi, 'modelRoles' | 'setModelRole' | 'clearModelRole' | 'modelLimits' | 'setModelLimits'>;

/** Replace the row with the same key, or add it. */
function upsert<T>(rows: readonly T[] | undefined, row: T, same: (a: T, b: T) => boolean): T[] {
  const list = rows ?? [];
  return list.some((r) => same(r, row)) ? list.map((r) => (same(r, row) ? row : r)) : [...list, row];
}

/** The roles and limits tabs' state. */
export class ModelRolesStore {
  readonly #api: RolesApi;
  readonly roles = new Loaded<readonly ModelRoleView[]>();
  readonly limits = new Loaded<readonly ModelLimitsView[]>();
  readonly save = new Task();

  constructor(api: RolesApi) {
    this.#api = api;
  }

  async loadRoles(quiet = false): Promise<void> {
    await this.roles.load(() => this.#api.modelRoles.call({}), "Couldn't load the model roles.", quiet);
  }

  async loadLimits(quiet = false): Promise<void> {
    await this.limits.load(() => this.#api.modelLimits.call({}), "Couldn't load the model limits.", quiet);
  }

  /** The role as listed now. */
  role(role: ModelRole): ModelRoleView | undefined {
    return this.roles.value.value?.find((r) => r.role === role);
  }

  /** Set a role. */
  async setRole(choice: RoleChoice): Promise<Outcome<ModelRoleView>> {
    const result = await this.save.run(() => this.#api.setModelRole.call(choice), "Couldn't save that role.");
    if (result.ok) { this.roles.set(upsert(this.roles.value.value, result.value, (a, b) => a.role === b.role)); }
    return result;
  }

  /** Clear a role: it goes back to the hub's default (or off). */
  async clearRole(role: ModelRole): Promise<Outcome<ModelRoleView>> {
    const result = await this.save.run(() => this.#api.clearModelRole.call({ role }), "Couldn't clear that role.");
    if (result.ok) { this.roles.set(upsert(this.roles.value.value, result.value, (a, b) => a.role === b.role)); }
    return result;
  }

  /** Set a model's limits; every field left out falls to the next source (all left out clears them). */
  async setLimits(model: string, limits: ModelLimits): Promise<Outcome<ModelLimitsView>> {
    const result = await this.save.run(() => this.#api.setModelLimits.call({ model, limits }), `Couldn't save the limits of ${model}.`);
    if (result.ok) { this.limits.set(upsert(this.limits.value.value, result.value, (a, b) => a.model === b.model)); }
    return result;
  }
}
