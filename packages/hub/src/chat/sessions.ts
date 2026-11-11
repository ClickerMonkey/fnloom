/**
 * Sessions: create, read, list and change them; their messages; what their controls can do given what is running;
 * and presence. A session starts with its owner and its agent as participants. Only participants see a session, and
 * only its owner changes it (anyone in it picks their own notify choice).
 */
import {
  ACTIVE_RUN_STATUSES, IDS, SessionSummary, isUnsettled, mintId, type ActorId, type ChatMessage, type Page, type Presence, type Priority, type PriorityRule, type QualifiedName,
  type Run, type RunId, type Session, type SessionControls, type SessionId, type SessionPatch, type SystemName, type Compact, type SessionListQuery, type MessageListQuery, type SessionControlAction,
} from '@harness/core';
import { hub } from '@harness/sdk';
import type { ChatDeps } from './deps.ts';
import { ChatError, messageOf } from './errors.ts';
import type { PresenceTracker, SessionService } from './index.ts';
import type { People } from './people.ts';
import type { StreamBuffer } from './streams.ts';
import { agentActorId, collect, participantOf, peopleOf, readAll } from './support.ts';

/** The title of a session nobody has named yet. Its first message names it. */
export const UNTITLED = 'New chat';

/** The agent that answers when a session names none. */
export const DEFAULT_AGENT: QualifiedName = hub.fns.chat.name;

/** Whether a run is not finished yet (it may still change things). */
export function isActiveRun(run: Pick<Run, 'status'>): boolean {
  return isUnsettled(run.status);
}

/** The most active runs a session's controls look at. */
const MAX_ACTIVE_RUNS = 500;

/** The most rows of one table a session's deletion removes at once (more stay for the next try). */
const MAX_DELETED = 100_000;

/** The id of a session's own priority rule: one per session, replaced on change. */
export function sessionPriorityRule(session: SessionId): PriorityRule['id'] {
  return IDS.priorityRule.parse(`pri_session.${session}`);
}

/** The people (not agents) of a session, who hear about it. */
export function audienceOf(session: Session): ActorId[] {
  return peopleOf(session).map((p) => p.actor);
}

/** Sessions on the store. */
export class StoreSessionService implements SessionService {
  readonly #deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'runs' | 'settings' | 'log'>;
  readonly #people: People;
  readonly #presence: PresenceTracker;
  readonly #streams: StreamBuffer;

  constructor(deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'runs' | 'settings' | 'log'>, people: People, presence: PresenceTracker, streams: StreamBuffer) {
    this.#deps = deps;
    this.#people = people;
    this.#presence = presence;
    this.#streams = streams;
  }

