/** Policies: every policy in the order the hub weighs them, and saving and removing them. */
import type { Policy, PolicyId } from '@harness/core';
import { computed } from 'vue';
import { Loaded, Task, type TaskResult } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import type { PolicyBody } from '../logic/forms.ts';
import { sortPolicies } from '../logic/policies.ts';

type PoliciesApi = Pick<AdminApi, 'policies' | 'setPolicy' | 'removeRule'>;

/** The policies page's state. */
export class PoliciesStore {
  readonly #api: PoliciesApi;
  readonly list = new Loaded<readonly Policy[]>();
  readonly sorted = computed(() => sortPolicies(this.list.value.value ?? []));
  readonly save = new Task();
  readonly remove = new Task();

  constructor(api: PoliciesApi) {
    this.#api = api;
  }

  async load(quiet = false): Promise<void> {
    await this.list.load(() => this.#api.policies.call({}), "Couldn't load policies.", quiet);
  }

  async savePolicy(body: PolicyBody): Promise<TaskResult<{ id: string }>> {
    const result = await this.save.run(() => this.#api.setPolicy.call(body), "Couldn't save the policy.");
    if (result.ok) { void this.load(true); }
    return result;
  }

  async removePolicy(id: PolicyId): Promise<boolean> {
    const result = await this.remove.run(() => this.#api.removeRule.call({ kind: 'policy', id }), "Couldn't remove the policy.");
    if (result.ok) { this.list.set((this.list.value.value ?? []).filter((p) => p.id !== id)); }
    return result.ok;
  }
}
