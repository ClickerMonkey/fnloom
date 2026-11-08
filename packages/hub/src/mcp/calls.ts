/**
 * One MCP tool call as a real run (`McpRunner`): a turn for the MCP's person (their limits, at interactive priority),
 * the run of the fn with that person as its actor and the MCP's actor as its caller (so policies, approvals, budgets,
 * the ledger and metrics all apply), a wait bounded by `HARNESS_HUB_MCP_ASK_TIMEOUT` while it needs approval and
 * `HARNESS_HUB_MCP_RUN_TIMEOUT` in all, the run cancelled when the client goes away, and the outcome as an MCP result:
 * done is its value (structured when it is an object), refused input is an error the model can correct, a failure or
 * a cancel is an error. Each MCP may start `HARNESS_HUB_MCP_RATE` calls a minute.
 */
import { errorResult, jsonResult, type McpCaller, type McpToolResult } from '@ayepi/mcp';
import type { Logger } from '@ayepi/log';
import type { Limiter } from '@ayepi/rate';
import { mintId, messageOf, problemLine, UserView, type HubMcp, type InputProblem, type InstanceName, type Json, type QualifiedName, type Run, type RunId, type Turn } from '@harness/core';
import { userInfo } from '../api/web/access.ts';
import type { LimitResolver, RunService } from '../execution/index.ts';
import { timeInfo } from '../execution/time.ts';
import type { HubStore } from '../store/index.ts';
import type { McpEnv } from './env.ts';

