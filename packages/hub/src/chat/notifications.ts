/**
 * Notifications: the inbox and web push. Every notification is stored and published (the browser's bell updates
 * live); it is also pushed to the user's subscribed browsers unless they are looking at the place it links to. Beside
 * the replies and finished turns chat itself reports, it turns hub events into notifications: approvals and input a
 * person must give, pairings waiting for an admin, systems that went away or need config, and budgets that say `ask`
 * when they are used up (admins are asked to raise them).
 */
import {
  mintId, type ActorId, type Approval, type Approver, type BudgetRule, type HandlerCall, type Notification, type NotificationLink, type NotificationReason, type Page,
  type PairingRequest, type RunId, type SystemName, type SystemStatus,
} from '@harness/core';
import type { ChatDeps } from './deps.ts';
import { messageOf } from './errors.ts';
import type { ApproverDirectory, NotificationService, PresenceTracker } from './index.ts';
import { readAll } from './support.ts';

/** The most admins (or group members) one event notifies. */
const MAX_AUDIENCE = 200;

/** How many already-notified event ids are remembered, so a repeated event doesn't notify twice. */
const REMEMBERED = 2_000;

/** Notifications per page when a request gives no limit. */
const PAGE = 30;

/** An insertion-ordered set that forgets its oldest entries past a size. */
class RecentSet {
  readonly #items = new Set<string>();
  readonly #size: number;

  constructor(size: number) {
    this.#size = size;
  }

