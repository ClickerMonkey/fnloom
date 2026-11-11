/**
 * The agent loop: every `hub/llm` run is an aeye `Prompt`, run one iteration per queued LLM job. An iteration renders
 * the agent's instructions and context, offers its tools (built from fn signatures), and streams one model answer
 * (aeye retries bad tool arguments and bad output inside the job). Each tool call the model makes suspends the prompt
 * and becomes a queued run; when every run of the iteration has settled or gone to the background, the next job
 * continues from the saved conversation with the results appended. The run ends when the model answers without
 * tool calls. A system's agent with an output hook (`validate.output`) has its answer checked by its system first: a
 * refusal goes back to the model to answer again, as many times as `HARNESS_VALIDATE_RETRIES` allows, then fails it.
 *
 * A session's agent continues the session's transcript and streams its answer into an assistant message; any other
 * agent keeps its conversation on its run. The run's `resume` holds the loop's state (`AgentState`), so a pause, a
 * cancel or a restart picks up exactly where it was.
 */
import { Prompt, type Context, type Message, type PromptInput, type Request, type Usage } from '@aeye/core';
import { LlmPayloadType, parseValue } from '@harness/sdk';
import {
  isSettled, Json, LlmMessage, MessageId, ModelChoice, QualifiedName, RunId, SelectionReport, splitName, type ActorId, type FnError, type FnRecord, type InvalidInput, type OutcomeWire, type Run,
  type RunSettled, type Session, type RunControlAction,
} from '@harness/core';
import { z } from 'zod';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { FnSignature } from '../catalog/index.ts';
import type { MessageEnricher } from '../chat/index.ts';
import type { CallPlan, ExposedTo, ModelCallOut, PromptPlanner } from '../contextor/index.ts';
import { AUTO_MODEL } from '../contextor/limits.ts';
import { parseRunBlocks, problemLines, resultText, RunBlockFilter, splitThinking, ThinkingFilter } from '../contextor/render.ts';
import { causeOf, fnError, messageOf, RunRefused } from './errors.ts';
import { OUTPUT_REFUSED, SystemGone } from './executors.ts';
import { rows } from './pages.ts';
import { AGENT_KIND, type AgentKind, type AgentLoop, type RunInput } from './index.ts';
import type { ModelResolver } from './models.ts';
import type { ControlAnswer, Conversation, ExecutionDeps, ExecutionJob, LlmEngine, RunExecutor } from './ports.ts';
import { transientDelay, type ExecutionQueues } from './queues.ts';
import { settledOf, type HubRunService } from './runs.ts';
import { LlmCallScope, type HubCallContext, type HubCallMetadata } from './scope.ts';
import { agentTools, PendingCalls } from './tools.ts';
import { isObjectSchema, messageFromWire, messageToWire, replyText, toolName } from './wire.ts';

/** One call of the last iteration (a native tool call, or a `<run>` block), and the run it became (or why it didn't). */
export const PendingCall = z.object({
  toolCallId: z.string(),
  /** The fn it runs; for a call refused before it ran, the name the model gave. */
  fn: z.string(),
  run: RunId.optional(),
  error: z.string().optional(),
  /** Refused before it ran (invalid input): the reply the model reads, with what was wrong. */
  invalid: z.string().optional(),
  /** It came as a `<run>` block in the model's text, so its reply goes back as a `<result>` message. */
  block: z.boolean().optional(),
});
export type PendingCall = z.infer<typeof PendingCall>;

/** The agent loop's state, kept on the agent run (`run.resume`). */
export const AgentState = z.object({
  /** The next iteration to run. */
  iteration: z.number().int().min(0),
  /** The tool calls of the last iteration, in call order, waiting to be answered. */
  pending: z.array(PendingCall),
  /** Where the assistant message holding those calls is in the conversation. */
  anchor: z.number().int(),
  /** Iterations in a row whose tool calls all failed. */
  failures: z.number().int().min(0),
  /** The conversation, for an agent that isn't a session's (a session's agent continues the session's transcript). */
  messages: z.array(LlmMessage).optional(),
  /** The assistant message a session's agent streams its answer into. */
  message: MessageId.optional(),
  /** Whether a session's agent has put its turn's user message into the transcript. */
  seeded: z.boolean().optional(),
  /** What the contextor chose for this message, so later and retried iterations keep it (`perMessage`). */
  selection: SelectionReport.optional(),
  /** Answers its fn's output hook sent back so far (a system's agent with `validate.output`). */
  refusals: z.number().int().min(0).optional(),
});
export type AgentState = z.infer<typeof AgentState>;

/** What an agent's earlier run says when a new message takes over. */
export const INTERRUPTED = 'A new message came in; carrying on there.';

/** A fresh agent's state. */
export const START: AgentState = { iteration: 0, pending: [], anchor: -1, failures: 0 };

/** The marker a tool call gets when its run goes to the background. */
export function backgroundReply(run: RunId): string {
  return `Running in the background as run ${run}; its result will be posted when it finishes.`;
}

