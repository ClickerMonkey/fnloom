/**
 * Handlers: callbacks a fn's caller supplies ("confirm overwrite?", "pick a file"). When a run calls one, the hub
 * relays it to whoever made the call: the system whose run called it (over its link, with the call key so its
 * concurrent calls stay apart), or a person (a form in the chat, answered with `answer`). The person answers both for
 * runs they started and for runs an agent called on their behalf, since an agent can't fill in a form. Every handler
 * call is recorded.
 */
import {
  mintId, type ActorId, type GinTypeDef, type HandlerAnswer, type HandlerCall, type HandlerCallId, type Json, type Run, type RunId,
} from '@harness/core';
import type { HandlerAnswers } from '../boot/index.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import { fnError, messageOf } from './errors.ts';
import type { ExecutionDeps } from './ports.ts';
import type { HubRunService } from './runs.ts';
import { AGENT_KIND } from './index.ts';

/** Who answers a run's handlers: a calling system's run, a person, or nobody (a hub fn called it). */
export type HandlerAnswerer = { system: Run['system']; run: RunId } | { user: ActorId } | undefined;

/**
 * The answerer of a run's handlers, from the run's parent: the turn's person when they started it or an agent called
 * it for them, the calling system's run, or none when a hub fn called it.
 */
export function answererOf(parent: Run | undefined, turnUser: ActorId): HandlerAnswerer {
  if (parent === undefined || parent.kind === AGENT_KIND) return { user: turnUser };
  if (parent.system === HUB_SYSTEM) return undefined;
  return { system: parent.system, run: parent.id };
}

/** What the relay uses. */
export interface HandlerRelayDeps extends Pick<ExecutionDeps, 'store' | 'bus' | 'link' | 'catalog' | 'clock' | 'random' | 'log'> {
  readonly runs: Pick<HubRunService, 'get' | 'handlersOf'>;
}

/** Relays handler calls and takes people's answers. */
export class HandlerRelay implements HandlerAnswers {
  readonly #deps: HandlerRelayDeps;
  readonly #waiting = new Map<HandlerCallId, (answer: HandlerAnswer) => void>();

  constructor(deps: HandlerRelayDeps) {
    this.#deps = deps;
  }

