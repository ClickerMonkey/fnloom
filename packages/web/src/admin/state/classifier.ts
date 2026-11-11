/**
 * The auto mode classifier (an admin setting for the whole hub): the model a chat in `auto` mode asks whether a call
 * that writes or deletes may go ahead, and how many of the chat's last messages it reads. Without a model, every
 * such call waits for the person.
 */
import type { AutoClassifier, AutoClassifierView } from '@harness/core';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';

type ClassifierApi = Pick<AdminApi, 'autoClassifier' | 'setAutoClassifier'>;

/** The auto classifier setting. */
export class ClassifierStore {
  readonly #api: ClassifierApi;
  readonly setting = new Loaded<AutoClassifierView>();
  readonly saving = new Task();

  constructor(api: ClassifierApi) {
    this.#api = api;
  }

  async load(quiet = false): Promise<void> {
    await this.setting.load(() => this.#api.autoClassifier.call({}), "Couldn't load the auto mode classifier.", quiet);
  }

  /** Save the setting; answers what was stored. */
  async save(value: AutoClassifier): Promise<Outcome<AutoClassifierView>> {
    const result = await this.saving.run(() => this.#api.setAutoClassifier.call(value), "Couldn't save the auto mode classifier.");
    if (result.ok) { this.setting.set(result.value); }
    return result;
  }
}