/** What the model reads for a settled tool run. */
export function settledReply(settled: RunSettled): string {
  switch (settled.status) {
    case 'done': return replyText(settled.result);
    case 'failed': return `Error: ${settled.error.message}`;
    case 'cancelled': return 'The run was cancelled before it finished.';
    case 'background': return backgroundReply(settled.run);
  }
}

/** A session agent's conversation: the session's transcript, which chat appends each user message to. */
export class SessionConversation implements Conversation {
  readonly #deps: Pick<ExecutionDeps, 'store'>;
  readonly #session: Session['id'];

  constructor(deps: Pick<ExecutionDeps, 'store'>, session: Session['id']) {
    this.#deps = deps;
    this.#session = session;
  }

  async messages(): Promise<LlmMessage[]> {
    return (await this.#deps.store.table('sessions').get(this.#session))?.transcript ?? [];
  }

  append(messages: readonly LlmMessage[]): Promise<number> {
    return this.#change((transcript) => {
      const at = transcript.length;
      return { transcript: [...transcript, ...messages], result: at };
    });
  }

  answer(anchor: number, replies: readonly LlmMessage[]): Promise<void> {
    return this.#change((transcript) => ({ transcript: [...transcript.slice(0, anchor + 1), ...replies, ...transcript.slice(anchor + 1)], result: undefined }));
  }

  async #change<T>(change: (transcript: LlmMessage[]) => { transcript: LlmMessage[]; result: T }): Promise<T> {
    return this.#deps.store.tx(async (tx) => {
      const session = await tx.table('sessions').get(this.#session);
      if (session === undefined) throw new Error(`no session ${this.#session}`);
      const { transcript, result } = change(session.transcript);
      await tx.table('sessions').update(session.id, { transcript });
      return result;
    });
  }
}

/** Any other agent's conversation: kept in its state, saved with it. */
export class RunConversation implements Conversation {
  #messages: LlmMessage[];

  constructor(messages: readonly LlmMessage[]) {
    this.#messages = [...messages];
  }