  /** A run calls one of its caller's handlers; resolves with the answer. */
  async handle(input: { run: RunId; handler: string; args: Json }, signal: AbortSignal): Promise<HandlerAnswer> {
    const { runs, catalog, store } = this.#deps;
    const run = await runs.get(input.run);
    if (run === undefined) return refused(`There is no run ${input.run}.`);
    const fn = await catalog.fn(run.fn);
    const decl = fn?.decl.handlers[input.handler];
    if (decl === undefined) return refused(`${run.fn} declares no handler ${input.handler}.`);
    if (!runs.handlersOf(run.id).includes(input.handler)) return refused(`The caller of ${run.fn} doesn't answer ${input.handler}.`);
    const parent = run.parent === undefined ? undefined : await runs.get(run.parent);
    const turn = await store.table('turns').get(run.turn);
    const answerer = answererOf(parent, turn?.user.id ?? run.actor);
    if (answerer === undefined) return refused(`The hub fn that called ${run.fn} can't answer ${input.handler}.`);
    const call: HandlerCall = {
      id: mintId('handlerCall', this.#deps.random),
      run: run.id,
      handler: input.handler,
      args: input.args,
      decl: { description: decl.description, args: decl.args, returns: decl.returns },
      answerer,
      status: 'pending',
      createdAt: this.#deps.clock(),
    };
    await store.table('handlerCalls').insert(call);
    // a person who just approved this run has said yes already: its "go ahead?" question is answered for them
    const approvedBy = 'user' in answerer && isConfirmation(decl.returns) ? await this.#approvedBy(run, answerer.user) : false;
    if (approvedBy) this.#deps.log.info('run.handler.approved-before', { run: run.id, handler: input.handler, call: call.id });
    const answer: HandlerAnswer = approvedBy ? { ok: true, value: true }
      : 'system' in answerer ? await this.#ask(call, answerer, parent, signal) : await this.#wait(call, run, signal);
    await this.#record(call, run, answer);
    return answer;
  }

  /** A person answers a handler call they were asked. The value is checked against the handler's declared type. */
  async answer(id: HandlerCallId, value: Json, by: ActorId): Promise<void> {
    const call = await this.#deps.store.table('handlerCalls').get(id);
    if (call === undefined) throw new Error(`There is no handler call ${id}.`);
    if (call.status !== 'pending') throw new Error(`Handler call ${id} has already been answered.`);
    if (!('user' in call.answerer) || call.answerer.user !== by) throw new Error(`${by} wasn't asked handler call ${id}.`);
    const run = await this.#deps.runs.get(call.run);
    if (run === undefined) throw new Error(`Handler call ${id} names no run.`);
    const problems = await this.#deps.catalog.check(run.system, call.decl.returns, value);
    if (problems.length > 0) throw new Error(`That answer doesn't fit: ${problems.join('; ')}`);
    const resolve = this.#waiting.get(id);
    if (resolve === undefined) throw new Error(`Nothing is waiting for handler call ${id} anymore.`);
    resolve({ ok: true, value });
  }

  /**
   * Ask a person something on behalf of a hub fn (`hub/ask_user`) and wait for the answer: a handler call they answer
   * in the chat, recorded like any other.
   */
  async askPerson(input: { run: Run; user: ActorId; handler: string; args: Json; decl: HandlerCall['decl'] }, signal: AbortSignal): Promise<HandlerAnswer> {
    const call: HandlerCall = {
      id: mintId('handlerCall', this.#deps.random), run: input.run.id, handler: input.handler, args: input.args, decl: input.decl,
      answerer: { user: input.user }, status: 'pending', createdAt: this.#deps.clock(),
    };
    await this.#deps.store.table('handlerCalls').insert(call);
    const answer = await this.#wait(call, input.run, signal);
    await this.#record(call, input.run, answer);
    return answer;
  }

  /** Whether `user` approved this run (its approval's last decision is theirs, and it was approved). */
  async #approvedBy(run: Run, user: ActorId): Promise<boolean> {
    const page = await this.#deps.store.table('approvals').find({ where: { run: run.id, status: 'approved' }, order: [['createdAt', 'desc']], limit: 1 });
    return page.items[0]?.decisions.at(-1)?.by === user;
  }

  /** Ask the system whose run made the call. */
  async #ask(call: HandlerCall, answerer: { system: Run['system']; run: RunId }, parent: Run | undefined, signal: AbortSignal): Promise<HandlerAnswer> {
    const connection = this.#deps.link.connection(answerer.system);
    if (connection === undefined || parent === undefined) return { ok: false, error: fnError('retry', `${answerer.system} is not connected`, 'unavailable') };
    try {
      return await connection.peer.call('handler', { call: call.id, run: answerer.run, key: (await this.#deps.runs.get(call.run))?.key ?? '', handler: call.handler, args: call.args }, { signal });
    } catch (error) {
      return { ok: false, error: fnError('retry', messageOf(error)) };
    }
  }

  /** Show the call to the person and wait for their answer (or the run stopping). */
  #wait(call: HandlerCall, run: Run, signal: AbortSignal): Promise<HandlerAnswer> {
    return new Promise<HandlerAnswer>((resolve) => {
      const done = (answer: HandlerAnswer): void => {
        this.#waiting.delete(call.id);
        signal.removeEventListener('abort', stop);
        resolve(answer);
      };
      const stop = (): void => { done({ ok: false, error: fnError('fatal', 'the run stopped before the person answered', 'stopped') }); };
      this.#waiting.set(call.id, done);
      signal.addEventListener('abort', stop, { once: true });
      this.#deps.bus.publish('handler', { call, ...(run.session === undefined ? {} : { session: run.session }) });
    });
  }

  async #record(call: HandlerCall, run: Run, answer: HandlerAnswer): Promise<void> {
    const updated = await this.#deps.store.table('handlerCalls').update(call.id, answer.ok ? { status: 'answered', result: answer.value } : { status: 'failed' });
    this.#deps.bus.publish('handler', { call: updated, ...(run.session === undefined ? {} : { session: run.session }) });
    this.#deps.log.info('run.handler', { run: run.id, handler: call.handler, call: call.id, ok: answer.ok });
  }
}

/** Whether a handler is a yes-or-no question (it returns a bool): a confirmation an approval already answers. */
export function isConfirmation(returns: GinTypeDef): boolean {
  return returns.name === 'bool';
}

function refused(message: string): HandlerAnswer {
  return { ok: false, error: fnError('caller', message, 'no-handler') };
}
