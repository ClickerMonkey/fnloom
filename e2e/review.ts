/**
 * Going live as an admin does from the review page (build 7): a newly paired system stays `installed`, offering
 * nothing, until an admin reviews it and goes live by the contract hash reviewed; a contract or runtime change after
 * that waits as a pending review until it is approved.
 */
import type { SystemName, SystemReview } from '@harness/core';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';

/** Go live with a system at the contract it has now, keeping nothing off. */
export async function goLive(me: SignedIn, system: SystemName): Promise<SystemReview> {
  const review = await me.hub.call('systemReview', { system });
  await me.hub.call('goLive', { system, hash: review.manifest.hash, off: [] });
  return review;
}

/** Go live with every connected system still installed: what an admin does once after the stack first pairs them. */
export async function goLiveAll(me: SignedIn): Promise<SystemName[]> {
  const live: SystemName[] = [];
  for (const system of await me.hub.call('systems', {})) {
    if (system.status !== 'connected' || system.stage !== 'installed') { continue; }
    await goLive(me, system.name);
    live.push(system.name);
  }
  return live;
}

/** Wait for a system's pending review (a new contract or runtime additions) and approve it as it stands. */
export async function approvePending(me: SignedIn, system: SystemName, timeout = 60_000): Promise<SystemReview> {
  const review = await waitFor(`${system}'s pending review`, async () => {
    const got = await me.hub.call('systemReview', { system });
    return got.pending === undefined ? undefined : got;
  }, { timeout, every: 500 });
  const pending = review.pending;
  if (pending !== undefined) { await me.hub.call('approveReview', { system, hash: pending.hash, off: [] }); }
  return review;
}
