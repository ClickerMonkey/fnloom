/**
 * Permissions: may an actor run a fn now? Policies match actors (one actor, a group's members, a kind of actor,
 * everyone) and fns (a name or glob, a system, a kind, tags). Of the policies that match, the one with the highest
 * priority wins; among equals the more specific one (actor over group over kind over everyone, then an exact name
 * over a glob over a system), then deny beats ask beats allow. With no match, fns tagged `read` and agents are
 * allowed, and anything else asks the turn's user. Before asking, an answer given "for this session" about the same
 * fn and actor in the same session stands in. A person running a fn themselves (`!`) is not asked when they are the
 * one who would be.
 *
 * Asking creates an `Approval` and publishes it with its approvers. Answering records the decision; "always" turns it
 * into a policy for that actor and fn. An approval that names no person is decided without one: a judge fn's verdict
 * or the hub's own rule (`ApprovalDeciders`) settles it, and a decider that fails denies it.
 */
import {
  mintId, READ_TAG, type ActorId, type ActorMatch, type Approval, type ApprovalId, type FnMatch, type FnRecord, type Json, type Policy, type QualifiedName,
  type Remember, type Run, type RunId, type SessionId, type Verdict,
} from '@harness/core';
import { messageOf } from './errors.ts';
import { AGENT_KIND, type PolicyEngine, type RunDecision } from './index.ts';
import type { ExecutionDeps } from './ports.ts';
import { allRows, rows } from './pages.ts';

/**
 * With no matching policy: `read` fns and agents are allowed (an agent acts only through its tools, and each tool
 * call is decided on its own); anything else asks the turn's user.
 */
export function fallback(fn: FnRecord): Policy['decision'] {
  return fn.decl.tags.includes(READ_TAG) || fn.decl.kind === AGENT_KIND ? { effect: 'allow' } : { effect: 'ask', approver: { by: 'turn-user' } };
}

/** What an actor is, for matching subjects. */
export interface ActorFacts {
  readonly id: ActorId;
  readonly kind: 'user' | 'group' | 'agent' | 'system' | undefined;
  readonly groups: ReadonlySet<ActorId>;
}

/** How specific a subject match is (higher is more specific), or undefined when it doesn't match. */
export function subjectRank(match: ActorMatch, actor: ActorFacts): number | undefined {
  if ('actor' in match) return match.actor === actor.id ? 4 : undefined;
  if ('group' in match) return actor.groups.has(match.group) ? 3 : undefined;
  if ('kind' in match) return match.kind === actor.kind ? 2 : undefined;
  return 1;
}

/** A glob over qualified names: `*` matches any run of characters except `/`, `**` any run at all. */
export function globMatches(glob: string, name: string): boolean {
  const pattern = glob
    .split('**')
    .map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(name);
}

/**
 * How specific a fn match is (higher is more specific), or undefined when it doesn't match. A `when` predicate over
 * the args can't be evaluated yet, so a policy with one matches only when it would deny or ask (never to allow).
 */
export function targetRank(match: FnMatch, fn: FnRecord, effect: 'allow' | 'deny' | 'ask'): number | undefined {
  if (match.when !== undefined && effect === 'allow') return undefined;
  let rank = 0;
  if (match.fn !== undefined) {
    if (match.fn === fn.name) rank += 8;
    else if (globMatches(match.fn, fn.name)) rank += 4;
    else return undefined;
  }
  if (match.system !== undefined) {
    if (match.system !== fn.system) return undefined;
    rank += 2;
  }
  if (match.kind !== undefined) {
    if (match.kind !== fn.decl.kind) return undefined;
    rank += 1;
  }
  if (match.tags !== undefined) {
    if (!match.tags.every((tag) => fn.decl.tags.includes(tag))) return undefined;
    rank += 1;
  }
  return rank;
}

const SEVERITY = { deny: 3, ask: 2, allow: 1 } as const;

