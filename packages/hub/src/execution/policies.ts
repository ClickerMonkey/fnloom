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
  mintId, OWN_TAG, READ_TAG, type ActorId, type ActorKind, type ActorMatch, type Approval, type ApprovalId, type Approver, type FnMatch, type FnRecord, type Policy, type PolicyDecision, type QualifiedName,
  type Json, type Remember, type Run, type SessionId, type Verdict, problemLine,
} from '@harness/core';
import { reject } from '@ayepi/core';
import { invalidArgs } from './runs.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import { messageOf } from './errors.ts';
import { AGENT_KIND, type PolicyEngine, type RunDecision } from './index.ts';
import type { ExecutionDeps } from './ports.ts';
import { allRows, rows } from '../store/rows.ts';

/**
 * With no matching policy: `read` fns (tagged, or whose effects say they only read, as a saved read query's do) and
 * agents are allowed (an agent acts only through its tools, and each tool call is decided on its own), and so is a system's call of a hub fn that changes only what that system owns (`own`);
 * anything else asks the turn's user.
 */
export function fallback(fn: FnRecord, caller?: ActorKind): Policy['decision'] {
  if (fn.decl.tags.includes(READ_TAG) || fn.decl.effects?.mode === 'read' || fn.decl.kind === AGENT_KIND) return { effect: 'allow' };
  if (fn.decl.tags.includes(OWN_TAG) && fn.system === HUB_SYSTEM && caller === 'system') return { effect: 'allow' };
  return { effect: 'ask', approver: { by: 'turn-user' } };
}

