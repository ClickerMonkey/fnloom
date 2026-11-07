/**
 * Whether the hub is reachable, for the "Reconnecting…" banner. A drop shorter than `OFFLINE_AFTER` (a socket still
 * connecting, a blip) shows nothing; a longer one shows offline, then a short "Back online" before the banner goes.
 * Stores that hold hub data listen with `onReconnect` to fetch again, since events sent while offline are lost.
 */
import { ref } from 'vue';
import type { Connection } from '../api/client.ts';

/** How long the hub must be unreachable before the banner says so, in ms. */
export const OFFLINE_AFTER = 1_500;
/** How long "Back online" shows, in ms. */
export const BACK_ONLINE_FOR = 2_500;

/** What the banner shows. */
export type ConnectionState = 'online' | 'offline' | 'back';

/** The hub connection's state. */
export class ConnectionStore {
  readonly state = ref<ConnectionState>('online');
  readonly #listeners = new Set<() => void>();
  readonly #stop: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #down = false;

  constructor(connection: Connection) {
    this.#stop = connection.subscribe((status) => { this.#update(status); });
    if (connection.status === 'offline') { this.#update('offline'); }
  }

  /** Call `listener` each time the connection comes back after a drop. Returns the function that stops. */
  onReconnect(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  dispose(): void {
    this.#stop();
    clearTimeout(this.#timer);
  }

  #update(status: 'online' | 'offline'): void {
    if (status === 'offline') {
      if (this.#down) { return; }
      this.#down = true;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => { this.state.value = 'offline'; }, OFFLINE_AFTER);
      return;
    }
    if (!this.#down) { return; }
    this.#down = false;
    clearTimeout(this.#timer);
    for (const listener of this.#listeners) { listener(); }
    if (this.state.value !== 'offline') { return; }
    this.state.value = 'back';
    this.#timer = setTimeout(() => { this.state.value = 'online'; }, BACK_ONLINE_FOR);
  }
}
