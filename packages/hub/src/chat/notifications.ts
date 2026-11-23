/**
 * Notifications: the inbox and web push. Every notification is stored and published (the browser's bell updates
 * live); it is also pushed to the user's subscribed browsers unless they are looking at the place it links to. Beside
 * the replies and finished turns chat itself reports, it turns hub events into notifications: approvals and input a
 * person must give, pairings waiting for an admin, systems that went away or need config, and budgets that say `ask`
 * when they are used up (admins are asked to raise them).
 *
 * An action item resolves itself once what it asked for has happened (the approval was decided, the question
 * answered, the pairing approved, the system connected, or the run ended first): it is marked read and keeps a
 * past-tense note of what became of it, so the bell counts only what still needs someone.
 */
import {
  argSummary, isSettled, mintId, type ActorId, type Approval, type Approver, type BudgetRule, type HandlerCall, type Notification, type NotificationId, type NotificationLink, type NotificationReason,
  type Page, type PairingRequest, type RunId, type SettledRunStatus, type SystemName, type SystemStatus, type Compact, type NotificationListQuery,
} from '@harness/core';
import type { ChatDeps } from './deps.ts';
import { messageOf } from './errors.ts';
import type { ApproverDirectory, NotificationInput, NotificationService, PresenceTracker } from './index.ts';
import { allRows } from '../store/rows.ts';

/** How many already-notified event ids are remembered, so a repeated event doesn't notify twice. */
const REMEMBERED = 2_000;

/** Notifications per page when a request gives no limit. */
const PAGE = 30;

/** How many of the newest notifications of a reason are checked when something resolves them. */
const RESOLVE_WINDOW = 200;

/** The words for what became of an approval, a question, a pairing or a run once nobody needs to act on it. */
const APPROVAL_END = { approved: 'Approved', denied: 'Denied', expired: 'Timed out' } as const satisfies Record<Exclude<Approval['status'], 'pending'>, string>;
const HANDLER_END = { answered: 'Answered', failed: 'No longer needed' } as const satisfies Record<Exclude<HandlerCall['status'], 'pending'>, string>;
const PAIRING_END = { approved: 'Paired', rejected: 'Rejected', expired: 'Expired' } as const satisfies Record<Exclude<PairingRequest['status'], 'pending'>, string>;
const RUN_END = { done: 'Run finished', 'invalid-input': 'Sent back to the model', failed: 'Run failed', cancelled: 'Run cancelled', undone: 'Run undone' } as const satisfies Record<SettledRunStatus, string>;