/** What the runner uses. */
export interface McpRunnerDeps {
  readonly store: HubStore;
  readonly runs: () => Pick<RunService, 'start' | 'get' | 'cancel'>;
  readonly limits: () => Pick<LimitResolver, 'resolve'>;
  readonly rate: Limiter;
  readonly clock: () => number;
  readonly log: Logger;
  readonly settings: Pick<McpEnv, 'HARNESS_HUB_MCP_ASK_TIMEOUT' | 'HARNESS_HUB_MCP_RUN_TIMEOUT'>;
  /** Wait (tests make it instant); the default is a timer. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The text a model reads for refused input: each problem at its path. */
export function problemsText(run: Pick<Run, 'fn'>, problems: readonly InputProblem[]): string {
  const lines = problems.map((p) => `- ${problemLine(p)}`);
  return `The input for ${run.fn} was refused; fix it and call again:\n${lines.join('\n')}`;
}

/** A settled run as an MCP result. */
export function resultOf(run: Run): McpToolResult {
  const outcome = run.outcome;
  if (outcome === undefined) return errorResult(`${run.fn} did not finish.`);
  switch (outcome.status) {
    case 'done': return jsonResult(outcome.result);
    case 'invalid-input': return errorResult(problemsText(run, outcome.invalid.problems));
    case 'failed': return errorResult(outcome.error.message);
    case 'cancelled': return errorResult(`${run.fn} was cancelled.`);
    case 'paused': return errorResult(`${run.fn} was paused; it goes on later.`);
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
    function done(): void { clearTimeout(timer); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Runs MCP tool calls. */
export class McpRunner {
  readonly #deps: McpRunnerDeps & Required<Pick<McpRunnerDeps, 'sleep'>>;

  constructor(deps: McpRunnerDeps) {
    this.#deps = { ...deps, sleep: deps.sleep ?? wait };
  }

  /** Run `fn` with `args` for an MCP's client (on a fleet's instance `on`, when named) and answer with its outcome. */
  async call(mcp: HubMcp, fn: QualifiedName, args: Json, caller: McpCaller, signal: AbortSignal, on?: InstanceName): Promise<McpToolResult> {
    const { log, clock } = this.#deps;
    const rate = await this.#deps.rate.check(mcp.id, { now: clock() });
    if (!rate.allowed) {
      log.warn('mcp.call.refused', { mcp: mcp.id, fn, reason: 'rate' });
      return errorResult(`Too many calls on this MCP; try again in ${Math.ceil(rate.retryAfter / 1000)} s.`);
    }
    let turn: Turn;
    try {
      turn = await this.#turn(mcp);
    } catch (error) {
      log.warn('mcp.call.refused', { mcp: mcp.id, fn, reason: messageOf(error) });
      return errorResult(messageOf(error));
    }
    let started: { run: RunId; settled: Promise<unknown> };
    try {
      started = await this.#deps.runs().start({
        fn, args, turn: turn.id, key: `mcp:${caller.session}`, actor: mcp.user, caller: mcp.actor, priority: turn.limits.priority, background: false, handlers: [],
        ...(on === undefined ? {} : { on }),
      });
    } catch (error) {
      await this.#end(turn, 'failed');
      log.warn('mcp.call.refused', { mcp: mcp.id, fn, reason: messageOf(error) });
      return errorResult(messageOf(error));
    }
    log.info('mcp.call', { mcp: mcp.id, fn, run: started.run, label: caller.auth?.subject ?? 'secret', session: caller.session });
    await this.#store(turn, started.run);
    const answer = await this.#await(mcp, started.run, started.settled, signal);
    const run = await this.#deps.runs().get(started.run);
    await this.#end(turn, run?.status === 'done' ? 'done' : run?.status === 'cancelled' ? 'cancelled' : 'failed');
    if (answer !== undefined) return answer;
    return run === undefined ? errorResult(`The run of ${fn} is gone.`) : resultOf(run);
  }

  /**
   * Wait for the run to settle; an answer of its own when the wait ends first (the client left, approval took too
   * long, or the call ran out of time), after cancelling the run.
   */
  async #await(mcp: HubMcp, run: RunId, settled: Promise<unknown>, signal: AbortSignal): Promise<McpToolResult | undefined> {
    const { settings, sleep } = this.#deps;
    const stop = new AbortController();
    const outcome = await new Promise<'settled' | 'gone' | 'unapproved' | 'timeout'>((resolve) => {
      settled.then(() => { resolve('settled'); }, () => { resolve('settled'); });
      if (signal.aborted) resolve('gone');
      else signal.addEventListener('abort', () => { resolve('gone'); }, { once: true });
      void sleep(settings.HARNESS_HUB_MCP_ASK_TIMEOUT, stop.signal).then(async () => {
        if (!stop.signal.aborted && (await this.#deps.runs().get(run))?.status === 'awaiting-approval') resolve('unapproved');
      });
      void sleep(settings.HARNESS_HUB_MCP_RUN_TIMEOUT, stop.signal).then(() => { if (!stop.signal.aborted) resolve('timeout'); });
    });
    stop.abort();
    if (outcome === 'settled') return undefined;
    await this.#deps.runs().cancel(run, mcp.user);
    this.#deps.log.info('mcp.call.ended', { mcp: mcp.id, run, why: outcome });
    switch (outcome) {
      case 'gone': return errorResult('The call was cancelled by the client.');
      case 'unapproved': return errorResult('The call was not approved in time.');
      case 'timeout': return errorResult('The call took too long and was stopped.');
    }
  }

  /** A turn for one call, for the MCP's person with their limits. */
  async #turn(mcp: HubMcp): Promise<Turn> {
    const { store, clock } = this.#deps;
    const actor = await store.table('actors').get(mcp.user);
    if (actor?.kind !== 'user' || actor.disabled) throw new Error('This MCP\'s person can no longer use the hub.');
    const user = await userInfo({ store }, UserView.parse(actor));
    const limits = await this.#deps.limits().resolve({ user, requested: 'interactive' });
    const now = clock();
    return store.table('turns').insert({
      id: mintId('turn'), actor: mcp.user, user, time: timeInfo(now, user.timeZone), status: 'running', limits, cost: 0, errors: { max: 1 }, createdAt: now,
    });
  }

  /** The turn's root run. */
  async #store(turn: Turn, root: RunId): Promise<void> {
    await this.#deps.store.table('turns').update(turn.id, { root });
  }

  /** The call ended: so did its turn. */
  async #end(turn: Turn, status: 'done' | 'failed' | 'cancelled'): Promise<void> {
    await this.#deps.store.table('turns').update(turn.id, { status, endedAt: this.#deps.clock() });
  }
}