/** The policy that decides, of those that match: priority, then specificity, then severity. */
export function choosePolicy(policies: readonly Policy[], fn: FnRecord, actor: ActorFacts, now: number): Policy | undefined {
  let best: { policy: Policy; key: readonly number[] } | undefined;
  for (const policy of policies) {
    if (policy.expiresAt !== undefined && policy.expiresAt <= now) continue;
    const subject = subjectRank(policy.subject, actor);
    const target = targetRank(policy.target, fn, policy.decision.effect);
    if (subject === undefined || target === undefined) continue;
    const key = [policy.priority, subject, target, SEVERITY[policy.decision.effect]];
    if (best === undefined || compareKeys(key, best.key) > 0) best = { policy, key };
  }
  return best?.policy;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Who decides an approval that names no person. Built after the run service, since a judge is run like any fn. */
export interface ApprovalDeciders {
  /** Who the decisions are recorded as. */
  actor(): Promise<ActorId>;
  /** Run a judge fn on the call waiting for approval, and read its verdict. */
  judge(judge: QualifiedName, approval: Approval, run: Run): Promise<Verdict>;
  /** The hub's own rule about the call waiting for approval. */
  hub(approval: Approval, run: Run): Promise<Verdict>;
}

/** The policy engine on the hub store. */
export class HubPolicyEngine implements PolicyEngine {
  readonly #deps: Pick<ExecutionDeps, 'store' | 'bus' | 'clock' | 'random' | 'catalog' | 'approvers' | 'log'>;
  #deciders: ApprovalDeciders | undefined;

  constructor(deps: Pick<ExecutionDeps, 'store' | 'bus' | 'clock' | 'random' | 'catalog' | 'approvers' | 'log'>) {
    this.#deps = deps;
  }

  /** Decide approvals that name a judge or the hub with these. Until then such an approval waits. */
  decideWith(deciders: ApprovalDeciders): void {
    this.#deciders = deciders;
  }

  async decide(input: { fn: QualifiedName; actor: ActorId; turnUser: ActorId; args: Json; session?: SessionId; run: RunId; caller: ActorId }): Promise<RunDecision> {
    const { store, clock, catalog } = this.#deps;
    const fn = await catalog.fn(input.fn);
    if (fn === undefined) return { effect: 'deny', reason: `no fn ${input.fn}` };
    const actor = await this.#facts(input.actor);
    const chosen = choosePolicy(await allRows(store.table('policies')), fn, actor, clock());
    const decision = chosen?.decision ?? fallback(fn);
    if (decision.effect === 'allow') return decision;
    if (decision.effect === 'deny') return decision;
    const remembered = input.session === undefined ? undefined : await this.#rememberedForSession(fn.name, input.actor, input.session);
    if (remembered !== undefined) return remembered;
    if (decision.approver.by === 'turn-user' && input.caller === input.turnUser) return { effect: 'allow' };
    const approval: Approval = {
      id: mintId('approval', this.#deps.random),
      run: input.run,
      fn: input.fn,
      ...(chosen === undefined ? {} : { policy: chosen.id }),
      approver: decision.approver,
      status: 'pending',
      decisions: [],
      createdAt: clock(),
    };
    await store.table('approvals').insert(approval);
    await this.#publish(approval, input.turnUser, input.session);
    if (approval.approver.by === 'judge' || approval.approver.by === 'hub') this.#decideWithout(approval);
    return { effect: 'ask', approval };
  }

  async answer(id: ApprovalId, input: { by: ActorId; approve: boolean; remember: Remember; reason?: string }): Promise<Approval> {
    const { store } = this.#deps;
    const approval = await store.table('approvals').get(id);
    if (approval === undefined) throw new Error(`no approval ${id}`);
    if (approval.status !== 'pending') return approval;
    const run = await store.table('runs').get(approval.run);
    if (run === undefined) throw new Error(`approval ${id} names no run`);
    const turn = await store.table('turns').get(run.turn);
    const turnUser = turn?.user.id ?? run.actor;
    const approvers = await this.#deps.approvers.approvers(approval.approver, turnUser);
    if (!approvers.includes(input.by)) throw new Error(`${input.by} can't answer approval ${id}`);
    return this.#record(approval, run, turnUser, input);
  }

  /**
   * Settle an approval no person answers, once the run has been told to wait: the judge fn's verdict or the hub's
   * rule. A decider that fails, or none being set, denies with the reason.
   */
  #decideWithout(approval: Approval): void {
    const decide = async (): Promise<void> => {
      const { store } = this.#deps;
      const run = await store.table('runs').get(approval.run);
      if (run === undefined) throw new Error(`approval ${approval.id} names no run`);
      const turnUser = (await store.table('turns').get(run.turn))?.user.id ?? run.actor;
      const deciders = this.#deciders;
      if (deciders === undefined) throw new Error('nothing decides approvals without a person yet');
      const by = await deciders.actor();
      const verdict = await this.#verdict(deciders, approval, run);
      const current = await store.table('approvals').get(approval.id);
      if (current?.status !== 'pending') return;
      await this.#record(current, run, turnUser, { by, approve: verdict.approve, remember: 'once', reason: verdict.reason });
    };
    // queued after the caller has seen the ask, so a quick verdict can't settle the run before it is waiting
    queueMicrotask(() => {
      void decide().catch((error: unknown) => { this.#deps.log.error('approval.decide-failed', { approval: approval.id, error: messageOf(error) }); });
    });
  }

  /** The verdict of whoever the approval names; a failing judge denies, saying why. */
  async #verdict(deciders: ApprovalDeciders, approval: Approval, run: Run): Promise<Verdict> {
    try {
      switch (approval.approver.by) {
        case 'judge': return await deciders.judge(approval.approver.fn, approval, run);
        case 'hub': return await deciders.hub(approval, run);
        case 'turn-user': case 'actor': case 'group': throw new Error(`approval ${approval.id} names people`);
      }
    } catch (error) {
      return { approve: false, reason: `the decision failed: ${messageOf(error)}` };
    }
  }

  /** Add a decision to an approval, settle it when it is decided, and publish it. */
  async #record(approval: Approval, run: Run, turnUser: ActorId, input: { by: ActorId; approve: boolean; remember: Remember; reason?: string }): Promise<Approval> {
    const { store, clock } = this.#deps;
    const id = approval.id;
    const decisions = [...approval.decisions, {
      by: input.by, approve: input.approve, remember: input.remember, at: clock(), ...(input.reason === undefined ? {} : { reason: input.reason }),
    }];
    const quorum = approval.approver.by === 'group' ? approval.approver.quorum ?? 1 : 1;
    const approvals = decisions.filter((d) => d.approve).length;
    const status = !input.approve ? 'denied' : approvals >= quorum ? 'approved' : 'pending';
    const updated = await store.table('approvals').update(id, { decisions, status });
    if (status !== 'pending' && input.remember === 'always') await this.#remember(updated, run.actor, input.by, input.approve);
    await this.#publish(updated, turnUser, run.session);
    this.#deps.log.info('approval.answered', { approval: id, run: run.id, fn: approval.fn, status, by: input.by });
    return updated;
  }

  /**
   * The latest "for this session" answer about this fn for this actor in this session, as a decision: it stands in
   * for asking again (whether a policy or the fallback said ask).
   */
  async #rememberedForSession(fn: QualifiedName, actor: ActorId, session: SessionId): Promise<RunDecision | undefined> {
    const { store } = this.#deps;
    for await (const approval of rows(store.table('approvals'), { where: { fn, status: { in: ['approved', 'denied'] } }, order: [['createdAt', 'desc']] })) {
      const last = approval.decisions.at(-1);
      if (last?.remember !== 'session') continue;
      const run = await store.table('runs').get(approval.run);
      if (run?.session !== session || run.actor !== actor) continue;
      return last.approve ? { effect: 'allow' } : { effect: 'deny', reason: 'refused earlier in this session' };
    }
    return undefined;
  }

  async #remember(approval: Approval, actor: ActorId, by: ActorId, approve: boolean): Promise<void> {
    const policy: Policy = {
      id: mintId('policy', this.#deps.random),
      description: `${approve ? 'Always allow' : 'Never allow'} ${approval.fn} (answered on approval ${approval.id})`,
      subject: { actor },
      target: { fn: approval.fn },
      decision: approve ? { effect: 'allow' } : { effect: 'deny', reason: 'refused earlier, with "always"' },
      priority: 0,
      createdBy: by,
      createdAt: this.#deps.clock(),
    };
    await this.#deps.store.table('policies').insert(policy);
  }

  async #publish(approval: Approval, turnUser: ActorId, session: SessionId | undefined): Promise<void> {
    const approvers = await this.#deps.approvers.approvers(approval.approver, turnUser);
    this.#deps.bus.publish('approval', { approval, approvers, ...(session === undefined ? {} : { session }) });
  }

  async #facts(id: ActorId): Promise<ActorFacts> {
    const { store } = this.#deps;
    const actor = await store.table('actors').get(id);
    const memberships = await allRows(store.table('memberships'), { where: { user: id } });
    return { id, kind: actor?.kind, groups: new Set(memberships.map((m) => m.group)) };
  }
}