/** The action items about a run, which end when it does. */
const RUN_ITEMS = ['approval-needed', 'input-needed', 'spend-limit'] as const satisfies readonly NotificationReason[];

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
  readonly #deps: Pick<ChatDeps, 'store' | 'hubActor'>;

  constructor(deps: Pick<ChatDeps, 'store' | 'hubActor'>) {
    this.#deps = deps;
  }

  async approvers(approver: Approver, turnUser: ActorId): Promise<ActorId[]> {
    switch (approver.by) {
      case 'turn-user': return [turnUser];
      case 'actor': return [approver.actor];
      case 'group': return (await allRows(this.#deps.store.table('memberships'), { where: { group: approver.group } })).map((m) => m.user);
      case 'admins': {
        const users = await allRows(this.#deps.store.table('actors'), { where: { kind: 'user' } });
        return users.flatMap((user) => (user.kind === 'user' && user.role === 'admin' && !user.disabled ? [user.id] : []));
      }
      // a judge or the hub decides by itself (the policy engine's deciders), so no person answers
      case 'judge': case 'hub': return [];
    }
  }
}

/** The inbox on the store, pushed through the push service. */
export class StoreNotifications implements NotificationService {
  readonly #deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'push' | 'log' | 'settings'>;
  readonly #presence: PresenceTracker;
  readonly #seen = new RecentSet(REMEMBERED);
  /** Systems in "needs config" whose notice waits out the grace (`HARNESS_CONFIG_NOTICE_GRACE`). */
  readonly #waiting = new Map<SystemName, ReturnType<typeof setTimeout>>();

  constructor(deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'push' | 'log' | 'settings'>, presence: PresenceTracker) {
    this.#deps = deps;
    this.#presence = presence;
  }

  async notify(input: NotificationInput): Promise<Notification> {
    const table = this.#deps.store.table('notifications');
    // a key replaces the person's unread notification of that key in place: one item for a repeating notice, not forty
    const replaced = input.key === undefined ? undefined : (await table.find({ where: { user: input.user, key: input.key, read: false }, order: [['createdAt', 'desc']], limit: 1 })).items[0];
    const fresh = { ...input, read: false, pushed: false, createdAt: this.#deps.clock() };
    const stored = replaced === undefined
      ? await table.insert({ id: mintId('notification', this.#deps.random), ...fresh })
      // the fields the earlier one had and this one hasn't go with it
      : await table.put({ id: replaced.id, ...fresh });
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

  async list(user: ActorId, query: Compact<NotificationListQuery>): Promise<Page<Notification>> {
    return this.#deps.store.table('notifications').find({
      where: { user, ...(query.unread === true ? { read: false } : {}) }, order: [['createdAt', 'desc']], limit: query.limit ?? PAGE, cursor: query.cursor,
    });
  }

  async read(user: ActorId, ids: readonly NotificationId[]): Promise<number> {
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
      bus.subscribe('system.paused', (e) => { this.#guard('system', this.#paused(e.system, e.refusals)); }),
      bus.subscribe('system.notice', (e) => { this.#guard('system', this.#admins((user) => this.notify({ user, reason: 'system-notice', title: `${e.system}: ${e.title}`, body: e.body, link: { system: e.system } }))); }),
      bus.subscribe('run.update', (e) => {
        if (e.update.type === 'status' && isSettled(e.update.status)) {
          this.#guard('run', this.#resolve(RUN_ITEMS, (link) => 'run' in link && link.run === e.run, RUN_END[e.update.status]));
        }
      }),
    ];
    return () => {
      for (const stop of stops) { stop(); }
      for (const timer of this.#waiting.values()) { clearTimeout(timer); }
      this.#waiting.clear();
    };
  }

  #guard(event: string, work: Promise<void>): void {
    work.catch((error: unknown) => { this.#deps.log.error('chat.notification.event.failed', { event, error: messageOf(error) }); });
  }

  /**
   * Resolve the open action items of some reasons whose link matches: each is marked read with what became of it,
   * and published again so open inboxes update.
   */
  async #resolve(reasons: readonly NotificationReason[], matches: (link: NotificationLink) => boolean, outcome: string): Promise<void> {
    const table = this.#deps.store.table('notifications');
    for (const reason of reasons) {
      const { items } = await table.find({ where: { reason }, order: [['createdAt', 'desc']], limit: RESOLVE_WINDOW });
      for (const row of items) {
        if (row.resolved !== undefined || !matches(row.link)) { continue; }
        const resolved = await table.update(row.id, { read: true, resolved: outcome });
        this.#deps.bus.publish('notification', { notification: resolved });
      }
    }
  }

  async #approval(approval: Approval, approvers: readonly ActorId[]): Promise<void> {
    if (approval.status !== 'pending') {
      await this.#resolve(['approval-needed'], (link) => 'run' in link && link.run === approval.run, APPROVAL_END[approval.status]);
      return;
    }
    if (!this.#seen.add(`approval:${approval.id}`)) { return; }
    // build 9: a proposal with a form is a question (Claude asking, an MCP server eliciting): it reads as one
    const words = approval.ask === undefined
      ? { title: `Approve ${approval.fn}?`, body: `A run is waiting for your approval to call ${approval.fn}.` }
      : { title: approval.preview?.title ?? `Answer ${approval.fn}`, body: 'A question is waiting for your answer.' };
    for (const user of approvers) {
      await this.notify({ user, reason: 'approval-needed', ...words, link: { run: approval.run } });
    }
  }

  async #handler(call: HandlerCall): Promise<void> {
    if (call.status !== 'pending') {
      await this.#resolve(['input-needed'], (link) => 'run' in link && link.run === call.run, HANDLER_END[call.status]);
      return;
    }
    if (!('user' in call.answerer) || !this.#seen.add(`handler:${call.id}`)) { return; }
    await this.notify({ user: call.answerer.user, reason: 'input-needed', title: call.decl.description, body: await this.#whereAsked(call), link: { run: call.run } });
  }

  /**
   * Where a question comes from, so questions can be told apart: what it is about (its most telling arg, such as the
   * command) and the chat it was asked in. "`sleep 20; echo never` in “Deploy notes”".
   */
  async #whereAsked(call: HandlerCall): Promise<string> {
    const about = argSummary(call.args, 80);
    const run = await this.#deps.store.table('runs').get(call.run);
    const session = run?.session === undefined ? undefined : await this.#deps.store.table('sessions').get(run.session);
    const what = about === '' ? 'A run is waiting for your answer' : `\`${about}\``;
    return session === undefined ? what : `${what} in “${session.title}”`;
  }

  async #pairing(pairing: PairingRequest): Promise<void> {
    if (pairing.status !== 'pending') {
      await this.#resolve(['pairing-requested'], (link) => 'pairing' in link && link.pairing === pairing.id, PAIRING_END[pairing.status]);
      return;
    }
    if (!this.#seen.add(`pairing:${pairing.id}`)) { return; }
    await this.#admins((user) => this.notify({
      user, reason: 'pairing-requested', title: `${pairing.name} wants to pair`, body: `From ${pairing.address}. Check the code before approving.`, link: { pairing: pairing.id },
    }));
  }

  async #system(system: SystemName, status: SystemStatus): Promise<void> {
    const about = (link: NotificationLink): boolean => 'system' in link && link.system === system;
    // any news of the system ends a wait for its config notice: it connected, went away, or needs config again
    const waiting = this.#waiting.get(system);
    if (waiting !== undefined) { clearTimeout(waiting); this.#waiting.delete(system); }
    if (status === 'connected' || status === 'removed') {
      await this.#resolve(['config-needed', 'system-disconnected'], about, status === 'connected' ? 'Connected' : 'Removed');
      return;
    }
    // a system that went away no longer needs config until it is back; one that needs config is no longer just gone
    if (status === 'disconnected') { await this.#resolve(['config-needed'], about, 'Disconnected'); }
    if (status === 'needs-config') { await this.#resolve(['system-disconnected'], about, 'Reconnected'); }
    if (status === 'disconnected') {
      await this.#admins((user) => this.notify({ user, reason: 'system-disconnected', title: `${system} disconnected`, body: 'Its fns are unavailable until it connects again.', link: { system } }));
    }
    if (status !== 'needs-config') { return; }
    const grace = this.#deps.settings.chat.HARNESS_CONFIG_NOTICE_GRACE;
    if (grace === 0) { await this.#configNeeded(system); return; }
    // a fresh hub's systems often connect before their config arrives: tell the admins only if it stays that way
    this.#waiting.set(system, setTimeout(() => {
      this.#waiting.delete(system);
      this.#guard('system', this.#configNeeded(system));
    }, grace));
  }

  async #configNeeded(system: SystemName): Promise<void> {
    await this.#admins((user) => this.notify({
      user, reason: 'config-needed', title: `${system} needs config`, body: 'It connected without a valid config, so it can\'t be used yet.', link: { system },
    }));
  }

  /** Tell the admins a system was paused for going past what it declared. */
  async #paused(system: SystemName, refusals: number): Promise<void> {
    await this.#admins((user) => this.notify({
      user, reason: 'system-paused', title: `${system} was paused`, body: `It was refused ${String(refusals)} times for going past what it declared. Its functions are off until you switch them on.`, link: { system },
    }));
  }

  /** Ask the admins once per budget and run to raise a used-up budget that says `ask`; the run waits meanwhile. */
  async #budget(budget: BudgetRule, run: RunId, reason: string): Promise<void> {
    if (!this.#seen.add(`budget:${budget.id}:${run}`)) { return; }
    await this.#admins((user) => this.notify({
      user, reason: 'spend-limit', title: 'A budget needs raising', body: `A run is waiting because ${reason}. Raise the budget to let it go on.`, link: { run },
    }));
  }

  async #admins(send: (user: ActorId) => Promise<Notification>): Promise<void> {
    const users = await allRows(this.#deps.store.table('actors'), { where: { kind: 'user' } });
    for (const user of users) {
      if (user.kind === 'user' && user.role === 'admin' && !user.disabled) { await send(user.id); }
    }
  }
}