  /** Add an item; false when it was already there. */
  add(item: string): boolean {
    if (this.#items.has(item)) { return false; }
    this.#items.add(item);
    for (const old of this.#items) {
      if (this.#items.size <= this.#size) { break; }
      this.#items.delete(old);
    }
    return true;
  }
}

/** Who answers an approval, as people. */
export class StoreApprovers implements ApproverDirectory {
  readonly #deps: Pick<ChatDeps, 'store'>;

  constructor(deps: Pick<ChatDeps, 'store'>) {
    this.#deps = deps;
  }

  async approvers(approver: Approver, turnUser: ActorId): Promise<ActorId[]> {
    switch (approver.by) {
      case 'turn-user': return [turnUser];
      case 'actor': return [approver.actor];
      case 'group': return (await readAll(this.#deps.store.table('memberships'), { where: { group: approver.group } }, MAX_AUDIENCE)).map((m) => m.user);
      // a judge or the hub decides by itself (the policy engine's deciders), so no person answers
      case 'judge': case 'hub': return [];
    }
  }
}

/** The inbox on the store, pushed through the push service. */
export class StoreNotifications implements NotificationService {
  readonly #deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'push' | 'log'>;
  readonly #presence: PresenceTracker;
  readonly #seen = new RecentSet(REMEMBERED);

  constructor(deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'push' | 'log'>, presence: PresenceTracker) {
    this.#deps = deps;
    this.#presence = presence;
  }

  async notify(input: { user: ActorId; reason: NotificationReason; title: string; body: string; link: NotificationLink }): Promise<Notification> {
    const stored = await this.#deps.store.table('notifications').insert({
      id: mintId('notification', this.#deps.random), ...input, read: false, pushed: false, createdAt: this.#deps.clock(),
    });
    this.#deps.bus.publish('notification', { notification: stored });
    const looking = this.#presence.looking(input.user, 'session' in input.link ? input.link.session : undefined);
    if (looking) { return stored; }
    try {
      const { sent, gone } = await this.#deps.push.send(input.user, stored);
      this.#deps.log.debug('chat.notification.pushed', { notification: stored.id, user: input.user, sent, gone });
      return sent > 0 ? await this.#deps.store.table('notifications').update(stored.id, { pushed: true }) : stored;
    } catch (error) {
      this.#deps.log.warn('chat.notification.push.failed', { notification: stored.id, user: input.user, error: messageOf(error) });
      return stored;
    }
  }

  async list(user: ActorId, query: { cursor?: string; limit?: number; unread?: boolean }): Promise<Page<Notification>> {
    return this.#deps.store.table('notifications').find({
      where: { user, ...(query.unread === true ? { read: false } : {}) }, order: [['createdAt', 'desc']], limit: query.limit ?? PAGE, cursor: query.cursor,
    });
  }

  async read(user: ActorId, ids: readonly string[]): Promise<number> {
    const table = this.#deps.store.table('notifications');
    const changed = await Promise.all(ids.map(async (id) => {
      const row = await table.get(id);
      if (row?.user !== user || row.read) { return false; }
      await table.update(id, { read: true });
      return true;
    }));
    return changed.filter(Boolean).length;
  }

  /** Turn hub events into notifications. Returns the stop. */
  start(): () => void {
    const { bus } = this.#deps;
    const stops = [
      bus.subscribe('approval', (e) => { this.#guard('approval', this.#approval(e.approval, e.approvers)); }),
      bus.subscribe('handler', (e) => { this.#guard('handler', this.#handler(e.call)); }),
      bus.subscribe('pairing', (e) => { this.#guard('pairing', this.#pairing(e.pairing)); }),
      bus.subscribe('system.status', (e) => { this.#guard('system', this.#system(e.system, e.status)); }),
      bus.subscribe('budget.reached', (e) => { this.#guard('budget', this.#budget(e.budget, e.run, e.reason)); }),
    ];
    return () => { for (const stop of stops) { stop(); } };
  }

  #guard(event: string, work: Promise<void>): void {
    work.catch((error: unknown) => { this.#deps.log.error('chat.notification.event.failed', { event, error: messageOf(error) }); });
  }

  async #approval(approval: Approval, approvers: readonly ActorId[]): Promise<void> {
    if (approval.status !== 'pending' || !this.#seen.add(`approval:${approval.id}`)) { return; }
    for (const user of approvers) {
      await this.notify({ user, reason: 'approval-needed', title: `Approve ${approval.fn}?`, body: `A run is waiting for your approval to call ${approval.fn}.`, link: { run: approval.run } });
    }
  }

  async #handler(call: HandlerCall): Promise<void> {
    if (call.status !== 'pending' || !('user' in call.answerer) || !this.#seen.add(`handler:${call.id}`)) { return; }
    await this.notify({ user: call.answerer.user, reason: 'input-needed', title: 'Your answer is needed', body: call.decl.description, link: { run: call.run } });
  }

  async #pairing(pairing: PairingRequest): Promise<void> {
    if (pairing.status !== 'pending' || !this.#seen.add(`pairing:${pairing.id}`)) { return; }
    await this.#admins((user) => this.notify({
      user, reason: 'pairing-requested', title: `${pairing.name} wants to pair`, body: `From ${pairing.address}. Check the code before approving.`, link: { pairing: pairing.id },
    }));
  }

  async #system(system: SystemName, status: SystemStatus): Promise<void> {
    if (status !== 'disconnected' && status !== 'needs-config') { return; }
    const reason = status === 'disconnected' ? 'system-disconnected' : 'config-needed';
    const body = status === 'disconnected' ? 'Its fns are unavailable until it connects again.' : 'It connected without a valid config, so it can\'t be used yet.';
    await this.#admins((user) => this.notify({ user, reason, title: status === 'disconnected' ? `${system} disconnected` : `${system} needs config`, body, link: { system } }));
  }

  /** Ask the admins once per budget and run to raise a used-up budget that says `ask`; the run waits meanwhile. */
  async #budget(budget: BudgetRule, run: RunId, reason: string): Promise<void> {
    if (!this.#seen.add(`budget:${budget.id}:${run}`)) { return; }
    await this.#admins((user) => this.notify({
      user, reason: 'spend-limit', title: 'A budget needs raising', body: `A run is waiting because ${reason}. Raise the budget to let it go on.`, link: { run },
    }));
  }

  async #admins(send: (user: ActorId) => Promise<Notification>): Promise<void> {
    const users = await readAll(this.#deps.store.table('actors'), { where: { kind: 'user' } }, MAX_AUDIENCE);
    for (const user of users) {
      if (user.kind === 'user' && user.role === 'admin' && !user.disabled) { await send(user.id); }
    }
  }
}
