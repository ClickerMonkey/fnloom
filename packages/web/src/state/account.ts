/**
 * The signed-in person's own account, for Settings › Account: their role, how they sign in (the providers they used,
 * a password) and the groups they are in, as the hub's People list shows them (`account`).
 */
import type { PersonView } from '@harness/core';
import type { AuthApi } from '../api/auth.ts';
import { Loaded } from './loaded.ts';

/** Your own account. */
export class AccountStore {
  readonly #api: Pick<AuthApi, 'account'>;
  readonly view = new Loaded<PersonView>();

  constructor(api: Pick<AuthApi, 'account'>) {
    this.#api = api;
  }

  /** Fetch it (quietly when it is shown already). */
  load(): Promise<void> {
    return this.view.load(() => this.#api.account.call(), 'Couldn’t load your account.', this.view.value.value !== undefined);
  }
}
