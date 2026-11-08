/**
 * The systems list and pairing: every system the hub knows (live status from the user channel), pairing requests
 * waiting for the admin (new ones arrive live), approving or rejecting them, one-time pairing tokens, and installing
 * a system for the hub to run.
 */
import type { AutoPairChoice, InstallSource, Json, ListQuery, PairingId, PairingRequest, SystemName, SystemView, UserEvent } from '@harness/core';
import { computed, shallowRef } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import type { ResponseOf } from '../../api/client.ts';
import type { AdminApi } from '../api.ts';
import { autoPairPart } from '../logic/forms.ts';
import { sortSystems } from '../logic/systems.ts';

type SystemsApi = Pick<AdminApi, 'systems' | 'pairings' | 'approvePairing' | 'createPairingToken' | 'installSystem'>;

/** A token made for pairing, as the hub answers it. */
export type PairingToken = ResponseOf<'createPairingToken'>;

/** The systems page's state. */
export class SystemsStore {
  readonly #api: SystemsApi;
  readonly #events: UserEvents;
  #stop: (() => void) | undefined;

  readonly list = new Loaded<readonly SystemView[]>();
  readonly pairings = new Loaded<readonly PairingRequest[]>();
  /** The list's query (words, filters, sort), which the hub applies. */
  readonly query = shallowRef<ListQuery>({});
  /** Systems in the hub's order when a sort is chosen, else needing the admin first. */
  readonly sorted = computed(() => {
    const list = this.list.value.value ?? [];
    return this.query.value.sort === undefined ? sortSystems(list) : list;
  });
  /** How many pairing requests wait for an answer. */
  readonly pending = computed(() => (this.pairings.value.value ?? []).filter((p) => p.status === 'pending').length);
  /** The pairing requests being answered now. */
  readonly answering = shallowRef<ReadonlySet<PairingId>>(new Set());
  readonly answer = new Task();
  readonly token = new Task();
  readonly install = new Task();

  constructor(api: SystemsApi, events: UserEvents) {
    this.#api = api;
    this.#events = events;
  }

  /** Follow live status and pairing changes. */
  start(): void {
    this.#stop ??= this.#events((event) => { this.#onEvent(event); });
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  /** Fetch the systems and the pairing requests waiting. */
  async load(quiet = false): Promise<void> {
    await Promise.all([
      this.#loadList(quiet),
      this.pairings.load(() => this.#api.pairings.call({ status: 'pending' }), "Couldn't load pairing requests.", quiet),
    ]);
  }

  /** Search the systems: fetch them again for `query` (nothing when it is the same). */
  async search(query: ListQuery): Promise<void> {
    if (JSON.stringify(query) === JSON.stringify(this.query.value)) { return; }
    this.query.value = query;
    await this.#loadList(false);
  }

  async #loadList(quiet: boolean): Promise<void> {
    const query = this.query.value;
    await this.list.load(() => this.#api.systems.call(Object.keys(query).length === 0 ? {} : { query }), "Couldn't load systems.", quiet);
  }

  /** Approve or reject a pairing; approving may hand it an auto pair secret. Approving adds the system to the list. */
  async answerPairing(pairing: PairingId, approve: boolean, autoPair?: AutoPairChoice): Promise<Outcome<{ system?: SystemName | undefined }>> {
    this.answering.value = new Set([...this.answering.value, pairing]);
    const result = await this.answer.run(() => this.#api.approvePairing.call({ pairing, approve, ...(approve ? autoPairPart(autoPair) : {}) }), approve ? "Couldn't approve the pairing." : "Couldn't reject the pairing.");
    this.answering.value = new Set([...this.answering.value].filter((id) => id !== pairing));
    if (result.ok) {
      this.pairings.set((this.pairings.value.value ?? []).filter((p) => p.id !== pairing));
      if (approve) { void this.#loadList(true); }
    }
    return result;
  }

  /** Make a one-time pairing token, for a name or for any; with `autoPair`, the system it pairs gets a secret too. */
  async createToken(name: SystemName | undefined, expiresIn: number, autoPair?: AutoPairChoice): Promise<Outcome<PairingToken>> {
    return this.token.run(() => this.#api.createPairingToken.call({ expiresIn, ...(name === undefined ? {} : { name }), ...autoPairPart(autoPair) }), "Couldn't make a pairing token.");
  }

  /** Install a system for the hub to keep and run. */
  async installSystem(source: InstallSource, autoStart: boolean, config?: Json): Promise<Outcome<{ name: SystemName }>> {
    const result = await this.install.run(
      () => this.#api.installSystem.call({ source, autoStart, ...(config === undefined ? {} : { config }) }),
      "Couldn't install the system.",
    );
    if (result.ok) { void this.load(true); }
    return result;
  }

  #onEvent(event: UserEvent): void {
    if (event.type === 'system') {
      const list = this.list.value.value;
      if (list === undefined) { return; }
      if (!list.some((s) => s.name === event.system)) { void this.load(true); return; }
      this.list.set(list.map((s) => (s.name === event.system ? { ...s, status: event.status } : s)));
    } else if (event.type === 'pairing') {
      const pairing = event.pairing;
      const others = (this.pairings.value.value ?? []).filter((p) => p.id !== pairing.id);
      this.pairings.set(pairing.status === 'pending' ? [pairing, ...others] : others);
    }
  }
}