/** What an actor is, for matching subjects. */
export interface ActorFacts {
  readonly id: ActorId;
  readonly kind: ActorKind | undefined;
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
export function targetRank(match: FnMatch, fn: FnRecord, effect: PolicyDecision['effect']): number | undefined {
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

/** Who answers a fn that always asks when no policy names anyone: the turn's person. */
const TURN_USER: Approver = { by: 'turn-user' };

/** What the policies are asked about one run. */
export type DecideInput = Parameters<PolicyEngine['decide']>[0];

/** A run a system proposed, to wait for its approver with the preview it worked out. */
export type ProposeApproval = Parameters<PolicyEngine['propose']>[0];

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

  async decide(input: DecideInput): Promise<RunDecision> {
    const { store, clock, catalog } = this.#deps;
    const fn = await catalog.fn(input.fn);
    if (fn === undefined) return { effect: 'deny', reason: `no fn ${input.fn}` };
    const actor = await this.#facts(input.actor);
    const chosen = choosePolicy(await allRows(store.table('policies')), fn, actor, clock());
    const policy = chosen?.decision ?? fallback(fn, chosen === undefined ? (await this.#facts(input.caller)).kind : undefined);
    if (policy.effect === 'deny') return policy;
    if (input.sensitive === true) return this.#approval(input, TURN_USER, undefined);
    const always = fn.decl.approval;
    // auto mode's classifier stands in for the fallback ask; a policy that says ask, or a fn that always asks, still asks
    if (input.autoAllowed === true && chosen === undefined && always === undefined && input.ask === undefined) return { effect: 'allow' };
    // a system's own fn called from its run that declares at least this mode was decided with that run
    if (input.withinParent === true && chosen === undefined && always === undefined && input.ask === undefined) return { effect: 'allow' };
    // a per-person fn kept on 'ask first' asks whatever the policies allow
    const asked = input.ask === undefined ? policy : { effect: 'ask' as const, approver: input.ask };
    // a fn that always asks asks even when allowed, unless its approvals may be remembered and a policy allows it
    // with `approver: 'admins'` only an admin's decision counts, whoever a policy names
    const alwaysAsks: Approver = always?.approver === 'admins' ? { by: 'admins' } : TURN_USER;
    const decided = always !== undefined && asked.effect === 'allow' && !(always.remember && chosen !== undefined)
      ? { effect: 'ask' as const, approver: alwaysAsks }
      : asked;
    const decision = decided.effect === 'ask' && always?.approver === 'admins' ? { effect: 'ask' as const, approver: alwaysAsks } : decided;
    if (decision.effect === 'allow') return decision;
    const remembered = input.session === undefined || always?.remember === false ? undefined : await this.#rememberedForSession(fn.name, input.actor, input.session);
    if (remembered !== undefined) return remembered;
    if (always === undefined && decision.approver.by === 'turn-user' && input.caller === input.turnUser) return { effect: 'allow' };
    return this.#approval(input, decision.approver, chosen?.decision.effect !== 'ask' || input.ask !== undefined ? undefined : chosen.id);
  }

  /** Make the approval a run waits on, with its preview (asked for only now: a denied, allowed or remembered run costs none). */
  async #approval(input: DecideInput, approver: Approver, policy: Approval['policy']): Promise<RunDecision> {
    const { clock } = this.#deps;
    const preview = input.preview === undefined ? undefined : await input.preview();
    if (input.preview !== undefined && preview === undefined) return { effect: 'deny', reason: `${input.fn} can't show what it would do` };
    const approval: Approval = {
      id: mintId('approval', this.#deps.random),
      run: input.run,
      fn: input.fn,
      ...(policy === undefined ? {} : { policy }),
      approver,
      status: 'pending',
      decisions: [],
      createdAt: clock(),
      ...(preview === undefined ? {} : { preview }),
    };
    return { effect: 'ask', approval: await this.#ask(approval, input.turnUser, input.session) };
  }

  propose(input: ProposeApproval): Promise<Approval> {
    return this.#ask({
      id: mintId('approval', this.#deps.random), run: input.run, fn: input.fn, approver: input.approver, status: 'pending', decisions: [],
      createdAt: this.#deps.clock(), preview: input.preview, proposed: true, ...(input.ask === undefined ? {} : { ask: input.ask }),
    }, input.turnUser, input.session);
  }

  /** Store a new approval, tell its approvers, and have a judge or the hub decide it when it names no person. */
  async #ask(approval: Approval, turnUser: ActorId, session: SessionId | undefined): Promise<Approval> {
    await this.#deps.store.table('approvals').insert(approval);
    await this.#publish(approval, turnUser, session);
    if (approval.approver.by === 'judge' || approval.approver.by === 'hub') this.#decideWithout(approval);
    return approval;
  }

  async answer(id: ApprovalId, input: { by: ActorId; approve: boolean; remember: Remember; reason?: string; answer?: Json }): Promise<Approval> {
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
    // a fn whose approvals may not be remembered (writes, schema changes) is asked about every time
    // nor is a call that touches sensitive files (its card lists them)
    const flagged = approval.preview?.parts.some((part) => part.type === 'flags') === true;
    // nor is a question: its answer is for this one run (build 9, `ask`)
    const remember = flagged || approval.ask !== undefined || (await this.#deps.catalog.fn(approval.fn))?.decl.approval?.remember === false ? 'once' : input.remember;
    if (input.approve && approval.ask !== undefined) await this.#fill(approval, run, input.answer);
    const { answer: _answer, ...decision } = input;
    return this.#record(approval, run, turnUser, { ...decision, remember });
  }

  /**
   * Build 9: put the approver's answer to a proposal's form in its run's args (`args[into]`), checked against the form's
   * type and then the fn's args, before the approval lets the run go ahead.
   */
  async #fill(approval: Approval, run: Run, answer: Json | undefined): Promise<void> {
    const ask = approval.ask;
    if (ask === undefined) return;
    if (answer === undefined) throw reject(422, 'ANSWER_NEEDED', 'This asks a question: fill in the form to approve it.');
    const problems = await this.#deps.catalog.check(run.system, ask.type, answer);
    if (problems.length > 0) throw reject(422, 'ANSWER_INVALID', problems.join('; '));
    const current = run.args;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) throw reject(409, 'ARGS_NOT_AN_OBJECT', `${run.fn}'s args take no answer`);
    const args: Json = { ...current, [ask.into]: answer };
    const invalid = invalidArgs((await this.#deps.catalog.signature(run.fn)).argsSchema.safeParse(args));
    if (invalid !== undefined) throw reject(422, 'ANSWER_INVALID', invalid.problems.map(problemLine).join('; '));
    await this.#deps.store.table('runs').update(run.id, { args });
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
        case 'turn-user': case 'actor': case 'group': case 'admins': throw new Error(`approval ${approval.id} names people`);
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
