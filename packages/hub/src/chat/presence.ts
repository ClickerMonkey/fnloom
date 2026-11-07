/** Presence: who is looking at which session, kept in memory (it only matters while people are here). */
import { compositeKey, type ActorId, type Presence, type SessionId } from '@harness/core';
import type { ChatDeps } from './deps.ts';
import type { PresenceTracker } from './index.ts';

/** Presence in memory, published on the bus as it changes. */
export class MemoryPresence implements PresenceTracker {
  readonly #seen = new Map<string, Presence>();

  readonly #deps: Pick<ChatDeps, 'clock' | 'bus' | 'settings'>;

  constructor(deps: Pick<ChatDeps, 'clock' | 'bus' | 'settings'>) {
    this.#deps = deps;
  }

  report(presence: Omit<Presence, 'lastActiveAt'>): Presence {
    const now = this.#deps.clock();
    this.#prune(now);
    const full: Presence = { ...presence, lastActiveAt: now };
    this.#seen.set(compositeKey(presence.session, presence.user), full);
    this.#deps.bus.publish('presence', { presence: full });
    return full;
  }

  active(session: SessionId): boolean {
    return this.#focused((p) => p.session === session);
  }

  looking(user: ActorId, session?: SessionId): boolean {
    return this.#focused((p) => p.user === user && (session === undefined || p.session === session));
  }

  #focused(match: (presence: Presence) => boolean): boolean {
    const since = this.#deps.clock() - this.#deps.settings.queue.HARNESS_ACTIVE_WINDOW;
    for (const presence of this.#seen.values()) {
      if (presence.focused && presence.lastActiveAt >= since && match(presence)) { return true; }
    }
    return false;
  }

  /** Forget presence older than the active window, so the map stays as small as the people here. */
  #prune(now: number): void {
    const since = now - this.#deps.settings.queue.HARNESS_ACTIVE_WINDOW;
    for (const [key, presence] of this.#seen) {
      if (presence.lastActiveAt < since) { this.#seen.delete(key); }
    }
  }
}
