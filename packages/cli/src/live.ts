/**
 * Putting premade systems live. A newly paired system waits for an admin to review it and go live (Admin › Systems ›
 * Review and go live). The premade systems ship with the harness, and an admin starting the harness (`harness start`)
 * or installing one by name (`harness system install database`) has just asked for that system, so both put it live
 * for them, the way the admin would with nothing switched off. Systems from anywhere else still wait for review.
 */
import type { SystemName } from '@harness/core';
import type { HubClient } from './hub-client.ts';

/** The two hub calls going live takes. */
export interface LiveApi {
  /** A system's stage and the hash of the contract it would go live with; refused (404) before it pairs. */
  review(system: SystemName): Promise<{ stage: 'installed' | 'live'; hash: string }>;
  goLive(system: SystemName, hash: string): Promise<void>;
}

/** The hub's web API as a `LiveApi`. */
export function liveApi(api: HubClient): LiveApi {
  return {
    review: async (system) => { const review = await api.call('systemReview', { system }); return { stage: review.stage, hash: review.manifest.hash }; },
    goLive: async (system, hash) => { await api.call('goLive', { system, hash, off: [] }); },
  };
}

/** How `goLive` went: put live now, live already, or not paired yet (try again). */
export type GoLiveOutcome = 'live' | 'already' | 'not-paired';

/** Put an installed system live with nothing switched off; `already` when it is live, `not-paired` before it pairs. */
export async function goLiveIfInstalled(api: LiveApi, system: SystemName): Promise<GoLiveOutcome> {
  let review;
  try {
    review = await api.review(system);
  } catch (error) {
    if (statusOf(error) === 404) { return 'not-paired'; }
    throw error;
  }
  if (review.stage === 'live') { return 'already'; }
  try {
    await api.goLive(system, review.hash);
  } catch (error) {
    // went live in between (another admin, or a second command)
    if (statusOf(error) === 409 && (await api.review(system)).stage === 'live') { return 'already'; }
    throw error;
  }
  return 'live';
}

/** Put each of `systems` live as it pairs, trying for up to `wait` ms; returns the ones that never paired. */
export async function goLiveWhenPaired(api: LiveApi, systems: readonly SystemName[], wait: number, pause = 1_000): Promise<SystemName[]> {
  const deadline = Date.now() + wait;
  let waiting = [...systems];
  for (;;) {
    const next: SystemName[] = [];
    for (const system of waiting) {
      if (await goLiveIfInstalled(api, system) === 'not-paired') { next.push(system); }
    }
    waiting = next;
    if (waiting.length === 0 || Date.now() >= deadline) { return waiting; }
    await new Promise((done) => setTimeout(done, pause));
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) { return undefined; }
  return typeof error.status === 'number' ? error.status : undefined;
}
