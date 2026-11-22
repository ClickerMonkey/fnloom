/**
 * A/B compare (plan item 11): one message answered by 2 to 4 variants of the chat's settings. Each variant answers in
 * a fork of the session: a hidden copy of it (its transcript, loaded fns and context, suggestions, what the model was
 * told about the systems, and its session state) with the variant's settings over it, and a turn of its own there. So
 * nothing a variant does reaches the chat: its messages, transcript and state stay in its fork. Each variant's turn is
 * reserved an even share of the compared turn's budget up front, so all of them together never spend more than one
 * answer may (the ledger counts their spend as the chat's). A variant's call that would change something waits for the
 * person in that variant (`PolicyEngine.decide`, `variant`), and the approval says which variant asks.
 *
 * Choosing a variant appends it to the chat: the transcript it added, the fns and context it loaded, the state it
 * changed, and its messages, runs and LLM calls move to the compared turn (so undoing that turn undoes them). The other
 * variants are discarded; what they already did stays done and is listed on the turn. Undoing the compared turn undoes
 * only the chosen variant's runs: what the others did (or every variant did, when the turn is undone before a variant
 * was chosen) stays done, and the undo lists it (`kept`).
 */
import {
  CompareSettings, mintId, type ActorId, type AgentActor, type ChatMessage, type CompareEffect, type CompareFork, type CompareVariant, type CompareVariantInput,
  type CompareVariantView, type CompareView, type KeptVariant, type Run, type Session, type SessionId, type StateField, type Turn, type TurnId, type VariantIndex,
} from '@harness/core';
import type { ChatDeps } from './deps.ts';
import { ChatError, messageOf } from './errors.ts';
import type { CompareService, TurnEnd } from './index.ts';
import type { People } from './people.ts';
import type { StoreSessionService } from './sessions.ts';
import type { StreamBuffer } from './streams.ts';
import { AGENT_KIND } from '../execution/index.ts';
import { onlyReads } from '../execution/policies.ts';
import type { HubStore } from '../store/index.ts';
import { allRows, someRows } from '../store/rows.ts';

/** The settings fields a fork takes from its variant (every `SessionSettings` field). */
const SETTINGS = CompareSettings.keyof().options;

/** Turn statuses still going. */
const GOING: ReadonlySet<Turn['status']> = new Set(['running', 'paused']);

/** A variant's letter name ("Variant B"). */
const letterLabel = (index: number): string => `Variant ${String.fromCharCode(65 + index)}`;

