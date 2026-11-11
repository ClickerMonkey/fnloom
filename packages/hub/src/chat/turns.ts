/**
 * Turns: a user message (or a `!` invocation) and everything it caused. Sending resolves mentions to their LLM text,
 * resolves the turn's priority and budgets, adds the hub's extras and the hooks' blocks, works out who answers, stores
 * the turn and message together, and wakes each answering agent (moving any agent still busy in the session to the
 * background first, so it can answer the new message). Agents' answers stream through `begin`, `stream` and
 * `finish`; `settle` closes the turn and tells people who are away.
 */
import {
  ACTIVE_RUN_STATUSES, isHiddenPart, mintId, splitName, type ActorId, type AgentActor, type Asker, type ChatMessage, type ClientInfo, type Json, type MessageId, type MessagePart, type OutgoingPart, type SuggestionRecord,
  type QualifiedName, type ResolvedLimits, type Run, type RunId, type RunSettled, type Session, type SessionId, type SystemName, type Turn, type TurnId, type UserInfo,
} from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import { seesContextNamed } from '../access/scope.ts';
import { cacheMissOf } from './cache.ts';
import { finishedParts } from './streams.ts';
import type { ChatDeps } from './deps.ts';
import { ChatError, messageOf } from './errors.ts';
import { AGENT_KIND } from '../execution/index.ts';
import { isAttached, type AttachedPart, type MentionService, type MessageEnricher, type NotificationService, type PresenceTracker, type ReplyRule, type TurnEnd, type TurnService } from './index.ts';
import type { People } from './people.ts';
import { UNTITLED, type StoreSessionService } from './sessions.ts';
import type { StreamBuffer } from './streams.ts';
import { allowsSystem, clip, participantOf, peopleOf, readAll, unmark } from './support.ts';
import { timeInfo } from '../execution/time.ts';

/** The most runs a session is checked for when an agent is interrupted. */
const MAX_SESSION_RUNS = 500;

/** How long a notification's body may be. */
const NOTIFICATION_BODY = 160;

/** The words of a message a person would read: its text, mention labels and commands. Used for titles, hooks and suggestions. */
export function plainText(parts: readonly MessagePart[]): string {
  return parts.map((part) => {
    switch (part.type) {
      case 'text': return part.text;
      case 'mention': return `@${part.label}`;
      case 'command': return `/${splitName(part.context).local}${Object.values(part.args).map((a) => ` ${a}`).join('')}`;
      case 'invocation': return `!${part.fn}`;
      case 'file': return part.name;
      case 'link': return part.link.title ?? '';
      case 'attachment': return part.title;
      case 'reasoning': case 'extra': case 'hook': case 'input-answer': case 'call': return '';
    }
  }).join('').trim();
}

/** Whether a message has nothing a person reads: only hidden parts (and reasoning) and no files (the chat shows it in debug mode only). */
export function hiddenMessage(message: Pick<ChatMessage, 'parts'>): boolean {
  return message.parts.every((part) => part.type === 'reasoning' || isHiddenPart(part));
}

/** How a settled run ends its turn. */
function turnEndOf(settled: RunSettled): TurnEnd {
  switch (settled.status) {
    case 'done': case 'background': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
  }
}

/** The collaborators a turn service works with. */
export interface TurnParts {
  readonly sessions: StoreSessionService;
  readonly people: People;
  readonly mentions: MentionService;
  readonly enricher: MessageEnricher;
  readonly reply: ReplyRule;
  readonly notifications: NotificationService;
  readonly presence: PresenceTracker;
  readonly streams: StreamBuffer;
}

/** Turns on the store. */
export class StoreTurnService implements TurnService {
  readonly #deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'runs' | 'agents' | 'limits' | 'catalog' | 'access'>;
  readonly #parts: TurnParts;

  constructor(deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'runs' | 'agents' | 'limits' | 'catalog' | 'access'>, parts: TurnParts) {
    this.#deps = deps;
    this.#parts = parts;
  }

