/**
 * The LLM gateway: how systems call an LLM. A system's aeye `AI` forwards every request to the hub over its link
 * (the hub is an aeye provider for systems), and the hub runs it like its own calls: on the LLM queue at the run's
 * priority, through the hub AI's hooks (rate limits, budget reservation and settlement, the saved interaction), and
 * against the model the hub picks. What streams back is the schema descriptors the provider chose (so the system's
 * aeye decodes strict-mode output with its own schemas), the chunks, and the real cost.
 */
import type { Request } from '@aeye/core';
import { retry } from '@ayepi/core/retry';
import { isSettled, type LlmForward, type LlmForwardChunk, type ModelInfo, type Run, type RunId, type TurnId, type Usd } from '@harness/core';
import { Channel } from './channel.ts';
import { BudgetRefused, causeOf, LlmRateLimited, messageOf } from './errors.ts';
import type { LlmGateway } from './index.ts';
import type { ModelResolver } from './models.ts';
import type { ExecutionDeps, LlmEngine } from './ports.ts';
import { transientDelay, type ExecutionQueues } from './queues.ts';
import { LlmCallScope } from './scope.ts';
import { chunkToWire, descriptorsOf, requestFromWire } from './wire.ts';

/** How many times a forwarded request waits out a rate limit before it gives up. */
const TRANSIENT_TRIES = 3;

/** What the gateway uses. */
export interface GatewayDeps extends Pick<ExecutionDeps, 'store' | 'clock' | 'log' | 'settings'> {
  readonly runs: { get(run: RunId): Promise<Run | undefined> };
  readonly queues: Pick<ExecutionQueues, 'llm'>;
  readonly llm: LlmEngine;
  readonly models: Pick<ModelResolver, 'resolve'>;
  /** Wait between attempts; rejects when the signal aborts (default `abortableSleep`). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Why a signal aborted, as an error. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('stopped', { cause: signal.reason });
}

/** Resolves after `ms`, or rejects with the abort reason as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError(signal)); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    function stop(): void { clearTimeout(timer); reject(abortError(signal)); }
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** The kind of a forwarded failure, as the system's aeye classifies it. */
function errorKind(error: unknown): 'limit' | 'provider' {
  return causeOf(error, BudgetRefused) !== undefined || causeOf(error, LlmRateLimited) !== undefined ? 'limit' : 'provider';
}

/** The hub's LLM gateway. */
export class HubLlmGateway implements LlmGateway {
  readonly #deps: GatewayDeps & Required<Pick<GatewayDeps, 'sleep'>>;

  constructor(deps: GatewayDeps) {
    this.#deps = { ...deps, sleep: deps.sleep ?? abortableSleep };
  }

  async *forward(input: LlmForward & { system: string; turn?: TurnId }, signal: AbortSignal): AsyncIterable<LlmForwardChunk> {
    const scope = await this.#scope(input.run, input.system);
    if (typeof scope === 'string') {
      yield { type: 'error', kind: 'limit', message: scope };
      return;
    }
    let request: Request;
    try {
      request = requestFromWire(input.request);
    } catch (error) {
      yield { type: 'error', kind: 'tool', message: messageOf(error) };
      return;
    }
    const metadata = await this.#deps.models.resolve(input.model);
    const channel = new Channel<LlmForwardChunk>();
    let sent = false;
    /** One attempt, holding an LLM slot only while it calls. */
    const attempt = () => this.#deps.queues.llm(scope.priority, async () => {
      for await (const chunk of this.#deps.llm.streamer(request, { call: scope }, metadata, signal)) {
        if (!sent) channel.push({ type: 'descriptors', ...descriptorsOf(request) });
        sent = true;
        scope.markFirstToken(this.#deps.clock());
        channel.push({ type: 'chunk', chunk: chunkToWire(chunk) });
      }
      const last = scope.last;
      if (last === undefined) throw new Error('the call finished without being recorded');
      channel.push({ type: 'done', usage: last.usage, cost: scope.cost, interaction: last.interaction, model: last.model });
    });
    // a transient limit (rate, budget wait) is retried after the wait it names, between attempts, so the wait holds no
    // slot; nothing is retried once a chunk went out or the caller stopped
    const task = retry(attempt, {
      attempts: TRANSIENT_TRIES, base: 0, jitter: 0,
      on: (error) => (sent || signal.aborted ? false : transientDelay(error) ?? false),
      sleep: (ms) => this.#deps.sleep(ms, signal),
    }).catch((error: unknown) => {
      this.#deps.log.warn('llm.forward-failed', { run: scope.run, system: input.system, error: messageOf(error) });
      channel.push({ type: 'error', kind: errorKind(error), message: messageOf(error) });
    }).finally(() => { channel.close(); });
    yield* channel;
    await task;
  }

  async embed(texts: readonly string[], run?: RunId): Promise<{ vectors: number[][]; cost: Usd }> {
    const scope = run === undefined ? undefined : await this.#scope(run, undefined);
    if (typeof scope === 'string') throw new Error(scope);
    return this.#deps.llm.embed(texts, scope);
  }

  models(): Promise<ModelInfo[]> {
    return Promise.resolve(this.#deps.llm.models());
  }

  canTranscribe(): boolean {
    return this.#deps.settings.model.HARNESS_TRANSCRIBE_MODEL !== '';
  }

  async transcribe(audio: Uint8Array): Promise<string> {
    const model = this.#deps.settings.model.HARNESS_TRANSCRIBE_MODEL;
    if (model === '') throw new Error('no transcription model is set (HARNESS_TRANSCRIBE_MODEL)');
    return this.#deps.llm.transcribe(audio, model);
  }

  /** The scope that pays for a call made inside a run (by its system, when one forwarded it); a reason when there is none. */
  async #scope(id: RunId | undefined, system: string | undefined): Promise<LlmCallScope | string> {
    if (id === undefined) return 'LLM calls from a system must be made inside a run.';
    const run = await this.#deps.runs.get(id);
    if (run === undefined) return `There is no run ${id}.`;
    if (system !== undefined && run.system !== system) return `Run ${id} is not ${system}'s.`;
    if (isSettled(run.status)) return `Run ${id} has already finished.`;
    const turn = await this.#deps.store.table('turns').get(run.turn);
    if (turn === undefined) return `Run ${id} names no turn.`;
    return new LlmCallScope({
      run: run.id, turn: run.turn, session: run.session, system: run.system, fn: run.fn, actor: run.actor, iteration: 0, priority: run.priority,
      limits: turn.limits, queuedAt: this.#deps.clock(),
    });
  }
}
