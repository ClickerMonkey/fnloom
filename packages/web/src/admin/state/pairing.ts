/**
 * The pairing page a system's QR code opens (`/pair/:pairing?code=`): the request with what the system said about
 * itself, approving it with an instance name and its config in one step, or refusing it, and then following the
 * system live until it is connected. The code in the URL must match the one the system shows, so a stale or
 * forwarded link can't pair the wrong system.
 */
import type { InstanceName, Json, PairingId, PairingRequest, SystemName, SystemStatus, UserEvent } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import type { ResponseOf } from '../../api/client.ts';
import type { UserEvents } from '../../api/notifications.ts';
import { Loaded, Task, type TaskResult } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';

type PairingApi = Pick<AdminApi, 'pairing' | 'approvePairing'>;

/**
 * Where the page is: `waiting` for the admin, `pairing` while the approval is on its way, `joining` once approved
 * until the system connects, `connected`, or done another way (`refused`, `expired`, or `elsewhere`: answered on
 * another page).
 */
export type PairingPhase = 'loading' | 'waiting' | 'pairing' | 'joining' | 'connected' | 'needs-config' | 'refused' | 'expired' | 'elsewhere';

/** The pairing page's state. */
export class PairingPageStore {
  readonly #api: PairingApi;
  readonly #events: UserEvents;
  readonly #clock: () => number;
  #stop: (() => void) | undefined;
  readonly request = new Loaded<PairingRequest>();
  readonly answer = new Task();
  /** The system the approval made, once approved. */
  readonly system = ref<SystemName | undefined>(undefined);
  /** Its status as the hub says, once approved. */
  readonly status = shallowRef<SystemStatus | undefined>(undefined);
  readonly #answered = ref<'approved' | 'refused' | undefined>(undefined);

  readonly phase = computed<PairingPhase>(() => {
    if (this.#answered.value === 'refused') { return 'refused'; }
    if (this.answer.busy.value) { return 'pairing'; }
    if (this.#answered.value === 'approved') {
      if (this.status.value === 'connected') { return 'connected'; }
      return this.status.value === 'needs-config' ? 'needs-config' : 'joining';
    }
    const request = this.request.value.value;
    if (request === undefined) { return 'loading'; }
    if (request.status === 'expired' || request.expiresAt <= this.#clock()) { return 'expired'; }
    return request.status === 'pending' ? 'waiting' : 'elsewhere';
  });

  constructor(api: PairingApi, events: UserEvents, clock: () => number = Date.now) {
    this.#api = api;
    this.#events = events;
    this.#clock = clock;
  }

  async open(pairing: PairingId): Promise<void> {
    if (this.request.value.value?.id !== pairing) { this.close(); }
    this.#stop ??= this.#events((event) => { this.#onEvent(event); });
    await this.request.load(() => this.#api.pairing.call({ pairing }), "Couldn't load this pairing request. It may have expired or been answered.");
  }

  close(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.request.reset();
    this.system.value = undefined;
    this.status.value = undefined;
    this.#answered.value = undefined;
  }

  /** Whether the code in the link is the one the system shows (a token pairing has none to compare). */
  codeMatches(code: string): boolean {
    const request = this.request.value.value;
    if (request === undefined) { return false; }
    return request.code === undefined || request.code === code.trim();
  }

  /** Pair it as `instance` with `config` (the hub checks the config against the system's type). */
  async approve(instance: InstanceName | undefined, config: Json | undefined): Promise<TaskResult<ResponseOf<'approvePairing'>>> {
    const request = this.request.value.value;
    if (request === undefined) { return { ok: false, problem: 'No pairing request is open.' }; }
    const result = await this.answer.run(() => this.#api.approvePairing.call({
      pairing: request.id, approve: true, ...(instance === undefined ? {} : { instance }), ...(config === undefined ? {} : { config }),
    }), "Couldn't pair it.");
    if (result.ok) {
      this.#answered.value = 'approved';
      this.system.value = result.value.system ?? request.name;
      this.status.value ??= 'pairing';
    }
    return result;
  }

  /** Refuse it: the system is told no. */
  async refuse(): Promise<boolean> {
    const request = this.request.value.value;
    if (request === undefined) { return false; }
    const result = await this.answer.run(() => this.#api.approvePairing.call({ pairing: request.id, approve: false }), "Couldn't refuse it.");
    if (result.ok) { this.#answered.value = 'refused'; }
    return result.ok;
  }

  #onEvent(event: UserEvent): void {
    const request = this.request.value.value;
    if (event.type === 'pairing' && request !== undefined && event.pairing.id === request.id) { this.request.set(event.pairing); return; }
    const system = this.system.value ?? request?.name;
    if (event.type === 'system' && event.system === system) { this.status.value = event.status; }
  }
}