  async create(input: { owner: ActorId; agent?: QualifiedName; systems?: SystemName[] | 'all'; title?: string }): Promise<Session> {
    const owner = await this.#people.user(input.owner);
    const fn = input.agent ?? DEFAULT_AGENT;
    const agent = await this.#people.agent(fn);
    const now = this.#deps.clock();
    const session: Session = {
      id: mintId('session', this.#deps.random),
      title: input.title?.trim() || UNTITLED,
      owner: owner.id,
      agent: fn,
      participants: [
        { actor: owner.id, role: 'owner', notify: 'all', joinedAt: now },
        { actor: agent.id, role: 'agent', notify: 'none', joinedAt: now },
      ],
      systems: input.systems ?? 'all',
      tools: [],
      context: [],
      status: 'idle',
      transcript: [],
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    await this.#deps.store.table('sessions').insert(session);
    this.#deps.log.info('chat.session.created', { session: session.id, owner: owner.id, agent: fn });
    this.#changed(session);
    return session;
  }

  async get(session: SessionId, viewer: ActorId): Promise<Session | undefined> {
    const row = await this.#deps.store.table('sessions').get(session);
    return row !== undefined && participantOf(row, viewer) !== undefined ? row : undefined;
  }

  async list(viewer: ActorId, query: Compact<SessionListQuery>): Promise<Page<SessionSummary>> {
    const page = await collect(
      this.#deps.store.table('sessions'),
      { where: { owner: viewer, archived: false }, order: [['updatedAt', 'desc']], limit: query.limit ?? this.#deps.settings.chat.HARNESS_SESSION_PAGE, cursor: query.cursor },
      () => true,
    );
    return { items: page.items.map((s) => SessionSummary.parse(s)), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
  }

  async update(
    id: SessionId,
    patch: SessionPatch,
    by: ActorId,
  ): Promise<Session> {
    const session = await this.require(id, by);
    const { notify, priority, model, mode, contextor, fnMode, ...owned } = patch;
    const choices = model !== undefined || mode !== undefined || contextor !== undefined || fnMode !== undefined;
    if ((Object.keys(owned).length > 0 || priority !== undefined || choices) && session.owner !== by) { throw new ChatError('forbidden', 'Only the owner can change this session.'); }
    let participants = session.participants;
    if (notify !== undefined) { participants = participants.map((p) => (p.actor === by ? { ...p, notify } : p)); }
    if (owned.agent !== undefined && owned.agent !== session.agent) {
      const agent = await this.#people.agent(owned.agent);
      const old = agentActorId(session.agent);
      participants = [...participants.filter((p) => p.actor !== old && p.actor !== agent.id), { actor: agent.id, role: 'agent', notify: 'none', joinedAt: this.#deps.clock() }];
    }
    if (priority !== undefined) { await this.#setPriority(id, priority, by); }
    const title = owned.title?.trim();
    const updated = await this.save(id, {
      ...(title === undefined || title === '' ? {} : { title }),
      ...(owned.systems === undefined ? {} : { systems: owned.systems }),
      ...(owned.agent === undefined ? {} : { agent: owned.agent }),
      ...(owned.archived === undefined ? {} : { archived: owned.archived }),
      ...(model === undefined || model === null ? {} : { model }),
      ...(mode === undefined || mode === null ? {} : { mode }),
      ...(contextor === undefined || contextor === null ? {} : { contextor }),
      // the chat mode picker's choice (build 6 feedback: it was dropped here, so the picker never saved it)
      ...(fnMode === undefined || fnMode === null ? {} : { fnMode }),
      participants,
    });
    const result = await this.#clear(updated, { model: model === null, mode: mode === null, contextor: contextor === null, fnMode: fnMode === null });
    this.#deps.log.info('chat.session.updated', { session: id, by, fields: Object.keys(patch) });
    return result;
  }

  async delete(id: SessionId, by: ActorId): Promise<boolean> {
    const session = await this.require(id, by);
    if (session.owner !== by) { throw new ChatError('forbidden', 'Only the owner can delete this session.'); }
    const { store, runs, bus, log } = this.#deps;
    for (const run of await this.#active(id)) {
      if (run.allowed.cancel) { await runs.cancel(run.id, by); }
    }
    const removed = await store.tx(async (tx) => {
      let count = 0;
      for (const message of await readAll(tx.table('messages'), { where: { session: id } }, MAX_DELETED)) { if (await tx.table('messages').remove(message.id)) { count++; } }
      for (const delivery of await readAll(tx.table('deliveries'), { where: { session: id } }, MAX_DELETED)) { await tx.table('deliveries').remove(delivery.id); }
      for (const field of await readAll(tx.table('stateFields'), { where: { session: id } }, MAX_DELETED)) {
        await tx.table('stateFields').remove(field);
      }
      await tx.table('priorityRules').remove(sessionPriorityRule(id));
      await tx.table('sessions').remove(id);
      return count;
    });
    bus.publish('session.deleted', { session: id, participants: audienceOf(session) });
    log.info('chat.session.deleted', { session: id, by, messages: removed });
    return true;
  }

  async messages(session: SessionId, viewer: ActorId, query: Compact<Omit<MessageListQuery, 'session'>>): Promise<Page<ChatMessage>> {
    await this.require(session, viewer);
    const page = await this.#deps.store.table('messages').find({
      where: { session }, order: [['createdAt', 'desc']], limit: query.limit ?? this.#deps.settings.chat.HARNESS_MESSAGE_PAGE, cursor: query.cursor,
    });
    return { items: page.items.map((m) => this.#streams.overlay(m)), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
  }

  async controls(session: SessionId): Promise<SessionControls> {
    const active = await this.#active(session);
    const last = (await this.#deps.store.table('turns').find({ where: { session }, order: [['createdAt', 'desc']], limit: 1 })).items[0];
    return {
      pause: active.some((r) => r.allowed.pause && r.status !== 'paused'),
      cancel: active.some((r) => r.allowed.cancel),
      uncancellable: active.filter((r) => !r.allowed.cancel).map((r) => r.id),
      undoLastTurn: active.length === 0 && last !== undefined && (last.status === 'done' || last.status === 'failed' || last.status === 'cancelled'),
      runs: active.map((r) => ({ run: r.id, fn: r.fn, status: r.status, pause: r.allowed.pause && r.status !== 'paused', resume: r.status === 'paused', cancel: r.allowed.cancel })),
    };
  }

  async control(session: SessionId, action: SessionControlAction, by: ActorId, runs?: readonly RunId[]): Promise<SessionControls> {
    await this.require(session, by);
    const chosen = runs === undefined ? undefined : new Set(runs);
    const all = await this.#active(session);
    const active = all.filter((run) => chosen === undefined || chosen.has(run.id));
    const results = await Promise.all(active.map(async (run): Promise<boolean> => {
      switch (action) {
        case 'pause': return run.allowed.pause && run.status !== 'paused' ? (await this.#deps.runs.pause(run.id, by)).accepted : false;
        case 'cancel': return run.allowed.cancel ? (await this.#deps.runs.cancel(run.id, by)).accepted : false;
        case 'resume':
          if (run.status !== 'paused') { return false; }
          await this.#deps.runs.resume(run.id, by);
          return true;
      }
    }));
    const accepted = results.filter(Boolean).length;
    // the session reads paused once every run that can pause is (pausing one of several leaves it running)
    const pausedNow = new Set(active.filter((_, i) => action === 'pause' && results[i] === true).map((run) => run.id));
    const allPaused = all.filter((run) => run.allowed.pause).every((run) => run.status === 'paused' || pausedNow.has(run.id));
    if (accepted > 0 && action !== 'cancel') { await this.save(session, { status: action === 'pause' && allPaused ? 'paused' : 'running' }); }
    this.#deps.log.info('chat.session.control', { session, action, by, runs: active.length, accepted, chosen: runs?.length });
    const controls = await this.controls(session);
    this.#deps.bus.publish('session.controls', { session, controls });
    return controls;
  }

  /**
   * Send a session's controls again whenever one of its runs starts, settles, pauses or changes what it allows, so
   * the stop and pause menu lists the runs of a turn while it runs. Updates in one tick go out as one. The unsubscribe.
   */
  follow(): () => void {
    const due = new Set<SessionId>();
    return this.#deps.bus.subscribe('run.update', ({ session, update }) => {
      if (session === undefined || (update.type !== 'status' && update.type !== 'allowed') || due.has(session)) { return; }
      due.add(session);
      queueMicrotask(() => {
        due.delete(session);
        this.controls(session).then(
          (controls) => { this.#deps.bus.publish('session.controls', { session, controls }); },
          (error: unknown) => { this.#deps.log.warn('chat.session.controls.failed', { session, error: messageOf(error) }); },
        );
      });
    });
  }

  async presence(presence: Omit<Presence, 'lastActiveAt'>): Promise<void> {
    await this.require(presence.session, presence.user);
    this.#presence.report(presence);
  }

  async active(session: SessionId): Promise<boolean> {
    return Promise.resolve(this.#presence.active(session));
  }

  /** A session the actor is in; refused as not found otherwise (so its existence isn't revealed). */
  async require(id: SessionId, actor: ActorId): Promise<Session> {
    const session = await this.get(id, actor);
    if (session === undefined) { throw new ChatError('not-found', 'No such session.'); }
    return session;
  }

  /** Change some of a session's fields (and its `updatedAt`), and tell its people. */
  async load(id: SessionId, loaded: { tools?: readonly QualifiedName[]; context?: readonly QualifiedName[] }): Promise<Session> {
    const updated = await this.save(id, { ...(loaded.tools === undefined ? {} : { tools: [...loaded.tools] }), ...(loaded.context === undefined ? {} : { context: [...loaded.context] }) });
    this.#deps.log.info('chat.session.loaded', { session: id, tools: updated.tools.length, context: updated.context.length });
    return updated;
  }

  async save(id: SessionId, patch: Partial<Omit<Session, 'id' | 'updatedAt'>>): Promise<Session> {
    const session = await this.#deps.store.table('sessions').update(id, { ...patch, updatedAt: this.#deps.clock() });
    this.#changed(session);
    return session;
  }

  async #setPriority(session: SessionId, priority: Priority, by: ActorId): Promise<void> {
    const rules = this.#deps.store.table('priorityRules');
    const id = sessionPriorityRule(session);
    const existing = await rules.get(id);
    await rules.put({ ...(existing ?? {}), id, target: { scope: 'session', session }, default: priority, setBy: by });
  }

  /** Take the session's own model, mode, contextor or fn mode away (each `true` one), so its agent fn's choice applies again. */
  async #clear(session: Session, clear: { readonly model: boolean; readonly mode: boolean; readonly contextor: boolean; readonly fnMode: boolean }): Promise<Session> {
    const { model, mode, contextor, fnMode, ...rest } = session;
    const gone = (clear.model && model !== undefined) || (clear.mode && mode !== undefined) || (clear.contextor && contextor !== undefined) || (clear.fnMode && fnMode !== undefined);
    if (!gone) { return session; }
    const cleared = await this.#deps.store.table('sessions').put({
      ...rest,
      ...(clear.model || model === undefined ? {} : { model }),
      ...(clear.mode || mode === undefined ? {} : { mode }),
      ...(clear.contextor || contextor === undefined ? {} : { contextor }),
      ...(clear.fnMode || fnMode === undefined ? {} : { fnMode }),
    });
    this.#changed(cleared);
    return cleared;
  }

  async #active(session: SessionId): Promise<Run[]> {
    return readAll(this.#deps.store.table('runs'), { where: { session, status: { in: ACTIVE_RUN_STATUSES } } }, MAX_ACTIVE_RUNS);
  }

  #changed(session: Session): void {
    this.#deps.bus.publish('session.changed', { session: SessionSummary.parse(session), participants: audienceOf(session) });
  }
}
