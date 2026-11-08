/**
 * Auto pair secrets (admins): the secrets that let a system's instances re-pair by themselves, listed without any
 * secret, and revoking one. Revoked or expired secrets stay listed so the admin sees what happened.
 */
import type { AutoPairId, AutoPairView, SystemName } from '@harness/core';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';

type AutoPairApi = Pick<AdminApi, 'autoPairs' | 'revokeAutoPair'>;

/** One system's auto pair secrets. */
export class AutoPairStore {
  readonly #api: AutoPairApi;
  #system: SystemName | undefined;
  readonly secrets = new Loaded<readonly AutoPairView[]>();
  readonly revoking = new Task();

  constructor(api: AutoPairApi) {
    this.#api = api;
  }

  async load(system: SystemName, quiet = false): Promise<void> {
    this.#system = system;
    await this.secrets.load(() => this.#api.autoPairs.call({ system }), "Couldn't load the auto pair secrets.", quiet);
  }

  /** Revoke a secret: its instance can no longer re-pair with it. */
  async revoke(id: AutoPairId): Promise<Outcome<boolean>> {
    const result = await this.revoking.run(async () => (await this.#api.revokeAutoPair.call({ id })).ok, "Couldn't revoke that secret.");
    if (result.ok && this.#system !== undefined) { await this.load(this.#system, true); }
    return result;
  }
}