  get saved(): LlmMessage[] {
    return [...this.#messages];
  }

  messages(): Promise<LlmMessage[]> {
    return Promise.resolve([...this.#messages]);
  }

  append(messages: readonly LlmMessage[]): Promise<number> {
    const at = this.#messages.length;
    this.#messages.push(...messages);
    return Promise.resolve(at);
  }

  answer(anchor: number, replies: readonly LlmMessage[]): Promise<void> {
    this.#messages.splice(anchor + 1, 0, ...replies);
    return Promise.resolve();
  }
}

/** What the agent loop uses. */
export interface AgentLoopDeps extends ExecutionDeps {
  readonly runs: Pick<HubRunService, 'start' | 'get' | 'wait' | 'settle' | 'background' | 'cancel' | 'info'>;
  readonly queues: Pick<ExecutionQueues, 'enqueueLlm' | 'cancel'>;
  readonly llm: Pick<LlmEngine, 'streamer'>;
  readonly models: Pick<ModelResolver, 'resolve'>;
  /** How a chat message reads to the LLM (mentions, extras and hooks as tagged blocks). */
  readonly enrich: Pick<MessageEnricher, 'render'>;
  /** What each prompt holds, within the model's limits, and what the model's calls mean. */
  readonly planner: Pick<PromptPlanner, 'plan' | 'interpret' | 'exposed' | 'settled'>;
}

/** An agent's prompt; it logs when aeye's `forget` drops messages, which the planner's budget should never let happen. */
class AgentPrompt extends Prompt<HubCallContext, HubCallMetadata, 'agent', AgentInput, AgentOutput, [], AgentOutput> {
  readonly #forgot: (dropped: number) => void;

  constructor(input: PromptInput<HubCallContext, HubCallMetadata, 'agent', AgentInput, AgentOutput, [], AgentOutput>, forgot: (dropped: number) => void) {
    super(input);
    this.#forgot = forgot;
  }

  protected override forget(request: Request, ctx: Context<HubCallContext, HubCallMetadata>, usage?: Usage): Message[] {
    const kept = super.forget(request, ctx, usage);
    if (kept.length < request.messages.length) this.#forgot(request.messages.length - kept.length);
    return kept;
  }
}

/** The input an agent's instructions are rendered with. */
interface AgentInput {
  args: Json;
  context: string;
}

/** An agent's answer: text, or a structured value (wrapped in `result` when it isn't an object). */
type AgentOutput = string | object;

/** How one iteration went. */
type IterationEnd = 'waiting-for-tools' | 'done' | { failed: FnError };

/** The agent loop, also the executor of `hub/llm` runs. */
export class HubAgentLoop implements AgentLoop, RunExecutor {
  readonly #deps: AgentLoopDeps;
  readonly #iterating = new Map<RunId, AbortController>();
  readonly #jobs = new Map<RunId, string>();
  readonly #agents = new Map<QualifiedName, ActorId>();

  constructor(deps: AgentLoopDeps) {
    this.#deps = deps;
  }

  async start(input: RunInput & { kind: AgentKind }): Promise<{ run: RunId }> {
    const { kind: _kind, ...run } = input;
    const started = await this.#deps.runs.start(run);
    return { run: started.run };
  }

  /**
   * The run worker dequeued an agent run (new, or resumed): queue its next iteration, after its tool calls settle if
   * it was waiting on some. The loop settles the run itself.
   */
  async execute(job: ExecutionJob): Promise<'detached'> {
    const state = stateOf(job.run);
    if (state.pending.length === 0) {
      this.#queue(job.run, state.iteration);
    } else {
      const waiting = await this.#deps.store.table('runs').update(job.run.id, { status: 'waiting' });
      void this.#await(waiting, state);
    }
    return 'detached';
  }

  /** The LLM queue's handler: run one iteration; transient limits are rethrown so the queue defers the job. */
  async handle(job: { run: RunId; iteration: number }, signal: AbortSignal): Promise<void> {
    this.#jobs.delete(job.run);
    const end = await this.iterate(job.run, job.iteration, signal);
    if (typeof end === 'object') this.#deps.log.warn('agent.failed', { run: job.run, iteration: job.iteration, error: end.failed.message });
  }

  async iterate(id: RunId, iteration: number, signal: AbortSignal): Promise<IterationEnd> {
    const { runs, store, log } = this.#deps;
    const run = await runs.get(id);
    if (run === undefined || (run.status !== 'running' && run.status !== 'waiting')) return 'done';
    const state = stateOf(run);
    if (state.iteration !== iteration) return 'done';
    const controller = new AbortController();
    const stop = (): void => { controller.abort(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
    this.#iterating.set(id, controller);
    try {
      if (run.status === 'waiting') await store.table('runs').update(id, { status: 'running' });
      return await this.#iterate(run, state, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return 'done';
      if (transientDelay(error) !== undefined) throw error;
      const failed = fnError(causeOf(error, RunRefused)?.error.class ?? 'fatal', messageOf(error), 'agent');
      log.error('agent.error', { run: id, iteration, error: failed.message });
      const latest = await runs.get(id);
      await this.#fail(run, latest === undefined ? state : stateOf(latest), failed);
      return { failed };
    } finally {
      signal.removeEventListener('abort', stop);
      this.#iterating.delete(id);
    }
  }

  async #iterate(run: Run, given: AgentState, signal: AbortSignal): Promise<IterationEnd> {
    let state = given;
    const { catalog, store, clock } = this.#deps;
    const fn = await catalog.fn(run.fn);
    if (fn === undefined) throw new Error(`${run.fn} no longer exists`);
    const payload = parseValue(LlmPayloadType, fn.decl.payload);
    if (state.iteration >= payload.maxIterations) {
      const failed = fnError('fatal', `${run.fn} stopped after ${payload.maxIterations} iterations without an answer.`, 'max-iterations');
      await this.#fail(run, state, failed);
      return { failed };
    }
    const session = await this.#session(run);
    const conversation = this.#conversation(session, state);
    const turn = await store.table('turns').get(run.turn);
    if (turn === undefined) throw new Error(`run ${run.id} names no turn ${run.turn}`);
    if (session !== undefined && state.seeded !== true) {
      await this.#seed(conversation, turn.message);
      state = { ...state, seeded: true };
      await store.table('runs').update(run.id, { resume: Json.parse(state) });
    }
    // a chat's own model choice wins over the one its agent fn makes
    const metadata = await this.#deps.models.resolve(session?.model ?? ModelChoice.optional().parse(payload.model));
    const model = metadata.model ?? AUTO_MODEL;
    if (state.pending.length > 0) {
      // Answered and saved at once, so a job that runs again (after a rate limit) never answers twice.
      const replies = await this.#replies(state.pending, { session, agent: fn, model, access: await this.#deps.access.scope(turn.user.id) });
      await conversation.answer(state.anchor, replies.messages);
      state = { ...state, pending: [], failures: replies.allFailed ? state.failures + 1 : 0, ...this.#saved(conversation) };
      await store.table('runs').update(run.id, { resume: Json.parse(state) });
      if (replies.stopped !== undefined) {
        await this.#fail(run, state, replies.stopped);
        return { failed: replies.stopped };
      }
      if (state.failures >= this.#deps.settings.execution.HARNESS_AGENT_TOOL_FAILURES) {
        const failed = fnError('fatal', `${run.fn} stopped: its tool calls failed ${state.failures} times in a row.`, 'tool-failures');
        await this.#fail(run, state, failed);
        return { failed };
      }
    }
    const planned = await this.#deps.planner.plan({
      session, turn, agent: fn, model, instructions: payload.instructions, transcript: await conversation.messages(), cached: state.selection,
    });
    if (state.selection === undefined) {
      if (planned.considered !== undefined && session !== undefined && turn.message !== undefined) await this.#deps.turns.suggested(turn.message, planned.considered);
      state = { ...state, selection: planned.report };
      await store.table('runs').update(run.id, { resume: Json.parse(state) });
    }
    const calls = new PendingCalls();
    // an agent never calls itself: a session that loaded its fn would otherwise offer it back to it
    const own = toolName(fn.name);
    const tools = agentTools(planned.tools.filter((tool) => tool.name !== own), calls);
    const blocks = planned.rendered.protocol === 'text' ? new RunBlockFilter() : undefined;
    const signature = await catalog.signature(fn.name);
    const output = outputOf(signature);
    const message = session === undefined ? undefined : await this.#message(run, state, turn.message);
    if (message !== undefined && state.message !== message) {
      state = { ...state, message };
      await store.table('runs').update(run.id, { resume: Json.parse(state) });
    }
    const scope = new LlmCallScope({
      run: run.id, turn: run.turn, session: run.session, fn: run.fn, actor: run.actor, iteration: state.iteration, priority: run.priority, limits: turn.limits, queuedAt: clock(),
    });
    const prompt = new AgentPrompt({
      name: 'agent',
      description: fn.decl.description,
      content: `${payload.instructions}{{#if context}}\n\n{{{context}}}{{/if}}`,
      input: (input) => ({ args: input?.args ?? null, context: input?.context ?? '' }),
      schema: output.schema,
      // with tools, the answer's schema goes in the prompt: a wire schema makes many models answer at once instead of calling them
      schemaDelivery: tools.length > 0 ? 'prompt' : 'auto',
      config: { maxTokens: planned.maxTokens },
      retool: () => tools,
      toolExecution: payload.toolExecution,
      metadata,
    }, (dropped) => { this.#deps.log.warn('agent.forget', { run: run.id, iteration: state.iteration, model, dropped, estimate: planned.estimate }); });

    const collected: LlmMessage[] = [];
    let answer: AgentOutput | undefined;
    let suspended = false;
    let reasoning = '';
    const stream = (text: string): void => { if (message !== undefined && text !== '') this.#deps.turns.stream(message, { text }); };
    // thinking a model writes into its answer (`<think>…</think>`) streams as reasoning, never as the answer
    const thinking = new ThinkingFilter();
    const answerText = (split: { text: string; reasoning: string }): void => {
      if (message !== undefined && split.reasoning !== '') this.#deps.turns.stream(message, { reasoning: split.reasoning });
      stream(blocks === undefined ? split.text : blocks.push(split.text));
    };
    const ctx = {
      call: scope, messages: planned.messages.map(messageFromWire), signal, stream: this.#deps.llm.streamer, contextWindow: planned.contextWindow, maxOutputTokens: planned.maxTokens,
    };
    for await (const event of prompt.get('stream', { args: run.args, context: planned.context }, ctx)) {
      switch (event.type) {
        case 'textPartial':
          scope.markFirstToken(clock());
          answerText(thinking.push(event.content));
          break;
        case 'reasonPartial': {
          scope.markFirstToken(clock());
          const full = event.reasoning.content ?? '';
          if (message !== undefined && full.length > reasoning.length) this.#deps.turns.stream(message, { reasoning: full.slice(reasoning.length) });
          reasoning = full;
          break;
        }
        case 'toolParseName':
          scope.markFirstToken(clock());
          break;
        case 'message':
          collected.push(messageToWire(event.message));
          break;
        case 'complete':
          answer = event.output;
          break;
        case 'suspend':
          suspended = true;
          break;
        // the rest are seen through the scope's own hooks (usage, requests) or do not change the turn
        case 'text': case 'textReset': case 'textComplete': case 'reason': case 'audioPartial': case 'images': case 'citations':
        case 'refusal': case 'moderation': case 'request': case 'requestUsage': case 'responseTokens': case 'usage':
        case 'reviewStart': case 'reviewPass': case 'reviewFeedback': case 'schemaFallback':
        case 'toolArgRepairAttempt': case 'toolParseArguments':
          break;
      }
    }
    if (signal.aborted) return 'done';
    answerText(thinking.end());
    if (blocks !== undefined) stream(blocks.end());
    const at = await conversation.append(collected);
    const last = scope.last;
    if (last !== undefined) await store.table('llmInteractions').update(last.interaction, { selection: planned.report });

    const made = suspended ? this.#toolCalls(collected, calls) : this.#blockCalls(collected, answer, state.iteration);
    if (made !== undefined) {
      const interpreted = await Promise.all(made.calls.map(async (call) => ({ ...call, plan: await this.#deps.planner.interpret(call.out, planned) })));
      const pending = await this.#startCalls(run, state.iteration, interpreted, last?.interaction);
      await this.#deps.planner.settled({ model, estimate: planned.estimate, actual: last?.usage.input, used: pending.flatMap((call) => (call.run === undefined || call.invalid !== undefined ? [] : [QualifiedName.parse(call.fn)])) });
      if (message !== undefined) await this.#deps.turns.track(message, pending.flatMap((call) => {
        const fn = QualifiedName.safeParse(call.fn);
        return call.run === undefined || !fn.success ? [] : [{ run: call.run, fn: fn.data }];
      }));
      const next: AgentState = { ...state, iteration: state.iteration + 1, pending, anchor: at + made.index, ...this.#saved(conversation) };
      await store.table('runs').update(run.id, { status: 'waiting', resume: Json.parse(next) });
      void this.#await(run, next);
      return 'waiting-for-tools';
    }
    await this.#deps.planner.settled({ model, estimate: planned.estimate, actual: last?.usage.input, used: [] });

    if (answer === undefined) throw new Error(`${run.fn} ended without an answer`);
    const produced = output.result(answer);
    const result = typeof produced === 'string' ? splitThinking(produced).text : produced;
    const refused = await this.#refused(run, fn, result, state, signal);
    if (refused?.action === 'retry') {
      // the model reads why and answers again, in the same conversation
      await conversation.append([{ role: 'user', content: `Your answer was not accepted: ${refused.reason}` }]);
      const next: AgentState = { ...state, iteration: state.iteration + 1, refusals: (state.refusals ?? 0) + 1, ...this.#saved(conversation) };
      await store.table('runs').update(run.id, { resume: Json.parse(next) });
      this.#queue(run, next.iteration);
      return 'waiting-for-tools';
    }
    if (refused !== undefined) {
      const failed = fnError('fatal', refused.reason, OUTPUT_REFUSED);
      await this.#fail(run, state, failed);
      return { failed };
    }
    await store.table('runs').update(run.id, { resume: Json.parse({ ...state, ...this.#saved(conversation) }) });
    if (message !== undefined) await this.#deps.turns.finish(message, [{ type: 'text', text: replyText(result) }], 'done');
    await this.#deps.runs.settle(run.id, { status: 'done', result });
    return 'done';
  }

  /**
   * Whether the output hook of a system's agent (`validate.output`) refuses its answer: `retry` while tries are left
   * (`HARNESS_VALIDATE_RETRIES`), else `stop`; undefined when it passes or the fn has no hook.
   */
  async #refused(run: Run, fn: FnRecord, result: Json, state: AgentState, signal: AbortSignal): Promise<{ action: 'retry' | 'stop'; reason: string } | undefined> {
    if (fn.decl.validate?.output !== true || fn.system === HUB_SYSTEM) return undefined;
    // an agent runs in the hub; the system that declared it answers its hook
    const connection = run.system === fn.system ? this.#deps.link.connection(fn.system, run.instance) : this.#deps.link.connection(fn.system);
    if (connection === undefined) throw new SystemGone(fn.system);
    const refusals = state.refusals ?? 0;
    const verdict = await connection.peer.call('validate', {
      phase: 'output', run: await this.#deps.runs.info(run), fn: splitName(fn.name).local, args: run.args, result, attempt: refusals + 1,
    }, { signal: AbortSignal.any([signal, connection.signal]) });
    if (verdict.ok) return undefined;
    const action = 'action' in verdict ? verdict.action : 'retry';
    return { action: action === 'retry' && refusals < this.#deps.settings.execution.HARNESS_VALIDATE_RETRIES ? 'retry' : 'stop', reason: verdict.reason };
  }

  /**
   * A new user message arrived while the agent works on an earlier one: its tool calls go to the background and are
   * answered with that in the transcript, its streaming stops, and the run ends, so the agent run of the new message
   * continues the conversation (it sees the "still running" replies and the new message) and can answer at once.
   */
  async interrupt(id: RunId): Promise<void> {
    const run = await this.#deps.runs.get(id);
    if (run === undefined || isSettled(run.status)) return;
    this.#iterating.get(id)?.abort('interrupted');
    const job = this.#jobs.get(id);
    if (job !== undefined) await this.#deps.queues.cancel(job, 'interrupted');
    this.#jobs.delete(id);
    const state = stateOf(run);
    await this.#backgroundCalls(state);
    if (state.pending.length > 0) {
      const conversation = this.#conversation(await this.#session(run), state);
      await conversation.answer(state.anchor, (await this.#replies(state.pending, undefined)).messages);
      await this.#deps.store.table('runs').update(id, { resume: Json.parse({ ...state, pending: [], ...this.#saved(conversation) }) });
    }
    if (state.message !== undefined) await this.#deps.turns.finish(state.message, [{ type: 'text', text: INTERRUPTED }], 'done');
    await this.#deps.runs.settle(id, { status: 'done', result: INTERRUPTED });
    this.#deps.log.info('agent.interrupted', { run: id, pending: state.pending.length });
  }

  /** Move an iteration's running tool calls to the background (those that allow it). */
  async #backgroundCalls(state: AgentState): Promise<void> {
    for (const call of state.pending) {
      if (call.run !== undefined) await this.#deps.runs.background(call.run);
    }
  }

  /** The session whose conversation an agent run continues: only a session's own agent (a turn's root run) has one. */
  async #session(run: Run): Promise<Session | undefined> {
    return run.session === undefined || run.parent !== undefined ? undefined : this.#deps.store.table('sessions').get(run.session);
  }

  /** The conversation an agent run continues. */
  #conversation(session: Session | undefined, state: AgentState): Conversation {
    return session === undefined ? new RunConversation(state.messages ?? []) : new SessionConversation(this.#deps, session.id);
  }

  /** Put the turn's user message, as the LLM reads it, into the session transcript. */
  async #seed(conversation: Conversation, message: MessageId | undefined): Promise<void> {
    if (message === undefined) return;
    const row = await this.#deps.store.table('messages').get(message);
    if (row === undefined) return;
    await conversation.append([{ role: 'user', content: this.#deps.enrich.render(row) }]);
  }

  async control(run: Run, action: RunControlAction): Promise<ControlAnswer> {
    this.#iterating.get(run.id)?.abort(action);
    const job = this.#jobs.get(run.id);
    if (job !== undefined) await this.#deps.queues.cancel(job, action);
    this.#jobs.delete(run.id);
    // Read after stopping: the iteration saves its state as it goes, so the run handed in may be behind.
    const state = stateOf((await this.#deps.runs.get(run.id)) ?? run);
    if (action === 'cancel') {
      for (const call of state.pending) if (call.run !== undefined) await this.#deps.runs.cancel(call.run, run.actor);
      if (state.message !== undefined) await this.#deps.turns.finish(state.message, [{ type: 'text', text: 'Cancelled.' }], 'failed');
      await this.#deps.runs.settle(run.id, { status: 'cancelled' });
    } else {
      await this.#deps.runs.settle(run.id, { status: 'paused', resume: Json.parse(state) });
    }
    return { accepted: true };
  }

  /** The run's deadline passed: stop its iteration and its tool calls, and say so in its message. The run service settles it. */
  async stop(run: Run, error: FnError): Promise<void> {
    this.#iterating.get(run.id)?.abort('timeout');
    const job = this.#jobs.get(run.id);
    if (job !== undefined) await this.#deps.queues.cancel(job, 'timeout');
    this.#jobs.delete(run.id);
    const state = stateOf((await this.#deps.runs.get(run.id)) ?? run);
    for (const call of state.pending) if (call.run !== undefined) await this.#deps.runs.cancel(call.run, run.actor);
    if (state.message !== undefined) await this.#deps.turns.finish(state.message, [{ type: 'text', text: failureText(error) }], 'failed');
    this.#deps.log.info('agent.stopped', { run: run.id, code: error.code });
  }

  /** Agents have no undo of their own: their tool runs are undone one by one. */
  undo(): Promise<{ status: 'gone' }> {
    return Promise.resolve({ status: 'gone' });
  }

  /**
   * A tool run a session's agent stopped waiting for (it went to the background) has settled. Its result goes into the
   * session's transcript, for the agent alone to read, and the agent is woken to follow up in its own words (a new
   * turn, unless it is answering in the session already and will read it on its next step). The run's card stays where
   * it was, under the answer that started it, and resolves there. Runs of other callers, of agents that aren't the
   * session's, and runs outside a session are left alone.
   */
  async reportBack(run: Run, settled: RunSettled): Promise<void> {
    if (!run.background || run.parent === undefined || run.session === undefined || settled.status === 'background') return;
    const parent = await this.#deps.runs.get(run.parent);
    if (parent?.kind !== AGENT_KIND || parent.parent !== undefined) return;
    const session = await this.#deps.store.table('sessions').get(run.session);
    if (session?.agent !== parent.fn) return;
    await new SessionConversation(this.#deps, session.id).append([{ role: 'user', content: backgroundResult(run, settled) }]);
    const turn = await this.#deps.turns.followUp({ turn: run.turn, agent: await this.#agentActor(parent) });
    this.#deps.log.info('agent.reported-back', { run: run.id, fn: run.fn, parent: parent.id, status: settled.status, followUp: turn ?? null });
  }

  /** Re-arm the wait of every agent run that was waiting for its tools (after a restart). */
  async recover(): Promise<void> {
    for await (const run of rows(this.#deps.store.table('runs'), { where: { status: 'waiting', kind: AGENT_KIND } })) void this.#await(run, stateOf(run));
  }

  /** Wait until every call of an iteration has settled or gone to the background, then queue the next iteration. */
  async #await(run: Run, state: AgentState): Promise<void> {
    const { runs, presence, settings, log } = this.#deps;
    const waits = state.pending.flatMap((call) => (call.run === undefined ? [] : [runs.wait(call.run)]));
    const progress = { settled: false };
    const all = Promise.all(waits).then(() => { progress.settled = true; });
    const timeout = settings.queue.HARNESS_TOOL_TIMEOUT;
    for (;;) {
      await Promise.race([all, sleep(timeout)]);
      if (progress.settled) break;
      if (run.session !== undefined && (await presence.active(run.session))) {
        log.info('agent.tool-timeout', { run: run.id, iteration: state.iteration });
        await this.#backgroundCalls(state);
      }
    }
    const current = await runs.get(run.id);
    if (current?.status === 'waiting' && stateOf(current).iteration === state.iteration) this.#queue(current, state.iteration);
  }

  #queue(run: Run, iteration: number): void {
    this.#jobs.set(run.id, this.#deps.queues.enqueueLlm({
      run: run.id, turn: run.turn, iteration, priority: run.priority, ...(run.session === undefined ? {} : { session: run.session }),
    }));
  }

  /** The native tool calls of an iteration that suspended, in the order the model made them, with the message holding them. */
  #toolCalls(collected: readonly LlmMessage[], calls: PendingCalls): { calls: ModelCalls; index: number } {
    const index = lastToolCallsIndex(collected);
    const ids = collected[index]?.toolCalls?.map((c) => c.id) ?? [];
    return { index, calls: calls.inOrder(ids).map((call) => ({ toolCallId: call.toolCallId, block: false, out: { type: 'tool', id: call.toolCallId, name: call.name, args: call.args } })) };
  }

  /** The `<run>` blocks of a text-protocol answer (none for native tools or an answer without blocks), each with a made-up call id. */
  #blockCalls(collected: readonly LlmMessage[], answer: AgentOutput | undefined, iteration: number): { calls: ModelCalls; index: number } | undefined {
    if (typeof answer !== 'string') return undefined;
    const found = parseRunBlocks(answer).calls;
    if (found.length === 0) return undefined;
    const index = collected.findLastIndex((m) => m.role === 'assistant');
    return {
      index,
      calls: found.map((block, i) => {
        const id = `block_${iteration}_${i + 1}`;
        return { toolCallId: id, block: true, out: { type: 'block', id, ...block } };
      }),
    };
  }

  /**
   * Start an iteration's calls as child runs: each planned run of a fn (never a wrapper: a static `run` starts the fn
   * it names), keyed by its iteration and call id, so a job that runs the iteration again gets the same runs back while
   * a model that reuses ids across iterations (some do) still gets new runs. A call refused before it ran (invalid
   * input) is answered with its reply; a run that can't start is answered with why.
   */
  async #startCalls(run: Run, iteration: number, calls: ReadonlyArray<ModelCalls[number] & { plan: CallPlan }>, llmCall: Run['llmCall']): Promise<PendingCall[]> {
    const caller = await this.#agentActor(run);
    const pending: PendingCall[] = [];
    for (const { toolCallId, block, plan, out } of calls) {
      const marker = block ? { block: true } : {};
      if (plan.type === 'invalid') {
        // refused input for a fn the model named is still a run (settled invalid-input at once), so the chat shows it
        // as retried and the fn's metrics count it; the model reads the plan's reply, with the fn's card
        const recorded = plan.fn === undefined ? undefined : await this.#deps.runs.start({
          fn: plan.fn, args: plan.args ?? {}, invalid: plan.invalid, turn: run.turn, parent: run.id, key: toolCallKey(iteration, toolCallId), actor: run.actor, caller,
          priority: run.priority, background: false, handlers: [], toolCallId, ...(run.session === undefined ? {} : { session: run.session }), ...(llmCall === undefined ? {} : { llmCall }),
        }).then((started) => started.run, (error: unknown) => {
          this.#deps.log.warn('agent.invalid-input.unrecorded', { run: run.id, fn: plan.fn ?? null, error: messageOf(error) });
          return undefined;
        });
        pending.push({ toolCallId, fn: plan.fn ?? (out.type === 'tool' ? out.name : out.fn ?? 'run'), invalid: plan.reply, ...(recorded === undefined ? {} : { run: recorded }), ...marker });
        this.#deps.log.info('agent.invalid-input', { run: run.id, iteration, fn: plan.fn ?? null, source: plan.invalid.source });
        continue;
      }
      try {
        const started = await this.#deps.runs.start({
          fn: plan.fn, args: plan.args, turn: run.turn, parent: run.id, key: toolCallKey(iteration, toolCallId), actor: run.actor, caller, priority: run.priority,
          background: false, handlers: [], toolCallId, ...(plan.on === undefined ? {} : { on: plan.on }), ...(run.session === undefined ? {} : { session: run.session }),
          ...(llmCall === undefined ? {} : { llmCall }),
        });
        pending.push({ toolCallId, fn: plan.fn, run: started.run, ...marker });
      } catch (error) {
        pending.push({ toolCallId, fn: plan.fn, error: causeOf(error, RunRefused)?.error.message ?? messageOf(error), ...marker });
      }
    }
    return pending;
  }

  /**
   * The replies for an iteration's calls, in call order: a tool message for a native call, a `<result>` user message
   * for a block. Refused input is answered with what was wrong and doesn't count as a failure; a run's exposed fns
   * follow its result. `allFailed` says whether every call failed; `stopped` is set when a fn's output hook stopped a
   * call (the agent run ends with that reason).
   */
  async #replies(pending: readonly PendingCall[], prompt: ExposedTo | undefined): Promise<{ messages: LlmMessage[]; allFailed: boolean; stopped?: FnError }> {
    let stopped: FnError | undefined;
    let failed = 0;
    const messages = await Promise.all(pending.map(async (call): Promise<LlmMessage> => {
      const reply = (status: string, content: string): LlmMessage => (call.block === true
        ? { role: 'user', content: resultText(call.fn, status, content) }
        : { role: 'tool', toolCallId: call.toolCallId, content });
      if (call.invalid !== undefined) return reply('invalid-input', call.invalid);
      if (call.run === undefined) {
        failed += 1;
        return reply('failed', `Error: ${call.error ?? 'the call could not start'}`);
      }
      const child = await this.#deps.runs.get(call.run);
      const outcome = child?.outcome;
      if (outcome?.status === 'invalid-input') return reply('invalid-input', invalidReply(outcome.invalid));
      const settled: RunSettled = child === undefined ? { status: 'failed', error: fnError('fatal', 'the run is gone') }
        : isSettled(child.status) ? settledOf(outcome, child.id) : { status: 'background', run: child.id };
      if (settled.status === 'failed') failed += 1;
      if (settled.status === 'failed' && settled.error.code === OUTPUT_REFUSED) stopped ??= settled.error;
      const exposed = outcome?.status === 'done' && outcome.expose !== undefined && prompt !== undefined ? await this.#deps.planner.exposed(outcome.expose, prompt) : '';
      return reply(settled.status, exposed === '' ? settledReply(settled) : `${settledReply(settled)}\n\n${exposed}`);
    }));
    return { messages, allFailed: pending.length > 0 && failed === pending.length, ...(stopped === undefined ? {} : { stopped }) };
  }

  /** The assistant message a session's agent answers into, opened on its first iteration. */
  async #message(run: Run, state: AgentState, replyTo: MessageId | undefined): Promise<MessageId> {
    if (state.message !== undefined) return state.message;
    const opened = await this.#deps.turns.begin({ turn: run.turn, author: await this.#agentActor(run), ...(replyTo === undefined ? {} : { replyTo }) });
    return opened.id;
  }

  /** The actor of an agent fn (the author of its messages and the caller of its tools). */
  async #agentActor(run: Run): Promise<ActorId> {
    const known = this.#agents.get(run.fn);
    if (known !== undefined) return known;
    for await (const actor of rows(this.#deps.store.table('actors'), { where: { kind: 'agent' } })) {
      if (actor.kind !== 'agent' || actor.fn !== run.fn) continue;
      this.#agents.set(run.fn, actor.id);
      return actor.id;
    }
    return run.caller;
  }

  /** The conversation to keep on the state (only for agents that aren't a session's). */
  #saved(conversation: Conversation): Pick<AgentState, 'messages'> {
    return conversation instanceof RunConversation ? { messages: conversation.saved } : {};
  }

  async #fail(run: Run, state: AgentState, failed: FnError): Promise<void> {
    await this.#deps.store.table('runs').update(run.id, { resume: Json.parse(state) });
    if (state.message !== undefined) await this.#deps.turns.finish(state.message, [{ type: 'text', text: failureText(failed) }], 'failed');
    const outcome: OutcomeWire = { status: 'failed', error: failed };
    await this.#deps.runs.settle(run.id, outcome);
  }
}

/**
 * What a session's agent reads when a run it stopped waiting for settles: the fn, how it ended and what it gave,
 * tagged so the agent can tell it from what a person wrote, and asked to tell the person what came of it.
 */
export function backgroundResult(run: Pick<Run, 'fn'>, settled: Exclude<RunSettled, { status: 'background' }>): string {
  return `<background-result fn="${run.fn}" status="${settled.status}">\n${settledReply(settled)}\n</background-result>\n`
    + 'A call you made earlier finished after you stopped waiting for it. Tell the person what came of it, briefly, in your own words.';
}

/** What an agent's message says when its run fails. */
function failureText(error: FnError): string {
  return `I couldn't finish: ${error.message}`;
}

/** An agent run's loop state. */
export function stateOf(run: Run): AgentState {
  const parsed = AgentState.safeParse(run.resume);
  return parsed.success ? parsed.data : START;
}

/** The calls of one iteration before they are interpreted: their id, whether they came as a `<run>` block, and what the model wrote. */
type ModelCalls = Array<{ readonly toolCallId: string; readonly block: boolean; readonly out: ModelCallOut }>;

/** What the model reads for input the hub refused: each problem, by where it was. */
export function invalidReply(invalid: InvalidInput): string {
  const messages = invalid.problems.map((p) => p.message).join('\n');
  switch (invalid.source) {
    // the fn's input hook: not the model's mistake, so it isn't asked to fix anything
    case 'unavailable': return `Not available now: ${messages}`;
    // the fn's output hook refused the result; its message already asks for another try
    case 'result': return messages;
    case 'json': case 'schema': case 'validation': return `The input was not accepted; fix it and try again:\n${problemLines(invalid.problems)}`;
  }
}

/** The index of the last assistant message with tool calls. */
function lastToolCallsIndex(messages: readonly LlmMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant' && (messages[i]?.toolCalls?.length ?? 0) > 0) return i;
  }
  return -1;
}

/** How an agent's answer is asked for and read back: text as text, objects as they are, anything else wrapped. */
function outputOf(signature: FnSignature): { schema: z.ZodType<object> | false; result: (output: AgentOutput) => Json } {
  if (signature.returns.name === 'text') return { schema: false, result: (output) => (typeof output === 'string' ? output : JSON.stringify(output)) };
  const returns = signature.returnsSchema;
  if (isObjectSchema(returns)) return { schema: returns, result: (output) => Json.parse(output) };
  const wrapped = z.object({ result: returns });
  return { schema: wrapped, result: (output) => Json.parse(wrapped.parse(output).result) };
}

/** The key of a tool call's run within its agent run. */
export function toolCallKey(iteration: number, toolCallId: string): string {
  return `${iteration}:${toolCallId}`;
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