  async send(input: { session: SessionId; author: ActorId; parts: OutgoingPart[]; replyTo?: MessageId; replyAll?: boolean; client: ClientInfo }): Promise<{ turn: TurnId; message: ChatMessage }> {
    if (!input.parts.some((part) => part.type !== 'text' || part.text.trim() !== '')) { throw new ChatError('invalid', 'A message needs something in it.'); }
    const { session, user, asker } = await this.#begin(input.session, input.author, input.client);
    const repliedTo = input.replyTo === undefined ? undefined : await this.#repliedTo(session, input.replyTo);
    const access = await this.#deps.access.scope(input.author);
    const commanded = await this.#commands(session, input.parts, access);
    const turn = mintId('turn', this.#deps.random);
    const parts = await this.#parts.mentions.resolve({ session, asker, parts: input.parts });
    const text = plainText(parts);
    const [limits, extras] = await Promise.all([
      this.#deps.limits.resolve({ user, session: session.id, turn }),
      this.#parts.enricher.enrich({ session, turn, text, user }),
    ]);
    const { parts: extraParts, suggestions } = extras;
    const now = this.#deps.clock();
    const draft: ChatMessage = {
      id: mintId('message', this.#deps.random), session: session.id, turn, author: input.author, role: 'user', parts: [...parts, ...extraParts], runs: [], status: 'done',
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }), replyAll: input.replyAll ?? false, answerers: [], createdAt: now,
      ...(suggestions === undefined ? {} : { suggestions }),
    };
    const answerers = this.#parts.reply.answerers({ session, message: draft, ...(repliedTo === undefined ? {} : { repliedTo }) });
    const message: ChatMessage = { ...draft, answerers: [...answerers] };
    const record = this.#turn({ id: turn, session, message: message.id, user, actor: asker.actor, client: input.client, limits, running: answerers.length > 0 });
    await this.#deps.store.tx(async (store) => {
      await store.table('turns').insert(record);
      await store.table('messages').insert(message);
    });
    this.#deps.log.info('chat.turn.sent', { session: session.id, turn, message: message.id, answerers: answerers.length, parts: message.parts.length });
    this.#deps.bus.publish('message', { message });
    await this.#parts.sessions.save(session.id, this.#sessionAfterSend(session, message, text, await this.#loads(session, extraParts, access), commanded));
    await this.#notifyMessage(session, message, repliedTo);
    await this.#wake(session, record, answerers);
    return { turn, message };
  }

  async invoke(input: { session: SessionId; author: ActorId; fn: QualifiedName; args: Json; client: ClientInfo }): Promise<{ turn: TurnId; run: RunId }> {
    const { session, user, asker } = await this.#begin(input.session, input.author, input.client);
    const fn = await this.#deps.catalog.fn(input.fn);
    const access = await this.#deps.access.scope(input.author);
    if (fn === undefined || !access.seesFn(fn)) { throw new ChatError('not-found', `No fn ${input.fn}.`); }
    const connection = access.connection(fn);
    if (connection?.state === 'missing') { throw new ChatError('unavailable', `${input.fn} acts as you: connect your account on the ${connection.page} page first.`); }
    if (!allowsSystem(session, fn.system)) { throw new ChatError('unavailable', `The ${fn.system} system is not enabled in this session.`); }
    if (fn.available !== true) { throw new ChatError('unavailable', `${input.fn} can't be used now: ${fn.available.detail}.`); }
    const turn = mintId('turn', this.#deps.random);
    const limits = await this.#deps.limits.resolve({ user, session: session.id, turn });
    const messageId = mintId('message', this.#deps.random);
    const record = this.#turn({ id: turn, session, message: messageId, user, actor: asker.actor, client: input.client, limits, running: true });
    await this.#deps.store.table('turns').insert(record);
    let started: Awaited<ReturnType<ChatDeps['runs']['start']>>;
    try {
      started = await this.#deps.runs.start({
        fn: input.fn, args: input.args, turn, session: session.id, key: 'invoke', actor: input.author, caller: input.author, priority: limits.priority,
        background: false, handlers: [], budget: { cost: limits.turn.cost, time: limits.turn.time },
      });
    } catch (error) {
      // A run that never started must not leave its turn running forever.
      this.#deps.log.warn('chat.turn.invoke.refused', { session: session.id, turn, fn: input.fn, error: messageOf(error) });
      await this.settle(turn, 'failed');
      throw error;
    }
    const { run, settled } = started;
    const message: ChatMessage = {
      id: messageId, session: session.id, turn, author: input.author, role: 'user', parts: [{ type: 'invocation', run, fn: input.fn }], runs: [run], status: 'done',
      replyAll: false, answerers: [], createdAt: this.#deps.clock(),
    };
    await this.#deps.store.tx(async (store) => {
      await store.table('turns').update(turn, { root: run });
      await store.table('messages').insert(message);
    });
    this.#deps.log.info('chat.turn.invoked', { session: session.id, turn, fn: input.fn, run });
    this.#deps.bus.publish('message', { message });
    await this.#parts.sessions.save(session.id, { status: 'running' });
    this.#settleWith(turn, run, settled).catch((error: unknown) => { this.#deps.log.error('chat.turn.settle.failed', { turn, error: messageOf(error) }); });
    return { turn, run };
  }

  async begin(input: { turn: TurnId; author: ActorId; replyTo?: MessageId }): Promise<ChatMessage> {
    const turn = await this.#deps.store.table('turns').get(input.turn);
    if (turn?.session === undefined) { throw new ChatError('not-found', `No session turn ${input.turn}.`); }
    const replyTo = input.replyTo ?? turn.message;
    const message: ChatMessage = {
      id: mintId('message', this.#deps.random), session: turn.session, turn: turn.id, author: input.author, role: 'assistant', parts: [], runs: [], status: 'streaming',
      ...(replyTo === undefined ? {} : { replyTo }), replyAll: false, answerers: [], createdAt: this.#deps.clock(),
    };
    await this.#deps.store.table('messages').insert(message);
    this.#parts.streams.open(message.id, turn.session);
    this.#deps.bus.publish('message', { message });
    return message;
  }

  stream(message: MessageId, delta: { text?: string; reasoning?: string }): void {
    const streamed = this.#parts.streams.append(message, delta);
    if (streamed === undefined) {
      this.#deps.log.debug('chat.stream.closed', { message });
      return;
    }
    if (delta.text !== undefined && delta.text !== '') { this.#deps.bus.publish('message.token', { session: streamed.session, message, text: delta.text }); }
    if (delta.reasoning !== undefined && delta.reasoning !== '') { this.#deps.bus.publish('message.reasoning', { session: streamed.session, message, text: delta.reasoning }); }
  }

  async suggested(message: MessageId, record: SuggestionRecord): Promise<void> {
    const row = await this.#deps.store.table('messages').get(message);
    if (row === undefined || row.suggestions !== undefined) { return; }
    const updated = await this.#deps.store.table('messages').update(message, { suggestions: record });
    this.#deps.bus.publish('message', { message: updated });
  }

  async track(message: MessageId, calls: ReadonlyArray<{ readonly run: RunId; readonly fn: QualifiedName }>): Promise<void> {
    if (calls.length === 0) { return; }
    const row = await this.#deps.store.table('messages').get(message);
    if (row === undefined) { throw new ChatError('not-found', `No message ${message}.`); }
    // each call takes its place after what streamed before it, so the message keeps the model's order
    const placed = this.#parts.streams.call(message, calls);
    const added = calls.map((call) => call.run).filter((run) => !row.runs.includes(run));
    if (added.length === 0 && placed === 0) { return; }
    const updated = added.length === 0 ? row : await this.#deps.store.table('messages').update(message, { runs: [...row.runs, ...added] });
    // Mid-stream, the browser's copy has the streamed reasoning, text and calls, so the update carries them too.
    this.#deps.bus.publish('message', { message: this.#parts.streams.overlay(updated) });
  }

  async attach(run: RunId, part: AttachedPart): Promise<ChatMessage> {
    const { store, bus } = this.#deps;
    const row = await store.table('runs').get(run);
    if (row?.session === undefined) { throw new ChatError('not-found', `Run ${run} belongs to no session.`); }
    const latest = (await store.table('messages').find({ where: { turn: row.turn, role: 'assistant' }, order: [['createdAt', 'desc']], limit: 1 })).items[0];
    const target = latest ?? await this.#invocationCarrier(row.turn, run, row.system, row.session);
    if (target === undefined) { throw new ChatError('conflict', `Turn ${row.turn} has no assistant message to attach to yet.`); }
    const updated = await store.table('messages').update(target.id, { parts: [...target.parts, part], runs: target.runs.includes(run) ? target.runs : [...target.runs, run] });
    bus.publish('message', { message: this.#parts.streams.overlay(updated) });
    return updated;
  }

  /**
   * A turn a person started with `!` has no agent answering it, so what its run attaches lands on a message of its
   * own: an assistant message by the system that ran the fn, carrying the run's card. Undefined for any other turn
   * (its agent's answer is where attachments go, once it has begun).
   */
  async #invocationCarrier(turnId: TurnId, run: RunId, system: SystemName, session: SessionId): Promise<ChatMessage | undefined> {
    const { store, bus } = this.#deps;
    const turn = await store.table('turns').get(turnId);
    const asked = turn?.message === undefined ? undefined : await store.table('messages').get(turn.message);
    if (asked?.parts.some((part) => part.type === 'invocation') !== true) { return undefined; }
    const author = (await store.table('systems').get(system))?.actor ?? asked.author;
    const carrier: ChatMessage = {
      id: mintId('message', this.#deps.random), session, turn: turnId, author, role: 'assistant', parts: [], runs: [run], status: 'done', replyTo: asked.id,
      replyAll: false, answerers: [], createdAt: this.#deps.clock(),
    };
    await store.table('messages').insert(carrier);
    bus.publish('message', { message: carrier });
    return carrier;
  }

  async finish(message: MessageId, parts: MessagePart[], status: 'done' | 'failed'): Promise<ChatMessage> {
    const row = await this.#deps.store.table('messages').get(message);
    if (row === undefined) { throw new ChatError('not-found', `No message ${message}.`); }
    if (row.role !== 'assistant') { throw new ChatError('conflict', 'Only an assistant message is finished.'); }
    const streamed = this.#parts.streams.close(message);
    const body = streamed === undefined ? parts : finishedParts(streamed.parts, parts);
    const cacheMiss = await cacheMissOf(this.#deps, row).catch((error: unknown) => {
      this.#deps.log.warn('chat.cache-miss.failed', { message, error: messageOf(error) });
      return undefined;
    });
    const finished = await this.#deps.store.table('messages').update(message, { parts: [...body, ...row.parts.filter(isAttached)], status, ...(cacheMiss === undefined ? {} : { cacheMiss }) });
    this.#deps.bus.publish('message', { message: finished });
    const session = await this.#deps.store.table('sessions').get(row.session);
    const repliedTo = row.replyTo === undefined ? undefined : await this.#deps.store.table('messages').get(row.replyTo);
    const turn = await this.#deps.store.table('turns').get(row.turn);
    // The turn's own author hears when the turn settles, so a reply here is only news to someone else.
    if (session !== undefined && repliedTo !== undefined && repliedTo.author !== turn?.actor) { await this.#notifyReply(session, finished, repliedTo); }
    return finished;
  }

  async settle(id: TurnId, status: TurnEnd): Promise<void> {
    const turn = await this.#deps.store.table('turns').get(id);
    if (turn === undefined) { throw new ChatError('not-found', `No turn ${id}.`); }
    if (turn.status !== 'running' && turn.status !== 'paused') { return; }
    await this.#deps.store.table('turns').update(id, { status, endedAt: this.#deps.clock() });
    this.#deps.log.info('chat.turn.settled', { turn: id, session: turn.session, status });
    if (turn.session === undefined) { return; }
    const running = await this.#deps.store.table('turns').count({ session: turn.session, status: 'running' });
    const session = running === 0 ? await this.#parts.sessions.save(turn.session, { status: 'idle' }) : await this.#deps.store.table('sessions').get(turn.session);
    this.#deps.bus.publish('session.controls', { session: turn.session, controls: await this.#parts.sessions.controls(turn.session) });
    if (session !== undefined) { await this.#notifyFinished(session, turn, status); }
  }

  /** End an invoked turn the way its run ends; a run that can't report back fails the turn. */
  async #settleWith(turn: TurnId, run: RunId, settled: Promise<RunSettled>): Promise<void> {
    let end: TurnEnd;
    try {
      end = turnEndOf(await settled);
    } catch (error) {
      this.#deps.log.error('chat.turn.invoke.failed', { turn, run, error: messageOf(error) });
      end = 'failed';
    }
    await this.settle(turn, end);
  }

  /** The session, the author as a user, and who-and-when, for a new turn. */
  async #begin(id: SessionId, author: ActorId, client: ClientInfo): Promise<{ session: Session; user: UserInfo; asker: Asker }> {
    const session = await this.#parts.sessions.require(id, author);
    if (session.archived) { throw new ChatError('conflict', 'This session is archived.'); }
    if (participantOf(session, author)?.role === 'agent') { throw new ChatError('forbidden', 'Agents answer through their runs.'); }
    const asker = await this.#parts.people.asker(session.id, author, client);
    return { session, user: asker.user, asker };
  }

  async #repliedTo(session: Session, id: MessageId): Promise<ChatMessage> {
    const message = await this.#deps.store.table('messages').get(id);
    if (message?.session !== session.id) { throw new ChatError('invalid', 'A reply must be to a message in the same session.'); }
    return message;
  }

  #turn(input: { id: TurnId; session: Session; message?: MessageId | undefined; user: UserInfo; actor: ActorId; client?: ClientInfo | undefined; limits: ResolvedLimits; running: boolean }): Turn {
    const now = this.#deps.clock();
    const errors = this.#deps.settings.chat.HARNESS_TURN_ERRORS;
    return {
      id: input.id, session: input.session.id, ...(input.message === undefined ? {} : { message: input.message }), actor: input.actor, user: input.user,
      time: timeInfo(now, input.user.timeZone), ...(input.client === undefined ? {} : { client: input.client }), status: input.running ? 'running' : 'done',
      limits: input.limits, cost: 0, errors: errors === 0 ? 'feed-back' : { max: errors }, createdAt: now, ...(input.running ? {} : { endedAt: now }),
    };
  }

  async followUp(input: { turn: TurnId; agent: ActorId }): Promise<TurnId | undefined> {
    const { store, random, log } = this.#deps;
    const earlier = await store.table('turns').get(input.turn);
    const session = earlier?.session === undefined ? undefined : await store.table('sessions').get(earlier.session);
    if (earlier === undefined || session === undefined || session.archived) { return undefined; }
    if ((await this.#answering(session)).length > 0) { return undefined; }
    const id = mintId('turn', random);
    const limits = await this.#deps.limits.resolve({ user: earlier.user, session: session.id, turn: id });
    const record = this.#turn({ id, session, user: earlier.user, actor: earlier.actor, client: earlier.client, limits, running: true });
    await store.table('turns').insert(record);
    await this.#parts.sessions.save(session.id, { status: 'running' });
    log.info('chat.turn.follow-up', { session: session.id, turn: id, after: earlier.id });
    await this.#wake(session, record, [input.agent]);
    return id;
  }

  /** The agent runs answering in a session now (each a turn's root, not a tool call). */
  async #answering(session: Session, except?: TurnId): Promise<Run[]> {
    return (await readAll(this.#deps.store.table('runs'), { where: { session: session.id, kind: AGENT_KIND, status: { in: ACTIVE_RUN_STATUSES } } }, MAX_SESSION_RUNS))
      .filter((run) => run.parent === undefined && run.turn !== except);
  }

  /** What sending changes on the session: the first message names it, hooks' loads join its tools and context. */
  #sessionAfterSend(session: Session, message: ChatMessage, text: string, loads: { tools: QualifiedName[]; context: QualifiedName[] }, commanded: readonly QualifiedName[]): Partial<Session> {
    const context = [...loads.context, ...commanded];
    return {
      ...(session.title === UNTITLED && text !== '' ? { title: clip(text, this.#deps.settings.chat.HARNESS_TITLE_LENGTH) } : {}),
      ...(loads.tools.length > 0 ? { tools: [...new Set([...session.tools, ...loads.tools])] } : {}),
      ...(context.length > 0 ? { context: [...new Set([...session.context, ...context])] } : {}),
      ...(message.answerers.length > 0 ? { status: 'running' as const } : {}),
    };
  }

  /**
   * The context each `/command` pulls in. Refused unless the context exists, has that command, belongs to a system the
   * session enables, can be used now, and every required argument is given.
   */
  async #commands(session: Session, parts: readonly OutgoingPart[], access: AccessScope): Promise<QualifiedName[]> {
    const names: QualifiedName[] = [];
    for (const part of parts) {
      if (part.type !== 'command') { continue; }
      const context = await this.#deps.catalog.context(part.context);
      if (context?.decl.command === undefined || !access.seesContext(context)) { throw new ChatError('not-found', `No command for ${part.context}.`); }
      if (!allowsSystem(session, context.system)) { throw new ChatError('unavailable', `The ${context.system} system is not enabled in this session.`); }
      const available = await this.#deps.catalog.availability(part.context);
      if (available !== true) { throw new ChatError('unavailable', `/${context.decl.command.name} can't be used now: ${available.detail}.`); }
      const missing = context.decl.command.args.filter((arg) => arg.required && (part.args[arg.name] ?? '').trim() === '').map((arg) => arg.name);
      if (missing.length > 0) { throw new ChatError('invalid', `/${context.decl.command.name} needs ${missing.join(', ')}.`); }
      names.push(context.name);
    }
    return names;
  }

  /** The fns and context hooks asked to load, kept to what the session allows and can use now. */
  async #loads(session: Session, extras: readonly MessagePart[], access: AccessScope): Promise<{ tools: QualifiedName[]; context: QualifiedName[] }> {
    const asked = extras.flatMap((p) => (p.type === 'hook' ? p.blocks : [])).flatMap((b) => (b.type === 'load' ? [b] : []));
    const usable = async (names: readonly QualifiedName[], sees: (name: QualifiedName) => Promise<boolean>): Promise<QualifiedName[]> => {
      const checked = await Promise.all(names.map(async (name) => allowsSystem(session, splitName(name).system) && (await this.#deps.catalog.availability(name)) === true && await sees(name)));
      return names.filter((_, i) => checked[i] === true);
    };
    const seesFn = (name: QualifiedName): Promise<boolean> => Promise.resolve(access.mayUse({ name, system: splitName(name).system }));
    const seesContext = (name: QualifiedName): Promise<boolean> => seesContextNamed(access, (n) => this.#deps.catalog.context(n), name, session.id);
    return { tools: await usable(asked.flatMap((b) => b.fns ?? []), seesFn), context: await usable(asked.flatMap((b) => b.context ?? []), seesContext) };
  }

  /** Wake each answering agent; any agent run still busy in the session goes to the background first. */
  async #wake(session: Session, turn: Turn, answerers: readonly ActorId[]): Promise<void> {
    if (answerers.length === 0) { return; }
    const busy = await this.#answering(session, turn.id);
    await Promise.all(busy.map(async (run) => this.#deps.agents.interrupt(run.id)));
    const started: RunId[] = [];
    for (const actor of answerers) {
      const agent = await this.#agent(actor);
      if (agent === undefined) { continue; }
      try {
        const { run } = await this.#deps.agents.start({
          kind: AGENT_KIND, fn: agent.fn, args: {}, turn: turn.id, session: session.id, key: `answer:${agent.fn}`, actor: turn.actor, caller: agent.id,
          priority: turn.limits.priority, background: false, handlers: [], budget: { cost: turn.limits.turn.cost, time: turn.limits.turn.time },
        });
        started.push(run);
      } catch (error) {
        this.#deps.log.error('chat.turn.wake.failed', { turn: turn.id, agent: agent.fn, error: messageOf(error) });
      }
    }
    const root = started[0];
    if (root === undefined) {
      await this.settle(turn.id, 'failed');
      return;
    }
    await this.#deps.store.table('turns').update(turn.id, { root });
  }

  async #agent(actor: ActorId): Promise<AgentActor | undefined> {
    const row = await this.#deps.store.table('actors').get(actor);
    return row?.kind === 'agent' && !row.disabled ? row : undefined;
  }

  /**
   * Tell the people in a session about a new message, each as their notify choice asks and only while they aren't
   * looking: the author of the message replied to hears of the reply (unless they chose `none`), and everyone else who
   * chose `all` hears of the message. The author is never told of their own message.
   */
  async #notifyMessage(session: Session, message: ChatMessage, repliedTo: ChatMessage | undefined): Promise<void> {
    // a message only the model reads (a form's answers) is no news to anyone
    if (hiddenMessage(message)) { return; }
    await this.#notifyReply(session, message, repliedTo);
    const repliedAuthor = repliedTo?.author;
    for (const person of peopleOf(session)) {
      if (person.actor === message.author || person.actor === repliedAuthor || person.notify !== 'all' || this.#parts.presence.looking(person.actor, session.id)) { continue; }
      await this.#parts.notifications.notify({
        user: person.actor, reason: 'message', title: `New message in ${session.title}`, body: clip(unmark(plainText(message.parts)), NOTIFICATION_BODY), link: { session: session.id },
      });
    }
  }

  /** Tell the author of the message replied to, when they are someone else and not looking. */
  async #notifyReply(session: Session, message: ChatMessage, repliedTo: ChatMessage | undefined): Promise<void> {
    if (repliedTo === undefined || repliedTo.author === message.author) { return; }
    const person = participantOf(session, repliedTo.author);
    if (person === undefined || person.role === 'agent' || person.notify === 'none' || this.#parts.presence.looking(person.actor, session.id)) { return; }
    await this.#parts.notifications.notify({
      user: person.actor, reason: 'replied', title: `New reply in ${session.title}`, body: clip(unmark(plainText(message.parts)), NOTIFICATION_BODY), link: { session: session.id },
    });
  }

  /** Tell the people who want to know that a turn finished while they were away. */
  async #notifyFinished(session: Session, turn: Turn, status: TurnEnd): Promise<void> {
    const answer = (await this.#deps.store.table('messages').find({ where: { turn: turn.id, role: 'assistant' }, order: [['createdAt', 'desc']], limit: 1 })).items[0];
    const outcome = { done: 'finished', failed: 'failed', cancelled: 'was cancelled' } as const satisfies Record<TurnEnd, string>;
    const body = answer === undefined ? `The turn ${outcome[status]}.` : clip(unmark(plainText(answer.parts)), NOTIFICATION_BODY);
    const audience = peopleOf(session).filter((p) => p.notify === 'all' || (p.notify === 'replies' && p.actor === turn.actor));
    for (const person of audience) {
      if (this.#parts.presence.looking(person.actor, session.id)) { continue; }
      await this.#parts.notifications.notify({ user: person.actor, reason: status === 'failed' ? 'turn-failed' : 'turn-finished', title: `${session.title} ${outcome[status]}`, body, link: { session: session.id } });
    }
  }
}