/** A variant's name when the person gave none: what it changes ("gpt-5 · static"), else its letter. */
export function variantLabel(input: CompareVariantInput, index: number): string {
  if (input.label !== undefined) { return input.label; }
  const s = input.settings;
  const model = s.model === undefined ? undefined : 'model' in s.model ? s.model.model : 'category' in s.model ? s.model.category : 'auto';
  const parts = [
    model, s.mode?.type, s.contextor?.type, s.fnMode, s.agent, s.instructions === undefined ? undefined : 'own prompt',
    s.citations === undefined ? undefined : s.citations ? 'citations' : 'no citations',
    s.systems === undefined ? undefined : s.systems === 'all' ? 'all systems' : `${s.systems.length} systems`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? letterLabel(index) : parts.join(' · ');
}

/** Each variant's even share of a turn's cost cap. */
export function variantBudget(turnCost: number, variants: number): number {
  return turnCost / variants;
}

/** What a compare works with. */
export interface CompareParts {
  readonly sessions: StoreSessionService;
  readonly people: People;
  readonly streams: StreamBuffer;
}

/** A/B compare on the store. */
export class StoreCompareService implements CompareService {
  readonly #deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'agents' | 'catalog'>;
  readonly #parts: CompareParts;

  constructor(deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'agents' | 'catalog'>, parts: CompareParts) {
    this.#deps = deps;
    this.#parts = parts;
  }

  /** Check the variants before anything is stored: each names a real agent (when it names one). */
  async check(variants: readonly CompareVariantInput[]): Promise<void> {
    for (const variant of variants) {
      if (variant.settings.agent !== undefined) { await this.#parts.people.agent(variant.settings.agent); }
    }
  }

  /**
   * Fork the chat once per variant and wake each fork's agent on its own turn, with its share of the budget. `session`
   * is the chat as the compared message left it; `turn` is the compared turn (its message is what every variant answers).
   * How the compared turn ends when no variant could start; undefined while they answer.
   */
  async fork(input: { session: Session; turn: Turn; variants: readonly CompareVariantInput[] }): Promise<TurnEnd | undefined> {
    const { store, clock, random, log, bus } = this.#deps;
    const { session, turn } = input;
    const reserved = variantBudget(turn.limits.turn.cost, input.variants.length);
    const fields = await allRows(store.table('stateFields'), { where: { session: session.id } });
    const variants: CompareVariant[] = [];
    const forks: Array<{ fork: Session; turn: Turn; agent: AgentActor }> = [];
    for (const [index, asked] of input.variants.entries()) {
      const variant = index;
      const label = variantLabel(asked, index);
      const settings = CompareSettings.parse(asked.settings);
      const agent = await this.#parts.people.agent(settings.agent ?? session.agent);
      const now = clock();
      const forkOf: CompareFork = { turn: turn.id, variant, label };
      const old = session.participants.find((p) => p.role === 'agent' && p.actor !== agent.id && settings.agent !== undefined);
      const fork: Session = {
        ...session, ...settings, agent: agent.fn, systems: settings.systems ?? session.systems, id: mintId('session', random), forkOf: session.id, fork: forkOf, status: 'running', createdAt: now, updatedAt: now,
        participants: old === undefined ? session.participants : [...session.participants.filter((p) => p !== old), { actor: agent.id, role: 'agent', notify: 'none', joinedAt: now }],
      };
      const { root: _root, compare: _compare, endedAt: _endedAt, ...base } = turn;
      const own: Turn = {
        ...base, id: mintId('turn', random), session: fork.id, status: 'running', cost: 0, createdAt: now,
        limits: { ...turn.limits, turn: { ...turn.limits.turn, cost: reserved } },
        ...(turn.start === undefined ? {} : { start: { ...turn.start, transcript: fork.transcript.length } }),
      };
      variants.push({ variant, label, settings, session: fork.id, turn: own.id });
      forks.push({ fork, turn: own, agent });
    }
    // the forks, their turns and copies of the chat's state, all at once with the compared turn's variants
    await store.tx(async (tx) => {
      for (const { fork, turn: own } of forks) {
        await tx.table('sessions').insert(fork);
        await tx.table('turns').insert(own);
        if (fields.length > 0) { await tx.table('stateFields').putAll(fields.map((field) => ({ ...field, session: fork.id }))); }
      }
      await tx.table('turns').update(turn.id, { compare: { variants, reserved, discarded: [] } });
    });
    log.info('chat.compare.started', { session: session.id, turn: turn.id, variants: variants.length, reserved });
    for (const { fork, turn: own, agent } of forks) {
      try {
        const { run } = await this.#deps.agents.start({
          kind: AGENT_KIND, fn: agent.fn, args: {}, turn: own.id, session: fork.id, key: `answer:${agent.fn}`, actor: turn.actor, caller: agent.id,
          priority: turn.limits.priority, background: false, handlers: [], budget: { cost: reserved, time: turn.limits.turn.time },
        });
        await store.table('turns').update(own.id, { root: run });
      } catch (error) {
        log.error('chat.compare.wake.failed', { turn: turn.id, variant: fork.fork?.variant, error: messageOf(error) });
        await store.table('turns').update(own.id, { status: 'failed', endedAt: clock() });
      }
    }
    bus.publish('turn.compare', { session: session.id, turn: turn.id });
    // a variant that could not start has settled already
    return this.settled(turn.id);
  }

  /**
   * A variant's turn settled: the compared turn takes the variants' spend, its people hear of it, and once none is still
   * going, how the compared turn ends (done when any variant answered, failed when none did). Undefined while one goes on.
   */
  async settled(id: TurnId): Promise<TurnEnd | undefined> {
    const { store, bus } = this.#deps;
    const turn = await store.table('turns').get(id);
    if (turn?.compare === undefined || turn.session === undefined) { return undefined; }
    const own = await Promise.all(turn.compare.variants.map(async (v) => store.table('turns').get(v.turn)));
    const cost = own.reduce((sum, t) => sum + (t?.cost ?? 0), 0);
    if (cost !== turn.cost) { await store.table('turns').update(id, { cost }); }
    bus.publish('turn.compare', { session: turn.session, turn: id });
    if (own.some((t) => t !== undefined && GOING.has(t.status))) { return undefined; }
    return own.some((t) => t?.status === 'done') ? 'done' : own.every((t) => t?.status === 'cancelled') ? 'cancelled' : 'failed';
  }

  /** A compared turn as its chat's people see it. */
  async view(id: TurnId, viewer: ActorId): Promise<CompareView> {
    const { turn, compare } = await this.#compared(id, viewer);
    const variants = await Promise.all(compare.variants.map(async (v) => this.#variantView(turn, v)));
    const { variants: _variants, ...rest } = compare;
    return { ...rest, turn: turn.id, session: turn.session, message: turn.message, status: turn.status, variants };
  }

  /**
   * Choose a variant: what it added to its fork joins the chat, and the others are discarded (one still answering is
   * cancelled first). `adopt` makes its settings the chat's own too. Refused while the chosen one still answers, once
   * one was chosen, or when a later turn stands in the chat (it was built without this one).
   */
  async choose(input: { turn: TurnId; variant: VariantIndex; adopt?: boolean | undefined; by: ActorId }): Promise<CompareView> {
    const { store, clock, bus, log } = this.#deps;
    const { turn, compare } = await this.#compared(input.turn, input.by);
    if (compare.chosen !== undefined) { throw new ChatError('conflict', 'A variant was already chosen.'); }
    // an undone compared turn took its message out of the chat: no answer can join it
    if (turn.status === 'undone') { throw new ChatError('conflict', 'This message was undone, so none of its answers can be used.'); }
    const chosen = compare.variants.find((v) => v.variant === input.variant);
    if (chosen === undefined) { throw new ChatError('not-found', `No variant ${input.variant + 1}.`); }
    const own = await store.table('turns').get(chosen.turn);
    if (own === undefined || GOING.has(own.status)) { throw new ChatError('conflict', 'This variant is still answering. Choose it once it finishes.'); }
    if (await store.table('turns').count({ session: turn.session, createdAt: { gt: turn.createdAt }, status: { in: ['running', 'paused', 'done', 'failed', 'cancelled'] } }) > 0) {
      throw new ChatError('conflict', 'A later message was sent without this one. Undo the later turns first.');
    }
    const others = compare.variants.filter((v) => v !== chosen);
    // the others stop now: what is still running of them is cancelled
    for (const other of others) { await this.#parts.sessions.control(other.session, 'cancel', input.by); }
    const fork = await store.table('sessions').get(chosen.session);
    if (fork === undefined) { throw new ChatError('not-found', 'The variant\'s fork is gone.'); }
    const discarded = await Promise.all(others.map(async (v) => ({ variant: v.variant, effects: await this.#effects(v.turn) })));
    const from = own.start?.transcript ?? 0;
    const moved = await store.tx(async (tx) => {
      const chat = await tx.table('sessions').get(turn.session);
      if (chat === undefined) { throw new ChatError('not-found', 'No such session.'); }
      await tx.table('sessions').update(chat.id, {
        transcript: [...chat.transcript, ...fork.transcript.slice(from)], tools: [...fork.tools], context: [...fork.context],
        ...(fork.selection === undefined ? {} : { selection: fork.selection }), ...(fork.suggested === undefined ? {} : { suggested: [...fork.suggested] }),
        ...(fork.announcedSystems === undefined ? {} : { announcedSystems: fork.announcedSystems }),
        ...(fork.citationsTold === undefined ? {} : { citationsTold: fork.citationsTold }), updatedAt: clock(),
      });
      await this.#takeState(tx, fork.id, chat.id);
      // its runs, LLM calls and messages become the compared turn's, in the chat, so its tree, details and undo find them
      for (const run of await allRows(tx.table('runs'), { where: { turn: own.id } })) { await tx.table('runs').update(run.id, { turn: turn.id, session: chat.id }); }
      for (const call of await allRows(tx.table('llmInteractions'), { where: { turn: own.id } })) { await tx.table('llmInteractions').update(call.id, { turn: turn.id, session: chat.id }); }
      const messages: ChatMessage[] = [];
      for (const message of await allRows(tx.table('messages'), { where: { turn: own.id } })) { messages.push(await tx.table('messages').update(message.id, { turn: turn.id, session: chat.id })); }
      await tx.table('turns').update(turn.id, {
        ...(own.root === undefined ? {} : { root: own.root }),
        compare: { ...compare, chosen: chosen.variant, chosenBy: input.by, chosenAt: clock(), discarded },
      });
      return messages;
    });
    if (input.adopt === true) {
      const settings = Object.fromEntries(SETTINGS.flatMap((key) => (fork[key] === undefined ? [] : [[key, fork[key]]])));
      await this.#parts.sessions.update(turn.session, settings, input.by);
    }
    const chat = await store.table('sessions').get(turn.session);
    if (chat !== undefined) { this.#parts.sessions.changed(chat); }
    for (const message of moved) { bus.publish('message', { message }); }
    bus.publish('turn.compare', { session: turn.session, turn: turn.id });
    bus.publish('session.controls', { session: turn.session, controls: await this.#parts.sessions.controls(turn.session) });
    log.info('chat.compare.chosen', { session: turn.session, turn: turn.id, variant: chosen.variant, by: input.by, adopt: input.adopt === true, discarded: discarded.length });
    return this.view(turn.id, input.by);
  }

  /** A compared turn the person may see, with its session and message. */
  async #compared(id: TurnId, viewer: ActorId): Promise<{ turn: Turn & { session: SessionId; message: NonNullable<Turn['message']> }; compare: NonNullable<Turn['compare']> }> {
    const turn = await this.#deps.store.table('turns').get(id);
    if (turn?.compare === undefined || turn.session === undefined || turn.message === undefined) { throw new ChatError('not-found', `No compared turn ${id}.`); }
    await this.#parts.sessions.require(turn.session, viewer);
    return { turn: { ...turn, session: turn.session, message: turn.message }, compare: turn.compare };
  }

  async #variantView(turn: Turn, variant: CompareVariant): Promise<CompareVariantView> {
    const { store, clock, settings } = this.#deps;
    const own = await store.table('turns').get(variant.turn);
    if (own === undefined) { throw new ChatError('not-found', `No turn ${variant.turn}.`); }
    // a chosen variant's messages have moved to the compared turn
    const answers = turn.compare?.chosen === variant.variant ? turn.id : own.id;
    const messages = (await store.table('messages').find({ where: { turn: answers, role: 'assistant' }, order: [['createdAt', 'asc']], limit: settings.chat.HARNESS_MESSAGE_PAGE })).items;
    const root = own.root === undefined ? undefined : await store.table('runs').get(own.root);
    const asking = await allRows(store.table('runs'), { where: { turn: answers, status: 'awaiting-approval' } });
    const approvals = (await Promise.all(asking.map(async (run) => allRows(store.table('approvals'), { where: { run: run.id, status: 'pending' } })))).flat();
    return {
      ...variant, status: own.status, spent: own.cost, tokens: root?.tokens ?? 0, startedAt: own.createdAt, ...(own.endedAt === undefined ? {} : { endedAt: own.endedAt }),
      time: Math.max(0, (own.endedAt ?? clock()) - own.createdAt), messages: messages.map((m) => this.#parts.streams.overlay(m)), approvals,
    };
  }

  /**
   * What a compared turn's variants did that undoing the turn leaves done, by variant: the discarded variants' effects
   * once one was chosen, every variant's before. Variants that changed nothing are left out; empty for a turn not compared.
   */
  async kept(turn: Turn): Promise<KeptVariant[]> {
    const compare = turn.compare;
    if (compare === undefined) { return []; }
    const left = compare.chosen === undefined
      ? await Promise.all(compare.variants.map(async (v) => ({ variant: v.variant, effects: await this.#effects(v.turn) })))
      : compare.discarded;
    return left.flatMap(({ variant, effects }) => {
      const label = compare.variants.find((v) => v.variant === variant)?.label ?? letterLabel(variant);
      const [first, ...rest] = effects;
      return first === undefined ? [] : [{ variant, label, effects: [first, ...rest] }];
    });
  }

  /** What a variant did that stays done: its tool runs that finished and change things (not reads, not agents). */
  async #effects(turn: TurnId): Promise<CompareEffect[]> {
    const runs = await someRows(this.#deps.store.table('runs'), { where: { turn, status: 'done' }, order: [['createdAt', 'asc']] }, this.#deps.settings.chat.HARNESS_UNDO_RUNS);
    const effects: CompareEffect[] = [];
    for (const run of runs) { if (await this.#changes(run)) { effects.push({ run: run.id, fn: run.fn }); } }
    return effects;
  }

  async #changes(run: Run): Promise<boolean> {
    if (run.kind === AGENT_KIND || run.parent === undefined) { return false; }
    const fn = await this.#deps.catalog.fn(run.fn);
    return fn === undefined || !onlyReads(fn);
  }

  /** The chat takes the fork's session state: each field the variant wrote, and none it cleared. */
  async #takeState(tx: HubStore, fork: SessionId, chat: SessionId): Promise<void> {
    const key = (f: Pick<StateField, 'system' | 'name' | 'type'>): string => `${f.system}\u0000${f.name}\u0000${f.type}`;
    const theirs = new Map((await allRows(tx.table('stateFields'), { where: { session: fork } })).map((f) => [key(f), f]));
    for (const field of await allRows(tx.table('stateFields'), { where: { session: chat } })) {
      if (!theirs.has(key(field))) { await tx.table('stateFields').remove(field); }
    }
    for (const field of theirs.values()) { await tx.table('stateFields').put({ ...field, session: chat }); }
  }
}

