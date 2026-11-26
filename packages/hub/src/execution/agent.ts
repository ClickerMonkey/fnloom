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
import { fillRequest, planRequest, Prompt, ToolInputError, type Context, type Message, type PromptInput, type Request, type Streamer, type Usage } from '@aeye/core';
import { a, fillDeferred, plainDeferred, type Bindable, type Bundle } from '@aeye/schema';
import { LlmPayloadType, parseValue } from '@harness/sdk';
import {
  ArgRepair, FnExamplesPage, HarnessGrammar, InstanceName, isSettled, Json, JsonObject, LlmInteractionId, type FnNameSpelling, type HarnessGrammarArgs, type ModelFnNames, LlmMessage, MessageId, ModelChoice, modelFnName, namesModel, QualifiedName, RunId, SelectionReport, type PromptPreview, splitName, type ActorId, type FnError, type FnRecord, type InvalidInput,
  type OutcomeWire, type Run, type RunSettled, type Session, type RunControlAction, type TableReading, type UserInfo,
} from '@harness/core';
import { z } from 'zod';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { FnSignature } from '../catalog/index.ts';
import { bindable, isObjectBound, jsonSchemaOf } from '../catalog/signature.ts';
import type { MessageEnricher } from '../chat/index.ts';
import { ensureAgentActor } from '../chat/support.ts';
import { citationsNotice, withCiteId } from '../chat/cite-rule.ts';
import { pictureParts, SEND_FN, shownMessage, type ConversationMedia } from '../chat/shown.ts';
import type { Asking } from '../resources/index.ts';
import type { CallPlan, ExposedTo, ModelCallOut, PromptPlanner } from '../contextor/index.ts';
import { inlineDeferred, spelled } from '../contextor/examples.ts';
import { AUTO_MODEL } from '../contextor/limits.ts';
import { suggestedExamples } from '../chat/enrich.ts';
import { parseRunBlocks, problemLines, resultText, RunBlockFilter, splitThinking, ThinkingFilter } from '../contextor/render.ts';
import { causeOf, fnError, messageOf, RunRefused } from './errors.ts';
import { OUTPUT_REFUSED, SystemGone } from './executors.ts';
import { rows } from '../store/rows.ts';
import { AGENT_KIND, type AgentKind, type AgentLoop, type RunInput } from './index.ts';
import type { ModelResolver } from './models.ts';
import type { ControlAnswer, Conversation, ExecutionDeps, ExecutionJob, LlmEngine, RunExecutor } from './ports.ts';
import { transientDelay, type ExecutionQueues } from './queues.ts';
import { DECLINED_CODE, PROPOSED_KEY, settledOf, type HubRunService } from './runs.ts';
import { LlmCallScope, type HubCallContext, type HubCallMetadata } from './scope.ts';
import { stepWaits } from './claims.ts';
import { agentTools, PendingCalls, type AgentTool } from './tools.ts';
import { messageFromWire, messageToWire, replyText } from './wire.ts';

/**
 * A call held back until earlier calls of its iteration have settled, since they claim the same things (`claims.ts`):
 * which calls it waits for, and what it starts with then. Kept on the agent's state, so a restart starts it as well.
 */
export const HeldCall = z.object({
  /** The tool call ids of the earlier calls it waits for, in the model's order. */
  after: z.array(z.string()).min(1),
  args: Json,
  /** The fleet instance the model named. */
  on: InstanceName.optional(),
  /** The model call that made it. */
  llmCall: LlmInteractionId.optional(),
  /** What core repaired in the args it decoded (a field sent as a string of its JSON), recorded on the run. */
  repairs: z.array(ArgRepair).optional(),
});
export type HeldCall = z.infer<typeof HeldCall>;

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
  /** Not started yet: it waits for earlier calls that claim the same things. Cleared when it starts. */
  held: HeldCall.optional(),
  /** A held call that will never start: the agent stopped waiting (cancelled, timed out, or let its calls run on). */
  skipped: z.literal(true).optional(),
});
export type PendingCall = z.infer<typeof PendingCall>;

/** The agent loop's state, kept on the agent run (`run.resume`). */
export const AgentState = z.object({
  /** The next iteration to run. */
  iteration: z.number().int().min(0),
  /** The iteration its step limit counts from: 0, or where a person last continued it (Continue gives a fresh budget). */
  from: z.number().int().min(0).optional(),
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

/** The code of an agent run that stopped at its step limit (`maxIterations`); Continue can carry it on. */
export const MAX_ITERATIONS = 'max-iterations';

/** A fresh agent's state. */
export const START: AgentState = { iteration: 0, pending: [], anchor: -1, failures: 0 };

/** The marker a tool call gets when its run goes to the background. */
export function backgroundReply(run: RunId): string {
  return `Running in the background as run ${run}; its result will be posted when it finishes.`;
}

/** What the model reads for a settled tool run; a table result shows its first `reading.rows` rows, said to be shown or not. */
export function settledReply(settled: RunSettled, reading: TableReading, encode?: (value: Json) => Json): string {
  switch (settled.status) {
    case 'done': return replyText(settled.result, reading, encode);
    case 'failed': return `Error: ${settled.error.message}`;
    case 'cancelled': return settled.error === undefined ? 'The run was cancelled before it finished.' : settled.error.message;
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
  readonly runs: Pick<HubRunService, 'start' | 'get' | 'wait' | 'settle' | 'background' | 'cancel' | 'info' | 'reopen' | 'onSettled'>;
  readonly queues: Pick<ExecutionQueues, 'enqueueLlm' | 'cancel'>;
  readonly llm: Pick<LlmEngine, 'streamer'> & Partial<Pick<LlmEngine, 'models'>>;
  readonly models: Pick<ModelResolver, 'resolve'>;
  /** How a chat message reads to the LLM (mentions, extras and hooks as tagged blocks). */
  readonly enrich: Pick<MessageEnricher, 'render'>;
  /**
   * Resources shown in a conversation, made for the model each call goes to (`chat/shown.ts`): pictures for a model
   * that sees, `<image>` blocks it can ask about otherwise. Absent: the conversation goes as it is kept.
   */
  readonly media?: Pick<ConversationMedia, 'expand'> | undefined;
  /** What each prompt holds, within the model's limits, and what the model's calls mean. */
  readonly planner: Pick<PromptPlanner, 'plan' | 'interpret' | 'exposed' | 'settled' | 'names' | 'draft' | 'writeArgs'>;
}

/** An agent prompt's tools (given each iteration by `retool`), typed so the prompt's events name them. */
type AgentTools = [AgentTool, ...AgentTool[]];

/** An agent's prompt; it logs when aeye's `forget` drops messages, which the planner's budget should never let happen. */
class AgentPrompt extends Prompt<HubCallContext, HubCallMetadata, 'agent', AgentInput, AgentOutput, AgentTools> {
  readonly #forgot: (dropped: number) => void;

  constructor(input: PromptInput<HubCallContext, HubCallMetadata, 'agent', AgentInput, AgentOutput, AgentTools>, forgot: (dropped: number) => void) {
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
  /** The agent's injected section (`PlannedPrompt.injectedContext`). */
  injectedContext?: string;
  /** The agent's step limit (`payload.maxIterations`), for instructions that tell the model how many steps it has. */
  maxIterations?: number;
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

  /**
   * The request a session's agent would send for a new message (`message`: as the model reads it, the hub's and hooks'
   * blocks added), built as a turn's first step builds it: the planner's draft (which keeps nothing) and the same aeye
   * prompt, whose request is caught before it reaches any model. For the admins' prompt preview.
   */
  async preview(input: { session: Session; user: ActorId; message: string; model?: string | undefined; count?: readonly string[] | undefined }): Promise<PromptPreview> {
    const { catalog } = this.#deps;
    const { session } = input;
    const fn = await catalog.fn(session.agent);
    if (fn === undefined) throw new Error(`${session.agent} no longer exists`);
    const payload = parseValue(LlmPayloadType, fn.decl.payload);
    const metadata = await this.#deps.models.resolve(input.model === undefined ? session.model ?? ModelChoice.optional().parse(payload.model) : { model: input.model });
    const model = metadata.model ?? AUTO_MODEL;
    const instructions = session.instructions ?? payload.instructions;
    const cites = citationsNotice(session.citationsTold, session.citations === true);
    const message = cites.notice === undefined ? input.message : `${cites.notice}\n\n${input.message}`;
    const planned = await this.#deps.planner.draft({
      session, agent: fn, model, instructions, user: input.user,
      transcript: await this.#media([...session.transcript, { role: 'user', content: message }], model, { actor: input.user, session: session.id }),
    });
    const own = modelFnName(fn.name);
    const tools = agentTools(planned.tools.filter((tool) => tool.name !== own), new PendingCalls());
    const output = outputOf(await catalog.signature(fn.name), planned.rendered.names);
    const prompt = new AgentPrompt({
      name: 'agent', description: fn.decl.description, content: `${planned.instructions}{{#if context}}\n\n{{{context}}}{{/if}}`,
      input: (given) => ({ args: given?.args ?? null, context: given?.context ?? '', injectedContext: given?.injectedContext ?? '', maxIterations: given?.maxIterations ?? payload.maxIterations }),
      ...(output.schema === undefined ? {} : { schema: output.schema }), schemaDelivery: tools.length > 0 ? 'prompt' : 'auto', config: { maxTokens: planned.maxTokens }, retool: () => tools, toolExecution: payload.toolExecution, metadata,
    }, () => undefined);
    let caught: Request | undefined;
    const stop = new AbortController();
    // the request is caught where a model would be called, and the prompt stopped there
    const capture = async function* (request: Request): AsyncGenerator<never, never> {
      caught = request;
      stop.abort();
      await Promise.resolve();
      yield* [];
      throw new Error('preview: no model is called');
    };
    const ctx = { messages: planned.messages.map(messageFromWire), signal: stop.signal, stream: capture, contextWindow: planned.contextWindow, maxOutputTokens: planned.maxTokens };
    try {
      for await (const _event of prompt.get('stream', { args: null, context: planned.context, injectedContext: planned.injectedContext, maxIterations: payload.maxIterations }, ctx)) { /* nothing streams */ }
    } catch (error) {
      if (caught === undefined) throw error;
    }
    if (caught === undefined) throw new Error('the prompt sent no request');
    // its examples written through the plan its provider makes for the model (`fillRequest`), as the model reads them
    const info = this.#deps.llm.models?.().find((one) => namesModel(model, one));
    const plan = planRequest(caught, info);
    const request: Request = { ...caught, ...fillRequest(caught, plan) };
    const context = fillDeferred(planned.context, plan);
    const { estimator } = planned.ctx;
    const textOf = (content: Message['content']): string => (typeof content === 'string' ? content : content.map((part) => (part.type === 'text' && typeof part.content === 'string' ? part.content : `[${part.type}]`)).join('\n'));
    const system = request.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
    // the instructions as rendered: the system message without what follows them and without the injected section
    let instructionsText = context !== '' && system.endsWith(context) ? system.slice(0, system.length - context.length).trimEnd() : system;
    if (planned.injectedContext !== '') instructionsText = instructionsText.replace(planned.injectedContext, '').replace(/\n{3,}/g, '\n\n').trim();
    // the tools as the request carries them (what core plans for the model), their parameters in the code shape
    const specs = new Map(planned.tools.map((tool) => [tool.name, tool.spec]));
    const guide = planned.rendered.names.text(planned.mode.guide(planned.ctx));
    return {
      agent: fn.name, model, window: planned.contextWindow, maxTokens: planned.maxTokens, estimate: planned.estimate, system,
      tools: (request.tools ?? []).map((tool) => {
        const spec = specs.get(tool.name);
        return { name: tool.name, description: tool.description ?? '', parameters: Json.parse(jsonSchemaOf(tool.parameters)), tokens: spec === undefined ? 0 : estimator.tool(spec) };
      }),
      messages: request.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: textOf(m.content), tokens: estimator.text(textOf(m.content)) })),
      parts: {
        instructions: instructionsText, injected: planned.injectedContext, context, guide,
        tokens: {
          instructions: estimator.text(instructionsText), injected: estimator.text(planned.injectedContext), context: estimator.text(context), guide: estimator.text(guide), system: estimator.text(system),
        },
      },
      counts: (input.count ?? []).map((text) => estimator.text(text)),
      report: SelectionReport.parse(planned.report),
    };
  }

  async #iterate(run: Run, given: AgentState, signal: AbortSignal): Promise<IterationEnd> {
    let state = given;
    const { catalog, store, clock } = this.#deps;
    const fn = await catalog.fn(run.fn);
    if (fn === undefined) throw new Error(`${run.fn} no longer exists`);
    const payload = parseValue(LlmPayloadType, fn.decl.payload);
    const session = await this.#session(run);
    const conversation = this.#conversation(session, state);
    const turn = await store.table('turns').get(run.turn);
    if (turn === undefined) throw new Error(`run ${run.id} names no turn ${run.turn}`);
    // a chat's own model choice wins over the one its agent fn makes
    const metadata = await this.#deps.models.resolve(session?.model ?? ModelChoice.optional().parse(payload.model));
    const model = metadata.model ?? AUTO_MODEL;
    if (session !== undefined && state.seeded !== true) {
      await this.#seed(conversation, turn.message, session, { session, agent: fn, model, access: await this.#deps.access.scope(turn.user.id) });
      state = { ...state, seeded: true };
      await store.table('runs').update(run.id, { resume: Json.parse(state) });
    }
    // a chat's own system prompt (`Session.instructions`, a compare variant's too) wins over its agent fn's
    const instructions = session?.instructions ?? payload.instructions;
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
    // checked once the last iteration's calls are answered, so their real results are in the transcript (and no call is
    // left without a reply) when the run stops; Continue carries on from there
    if (state.iteration - (state.from ?? 0) >= payload.maxIterations) {
      const failed = fnError('fatal', `${run.fn} stopped after ${payload.maxIterations} iterations without an answer.`, MAX_ITERATIONS);
      await this.#fail(run, state, failed);
      return { failed };
    }
    const planned = await this.#deps.planner.plan({
      session, turn, agent: fn, model, instructions, cached: state.selection,
      // shown resources and images as this model takes them: pictures for one that sees, blocks it can ask about otherwise
      transcript: await this.#media(await conversation.messages(), model, {
        actor: turn.user.id, run: run.id, admin: turn.user.role === 'admin', ...(run.session === undefined ? {} : { session: run.session }),
      }),
    });
    if (state.selection === undefined) {
      if (planned.considered !== undefined && session !== undefined && turn.message !== undefined) await this.#deps.turns.suggested(turn.message, planned.considered);
      state = { ...state, selection: planned.report };
      await store.table('runs').update(run.id, { resume: Json.parse(state) });
    }
    const calls = new PendingCalls();
    // an agent never calls itself: a session that loaded its fn would otherwise offer it back to it
    const own = modelFnName(fn.name);
    const tools = agentTools(planned.tools.filter((tool) => tool.name !== own), calls);
    const blocks = planned.rendered.protocol === 'text' ? new RunBlockFilter() : undefined;
    const signature = await catalog.signature(fn.name);
    const output = outputOf(signature, planned.rendered.names);
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
      // the injected section is the hub's own text, filled in raw where the instructions say (never read as a template)
      content: `${planned.instructions}{{#if context}}\n\n{{{context}}}{{/if}}`,
      input: (input) => ({ args: input?.args ?? null, context: input?.context ?? '', injectedContext: input?.injectedContext ?? '', maxIterations: input?.maxIterations ?? payload.maxIterations }),
      ...(output.schema === undefined ? {} : { schema: output.schema }),
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
      // a cut model name in a call reads back only once learned: each finished call is learned before core decodes it
      call: scope, messages: planned.messages.map(messageFromWire), signal, stream: learning(this.#deps.llm.streamer, planned.rendered.names), contextWindow: planned.contextWindow,
      maxOutputTokens: planned.maxTokens,
    };
    // calls core answered itself (args that don't fit their tool), and what it repaired in the calls it decoded
    const refusedCalls: RefusedCall[] = [];
    const repaired = new Map<string, ArgRepair[]>();
    for await (const event of prompt.get('stream', { args: run.args, context: planned.context, injectedContext: planned.injectedContext, maxIterations: payload.maxIterations }, ctx)) {
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
        case 'toolParseArguments': case 'toolStart': case 'toolOutput': case 'toolInterrupt': case 'toolSuspend':
          break;
        case 'toolArgRepairAttempt':
          if (event.success) repaired.set(event.toolCallId, repairsOfFields(event.tool.name, event.fields));
          break;
        case 'toolError':
          // core answered it (the tool reply is in the conversation already); the hub records it as a run. What was
          // repaired in it goes with it: a retry may reuse the call id, and its own repairs (if any) come again.
          if (event.failure instanceof ToolInputError) repaired.delete(event.toolCallId);
          if (event.failure instanceof ToolInputError) refusedCalls.push({ toolCallId: event.toolCallId, tool: toolNameOf(event.tool, event.failure.tool), error: event.error, ...(event.rawArgs === undefined ? {} : { rawArgs: event.rawArgs }) });
          break;
      }
    }
    if (signal.aborted) return 'done';
    answerText(thinking.end());
    if (blocks !== undefined) stream(blocks.end());
    const at = await conversation.append(collected);
    const last = scope.last;
    // every call of the iteration (its retries and repairs too) was made from the same selection
    for (const call of scope.calls) { await store.table('llmInteractions').update(call.interaction, { selection: planned.report }); }
    await this.#recordRefused(run, state.iteration, refusedCalls, planned.rendered.names, planned.rendered.fns, last?.interaction, message);

    const made = suspended ? this.#toolCalls(collected, calls) : this.#blockCalls(collected, answer, state.iteration);
    if (made !== undefined) {
      const interpreted = await Promise.all(made.calls.map(async (call) => ({ ...call, plan: await this.#deps.planner.interpret(call.out, planned) })));
      const pending = await this.#startCalls(run, state.iteration, interpreted, last?.interaction, { user: turn.user, sequential: payload.toolExecution === 'sequential' }, repaired);
      const used = pending.flatMap((call) => ((call.run === undefined && call.held === undefined) || call.invalid !== undefined ? [] : [QualifiedName.parse(call.fn)]));
      await this.#deps.planner.settled({ model, estimate: planned.estimate, actual: last?.usage.input, used });
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
    if (message !== undefined) await this.#deps.turns.finish(message, [{ type: 'text', text: replyText(result, { rows: this.#deps.settings.execution.HARNESS_TOOL_RESULT_ROWS, watched: true }) }], 'done');
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

  /**
   * Carry on an agent run that stopped at its step limit or was cancelled (Continue): the same run, from where it
   * stopped, with its conversation kept and a fresh step budget. Its calls left unanswered are answered first (a
   * cancelled one says so), its failure count starts again, and its answer goes into a new message (the stopped one
   * keeps saying why it stopped). Refused (`RunRefused`) for any other run.
   */
  async continue(id: RunId, by: ActorId): Promise<void> {
    const run = await this.#deps.runs.get(id);
    if (run?.kind !== AGENT_KIND || !continuable(run)) throw new RunRefused(fnError('caller', 'Only an agent run that stopped at its step limit or was cancelled can continue.', 'not-continuable'));
    const { message: _message, refusals: _refusals, ...state } = stateOf(run);
    const next: AgentState = { ...state, from: state.iteration, failures: 0 };
    if (!(await this.#deps.runs.reopen(id, Json.parse(next), by))) throw new RunRefused(fnError('caller', 'The run is no longer stopped.', 'not-continuable'));
    this.#deps.log.info('agent.continued', { run: id, by, iteration: next.iteration, pending: next.pending.length });
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

  /**
   * Put the turn's user message, as the LLM reads it, into the session transcript. When the chat's "Use citations"
   * changed since the model was last told (a compare variant's own setting too), it starts with a hidden
   * `<citations_changed>` block, once per change; what was told is kept on the session (and put back by undo).
   */
  async #seed(conversation: Conversation, message: MessageId | undefined, session: Session, prompt: ExposedTo): Promise<void> {
    if (message === undefined) return;
    const row = await this.#deps.store.table('messages').get(message);
    if (row === undefined) return;
    const cites = citationsNotice(session.citationsTold, session.citations === true);
    if (cites.told !== session.citationsTold) await this.#deps.store.table('sessions').update(session.id, { citationsTold: cites.told });
    // a suggested fn's example args as the model would send them for that fn here
    const asks = suggestedExamples(row);
    const written = asks.length === 0 ? [] : await this.#deps.planner.writeArgs(prompt, asks);
    const text = this.#deps.enrich.render(row, new Map(asks.map((ask, index) => [ask.fn, written[index] ?? JSON.stringify(ask.args)])));
    await conversation.append([{ role: 'user', content: cites.notice === undefined ? text : `${cites.notice}\n\n${text}` }]);
  }

  async control(run: Run, action: RunControlAction): Promise<ControlAnswer> {
    this.#iterating.get(run.id)?.abort(action);
    const job = this.#jobs.get(run.id);
    if (job !== undefined) await this.#deps.queues.cancel(job, action);
    this.#jobs.delete(run.id);
    // Read after stopping: the iteration saves its state as it goes, so the run handed in may be behind.
    const state = stateOf((await this.#deps.runs.get(run.id)) ?? run);
    if (action === 'cancel') {
      // held calls never start once it is cancelled, Continue included; a pause keeps them held
      await this.#skipHeld(run.id);
      for (const call of state.pending) if (call.run !== undefined) await this.#deps.runs.cancel(call.run, run.actor);
      // read again: skipping held calls saved them
      await this.#closeOpen(run, stateOf((await this.#deps.runs.get(run.id)) ?? run), 'cancelled');
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
    await this.#skipHeld(run.id);
    for (const call of state.pending) if (call.run !== undefined) await this.#deps.runs.cancel(call.run, run.actor);
    await this.#closeOpen(run, stateOf((await this.#deps.runs.get(run.id)) ?? run), 'stopped');
    if (state.message !== undefined) await this.#deps.turns.finish(state.message, [{ type: 'text', text: failureText(error) }], 'failed');
    this.#deps.log.info('agent.stopped', { run: run.id, code: error.code });
  }

  /** Agents have no undo of their own: their tool runs are undone one by one. */
  undo(): Promise<{ status: 'gone' }> {
    return Promise.resolve({ status: 'gone' });
  }

  /**
   * A run a session's agent no longer waits for has settled: a tool run it stopped waiting for (it went to the
   * background), or a run a system proposed while serving one of its calls (`propose`), which waited for the person's
   * approval after that call returned. How it ended goes into the session's transcript, for the agent alone to read, and
   * the agent is woken to follow up in its own words (a new turn, unless it is answering in the session already and
   * will read it on its next step). The run's card stays where it was, under the answer that started it, and resolves
   * there. Runs of other callers, of agents that aren't the session's, and runs outside a session are left alone.
   */
  async reportBack(run: Run, settled: RunSettled): Promise<void> {
    if (run.parent === undefined || run.session === undefined || settled.status === 'background') return;
    const proposed = run.key.startsWith(PROPOSED_KEY);
    if (!run.background && !proposed) return;
    // a background run is the agent's own tool call; a proposed run hangs under a system's run in the agent's turn
    const parent = await this.#deps.runs.get(proposed ? run.root : run.parent);
    if (parent?.kind !== AGENT_KIND || parent.parent !== undefined) return;
    const session = await this.#deps.store.table('sessions').get(run.session);
    if (session?.agent !== parent.fn) return;
    const reading = await this.#reading(run);
    const result = proposed ? proposedResult(run, settled, reading) : backgroundResult(run, settled, reading);
    const content = session.citations === true ? withCiteId(run.id, result) : result;
    await new SessionConversation(this.#deps, session.id).append([{ role: 'user', content }]);
    const turn = await this.#deps.turns.followUp({ turn: run.turn, agent: await this.#agentActor(parent) });
    this.#deps.log.info('agent.reported-back', { run: run.id, fn: run.fn, parent: parent.id, status: settled.status, followUp: turn ?? null });
  }

  /** Re-arm the wait of every agent run that was waiting for its tools (after a restart). */
  async recover(): Promise<void> {
    for await (const run of rows(this.#deps.store.table('runs'), { where: { status: 'waiting', kind: AGENT_KIND } })) void this.#await(run, stateOf(run));
  }

  /**
   * Wait until every call of an iteration has settled or gone to the background, then queue the next iteration. Held
   * calls start as the calls they wait for settle (`#release`). Everything it goes by is on the stored state, so after a
   * restart (`recover`) it carries on where it was. When the person is still there after the tool timeout, the running
   * calls go to the background and the held ones are skipped: the agent answers with what it has.
   */
  async #await(run: Run, state: AgentState): Promise<void> {
    const { runs, presence, settings, log } = this.#deps;
    const timeout = settings.queue.HARNESS_TOOL_TIMEOUT;
    for (;;) {
      const now = await this.#release(run.id, state.iteration);
      if (now === undefined) return;
      const held = now.state.pending.filter(isHeld);
      // while calls are held, wake when one they wait for settles; then, when every call has settled or gone to the background
      const watch = held.length === 0 ? undefined : this.#anySettled(blockersOf(now.state, held));
      const progress = watch?.settled ?? Promise.all(now.state.pending.flatMap((call) => (call.run === undefined ? [] : [runs.wait(call.run)])));
      const outcome = await Promise.race([progress.then(() => 'progress' as const), sleep(timeout).then(() => 'timeout' as const)]).finally(() => { watch?.stop(); });
      if (outcome === 'progress') {
        if (held.length === 0) break;
        continue;
      }
      if (run.session !== undefined && (await presence.active(run.session))) {
        log.info('agent.tool-timeout', { run: run.id, iteration: state.iteration, held: held.length });
        await this.#backgroundCalls(now.state);
        await this.#skipHeld(run.id);
        break;
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

  /**
   * Record the calls core refused (args that don't fit their tool's schema) as runs settled invalid-input at once, so
   * the chat shows each calmly, as retried, and the fn's metrics count it ("Thinking harder"). Core already answered
   * each in the conversation and asked the model again in the same job, so nothing is answered here. A call that names
   * no fn (a garbled name) is answered by core alone. Keyed by iteration and call id, like every call's run.
   */
  async #recordRefused(
    run: Run, iteration: number, refused: readonly RefusedCall[], names: ModelFnNames, fns: ReadonlyMap<string, QualifiedName>, llmCall: Run['llmCall'], message: MessageId | undefined,
  ): Promise<void> {
    if (refused.length === 0) return;
    const caller = await this.#agentActor(run);
    const tracked: Array<{ run: RunId; fn: QualifiedName }> = [];
    const seen = new Map<string, number>();
    for (const call of refused) {
      // core asks again in the same job, where a model may reuse a call's id: each refusal is its own run, and never
      // the run of the call that finally fits
      const attempt = seen.get(call.toolCallId) ?? 0;
      seen.set(call.toolCallId, attempt + 1);
      const { fn, args } = refusedFn(call, names, fns);
      if (fn === undefined || (await this.#deps.catalog.fn(fn)) === undefined) continue;
      const problem = call.error.replace(/^Error parsing tool arguments: /, '');
      try {
        const started = await this.#deps.runs.start({
          fn, args, invalid: { source: 'schema', problems: [{ path: '', message: problem }] }, turn: run.turn, parent: run.id, key: `${toolCallKey(iteration, call.toolCallId)}${REFUSED_KEY}${attempt}`, actor: run.actor, caller,
          priority: run.priority, background: false, handlers: [], toolCallId: call.toolCallId, ...(run.session === undefined ? {} : { session: run.session }), ...(llmCall === undefined ? {} : { llmCall }),
        });
        tracked.push({ run: started.run, fn });
        this.#deps.log.info('agent.invalid-input', { run: run.id, iteration, fn, source: 'schema' });
      } catch (error) {
        this.#deps.log.warn('agent.invalid-input.unrecorded', { run: run.id, fn, error: messageOf(error) });
      }
    }
    if (message !== undefined && tracked.length > 0) await this.#deps.turns.track(message, tracked);
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
   * input) is answered with its reply; a run that can't start is answered with why. A call whose claims conflict with
   * an earlier call's (`claims.ts`) is held instead: it starts once those have settled (`#release`).
   */
  async #startCalls(
    run: Run, iteration: number, calls: ReadonlyArray<ModelCalls[number] & { plan: CallPlan }>, llmCall: Run['llmCall'], step: { user: UserInfo; sequential: boolean },
    repaired: ReadonlyMap<string, readonly ArgRepair[]> = new Map(),
  ): Promise<PendingCall[]> {
    const caller = await this.#agentActor(run);
    const waits = await stepWaits(this.#deps, { ...step, caller: run.id, session: run.session }, calls.map(({ toolCallId, plan }) => ({
      toolCallId, fn: plan.type === 'run' ? plan.fn : undefined, args: plan.args ?? {},
    })));
    const pending: PendingCall[] = [];
    for (const [index, { toolCallId, block, plan, out }] of calls.entries()) {
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
      const repairs = repaired.get(toolCallId) ?? [];
      const held: HeldCall = {
        after: waits[index] ?? [], args: plan.args, ...(plan.on === undefined ? {} : { on: plan.on }), ...(llmCall === undefined ? {} : { llmCall }), ...(repairs.length === 0 ? {} : { repairs: [...repairs] }),
      };
      if (held.after.length > 0) {
        pending.push({ toolCallId, fn: plan.fn, held, ...marker });
        this.#deps.log.info('agent.call-held', { run: run.id, iteration, fn: plan.fn, after: held.after });
        continue;
      }
      pending.push(await this.#startCall(run, caller, iteration, { toolCallId, fn: plan.fn, held, ...marker }));
    }
    return pending;
  }

  /** Start one call as a child run, keyed by its iteration and call id (so starting it again gets the same run back). */
  async #startCall(run: Run, caller: ActorId, iteration: number, call: PendingCall & { held: HeldCall }): Promise<PendingCall> {
    const { held, skipped: _skipped, ...rest } = call;
    try {
      const started = await this.#deps.runs.start({
        fn: QualifiedName.parse(call.fn), args: held.args, turn: run.turn, parent: run.id, key: toolCallKey(iteration, call.toolCallId), actor: run.actor, caller, priority: run.priority,
        background: false, handlers: [], toolCallId: call.toolCallId, ...(held.on === undefined ? {} : { on: held.on }), ...(run.session === undefined ? {} : { session: run.session }),
        ...(held.llmCall === undefined ? {} : { llmCall: held.llmCall }), ...(held.repairs === undefined ? {} : { repairs: held.repairs }),
      });
      return { ...rest, run: started.run };
    } catch (error) {
      return { ...rest, error: causeOf(error, RunRefused)?.error.message ?? messageOf(error) };
    }
  }

  /**
   * Start the held calls of an iteration whose waits are over: every call each waits for has settled (one that never
   * became a run counts as settled; one in the background is still running). Each start is saved on the agent's state
   * at once, so a restart neither loses a held call nor starts it twice (a call started again gets its run back by its
   * key). The agent run and its state as they are now, or undefined when the run no longer waits for this iteration.
   */
  async #release(id: RunId, iteration: number): Promise<{ run: Run; state: AgentState } | undefined> {
    for (;;) {
      const run = await this.#deps.runs.get(id);
      if (run?.status !== 'waiting') return undefined;
      const state = stateOf(run);
      if (state.iteration !== iteration) return undefined;
      const ready = await this.#ready(state);
      if (ready.length === 0) return { run, state };
      const caller = await this.#agentActor(run);
      // the state already names the iteration it runs next; its pending calls were made by the one before
      const made = iteration - 1;
      for (const call of ready) {
        const started = await this.#startCall(run, caller, made, call);
        this.#deps.log.info('agent.call-released', { run: id, iteration, fn: call.fn, child: started.run ?? null });
        if (!(await this.#saveStarted(id, iteration, started))) {
          // the agent stopped waiting while the call started: a cancelled or finished agent leaves no call running (a
          // paused one finds it again by its key when it resumes)
          const now = await this.#deps.runs.get(id);
          if (started.run !== undefined && now?.status !== 'paused') await this.#deps.runs.cancel(started.run, run.actor);
          return undefined;
        }
        if (started.run !== undefined && state.message !== undefined) await this.#deps.turns.track(state.message, [{ run: started.run, fn: QualifiedName.parse(started.fn) }]);
      }
    }
  }

  /** The held calls whose waits are over, in the model's order. */
  async #ready(state: AgentState): Promise<Array<PendingCall & { held: HeldCall }>> {
    const byId = new Map(state.pending.map((call) => [call.toolCallId, call]));
    const settled = async (toolCallId: string): Promise<boolean> => {
      const call = byId.get(toolCallId);
      if (call === undefined || call.skipped === true) return true;
      if (call.run === undefined) return call.held === undefined;
      const child = await this.#deps.runs.get(call.run);
      return child === undefined || isSettled(child.status);
    };
    const ready: Array<PendingCall & { held: HeldCall }> = [];
    for (const call of state.pending) {
      if (!isHeld(call)) continue;
      const waits = await Promise.all(call.held.after.map(settled));
      if (waits.every(Boolean)) ready.push(call);
    }
    return ready;
  }

  /** Save a held call as started (its run, or why it couldn't start), if the agent still waits for its iteration. */
  async #saveStarted(id: RunId, iteration: number, started: PendingCall): Promise<boolean> {
    return this.#deps.store.tx(async (tx) => {
      const run = await tx.table('runs').get(id);
      if (run?.status !== 'waiting') return false;
      const state = stateOf(run);
      if (state.iteration !== iteration) return false;
      const pending = state.pending.map((call) => (call.toolCallId === started.toolCallId ? started : call));
      await tx.table('runs').update(id, { resume: Json.parse({ ...state, pending }) });
      return true;
    });
  }

  /** Mark an iteration's held calls as never to start: the agent stopped waiting for them. */
  async #skipHeld(id: RunId): Promise<void> {
    await this.#deps.store.tx(async (tx) => {
      const run = await tx.table('runs').get(id);
      if (run === undefined) return;
      const state = stateOf(run);
      if (!state.pending.some(isHeld)) return;
      const pending = state.pending.map((call): PendingCall => (isHeld(call) ? { ...call, skipped: true } : call));
      await tx.table('runs').update(id, { resume: Json.parse({ ...state, pending }) });
    });
  }

  /**
   * Settles once any of these runs settles (in the background a run is still running), or at once when none is
   * running now. `stop` drops the listener.
   */
  #anySettled(ids: readonly RunId[]): { settled: Promise<void>; stop: () => void } {
    let stop = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      const heard = new Set<RunId>();
      let open: ReadonlySet<RunId> | undefined;
      // listening first, so a run that settles while the rows are read is still heard
      stop = this.#deps.runs.onSettled((run) => {
        heard.add(run.id);
        if (open?.has(run.id) === true) resolve();
      });
      void Promise.all(ids.map((id) => this.#deps.runs.get(id))).then((rows) => {
        open = new Set(rows.flatMap((row) => (row === undefined || isSettled(row.status) ? [] : [row.id])));
        if (open.size === 0 || [...open].some((id) => heard.has(id))) resolve();
      }, () => { resolve(); });
    });
    return { settled, stop: () => { stop(); } };
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
    // out to the model: every fn a reply names is spelled as the model calls it in this session's mode
    const names = prompt === undefined ? undefined : await this.#deps.planner.names(prompt);
    // each reply is written first, then every name the replies hold is looked up in one batch and spelled
    // a call that showed the model a resource: the reference follows the replies, made for the model at each call
    const shown: LlmMessage[] = [];
    const unspoken = await Promise.all(pending.map(async (call): Promise<{ readonly call: PendingCall; readonly text: string }> => {
      const reply = (status: string, content: string) => ({ call, text: call.block === true ? resultText(call.fn, status, content) : content });
      if (call.invalid !== undefined) return reply('invalid-input', call.invalid);
      // a held call the agent stopped waiting for never ran; that isn't the call failing
      if (call.run === undefined && call.held !== undefined) return reply('skipped', heldReply({ ...call, held: call.held }, pending));
      if (call.run === undefined) {
        failed += 1;
        return reply('failed', `Error: ${call.error ?? 'the call could not start'}`);
      }
      const child = await this.#deps.runs.get(call.run);
      const outcome = child?.outcome;
      if (outcome?.status === 'invalid-input') return reply('invalid-input', invalidReply(outcome.invalid));
      const settled: RunSettled = child === undefined ? { status: 'failed', error: fnError('fatal', 'the run is gone') }
        : isSettled(child.status) ? settledOf(outcome, child.id) : { status: 'background', run: child.id };
      // a result read as JSON has its fn-name fields (`g.fnName()` in its fn's result type) as the model calls those fns
      const returns = names === undefined || child === undefined || settled.status !== 'done' ? undefined : (await this.#deps.catalog.fn(child.fn))?.decl.returns;
      const encode = names === undefined ? undefined : (value: Json): Json => names.value(value, returns);
      if (settled.status === 'failed') failed += 1;
      if (settled.status === 'failed' && settled.error.code === OUTPUT_REFUSED) stopped ??= settled.error;
      if (settled.status === 'done' && child?.fn === SEND_FN) shown.push(...shownOf(child.args));
      const exposed = outcome?.status === 'done' && outcome.expose !== undefined && prompt !== undefined ? await this.#deps.planner.exposed(outcome.expose, prompt) : '';
      const reading = child === undefined ? { rows: this.#deps.settings.execution.HARNESS_HEADLESS_RESULT_ROWS, watched: false } : await this.#reading(child);
      const examples = settled.status === 'done' && prompt !== undefined && encode !== undefined ? await this.#examplesPage(settled.result, prompt, encode) : undefined;
      const text = examples ?? settledReply(settled, reading, encode);
      const content = exposed === '' ? text : `${text}\n\n${exposed}`;
      // with citations on, the model reads each result's id first: what its cites name
      return reply(settled.status, prompt?.session?.citations === true ? withCiteId(call.run, content) : content);
    }));
    await names?.learn(unspoken.map((reply) => reply.text));
    // its fns spelled, then the examples kept from the speller (a page of examples' args) written as they are
    const spoken = (text: string): string => (names === undefined ? plainDeferred(text) : spelled(names, text));
    const messages = unspoken.map(({ call, text }): LlmMessage => (call.block === true
      ? { role: 'user', content: spoken(text) }
      : { role: 'tool', toolCallId: call.toolCallId, content: spoken(text) }));
    messages.push(...shown);
    return { messages, allFailed: pending.length > 0 && failed === pending.length, ...(stopped === undefined ? {} : { stopped }) };
  }

  /**
   * A page of a fn's examples (`hub/fns_examples`) as the model reads it: its fields as any result's (`encode`), each
   * example's args written as the model would send them for that fn here (`PromptPlanner.writeArgs`), kept from the
   * fn-name speller. Undefined for a result that isn't such a page.
   */
  async #examplesPage(result: Json, prompt: ExposedTo, encode: (value: Json) => Json): Promise<string | undefined> {
    const page = FnExamplesPage.safeParse(result);
    if (!page.success) return undefined;
    const written = await this.#deps.planner.writeArgs(prompt, page.data.items.map((item) => ({ fn: page.data.fn, args: item.args })));
    const rest = JsonObject.parse(encode(Json.parse({ ...page.data, items: page.data.items.map(({ args: _args, ...item }) => item) })));
    const items = Array.isArray(rest['items']) ? rest['items'] : [];
    // each example's args go in as their text (a deferred value, put in place once the JSON is written)
    const asValue = (text: string | undefined): unknown => (text === undefined ? null : text.startsWith('⟦') ? text : JSON.parse(text));
    const shown = { ...rest, items: items.map((item, index) => ({ args: asValue(written[index]), ...(typeof item === 'object' && item !== null && !Array.isArray(item) ? item : {}) })) };
    return inlineDeferred(JSON.stringify(shown));
  }

  /**
   * A conversation as the model takes it (`AgentLoopDeps.media`); as kept when there is no media service or it fails.
   * Either way no image part that isn't a real picture goes out (`pictureParts`): one would fail every turn after it.
   */
  async #media(messages: readonly LlmMessage[], model: string, who: Asking): Promise<LlmMessage[]> {
    if (this.#deps.media === undefined) return pictureParts([...messages]);
    try {
      return await this.#deps.media.expand(messages, model, who);
    } catch (error) {
      this.#deps.log.warn('agent.media-failed', { model, error: messageOf(error) });
      return pictureParts([...messages]);
    }
  }

  /**
   * How the model reads a tool run's table result: watched (`RunInfo.watched`, a chat turn on an open session) the
   * person sees the table and the model gets a few rows; unwatched no one sees it and the model gets more to answer from.
   */
  async #reading(run: Run): Promise<TableReading> {
    const { execution } = this.#deps.settings;
    const watched = (await this.#deps.runs.info(run)).watched === true;
    return { rows: watched ? execution.HARNESS_TOOL_RESULT_ROWS : execution.HARNESS_HEADLESS_RESULT_ROWS, watched };
  }

  /** The assistant message a session's agent answers into, opened on its first iteration. */
  async #message(run: Run, state: AgentState, replyTo: MessageId | undefined): Promise<MessageId> {
    if (state.message !== undefined) return state.message;
    const opened = await this.#deps.turns.begin({ turn: run.turn, author: await this.#agentActor(run), ...(replyTo === undefined ? {} : { replyTo }) });
    return opened.id;
  }

  /**
   * The actor of an agent fn (the author of its messages and the caller of its tools), made on first use. Never the
   * person who ran it: an agent's tool calls are the agent's, so policies ask for them as they would in a session.
   */
  async #agentActor(run: Run): Promise<ActorId> {
    const known = this.#agents.get(run.fn);
    if (known !== undefined) return known;
    const fn = await this.#deps.catalog.fn(run.fn);
    if (fn === undefined) throw new Error(`${run.fn} no longer exists`);
    const actor = await ensureAgentActor(this.#deps, fn);
    this.#agents.set(run.fn, actor.id);
    return actor.id;
  }

  /** The conversation to keep on the state (only for agents that aren't a session's). */
  #saved(conversation: Conversation): Pick<AgentState, 'messages'> {
    return conversation instanceof RunConversation ? { messages: conversation.saved } : {};
  }

  /**
   * A run that stops (fails, is cancelled, or runs out of time) while its native tool calls wait for replies: each call
   * still without a `tool` reply in the session's transcript gets one (how its run stands, or that it has no result), so
   * the chat never holds a call with no reply (providers refuse every later request over one). Idempotent: calls
   * already answered are left alone. `<run>` block calls need no reply and stay pending (Continue answers them); a
   * conversation that isn't a session's is kept on the run and answered on Continue. Never throws (logged instead).
   */
  async #closeOpen(run: Run, state: AgentState, reason: 'failed' | 'cancelled' | 'stopped'): Promise<AgentState> {
    const native = state.pending.filter((call) => call.block !== true);
    if (native.length === 0) return state;
    try {
      const session = await this.#session(run);
      if (session === undefined) return state;
      const conversation = this.#conversation(session, state);
      const after = (await conversation.messages()).slice(state.anchor + 1);
      const answered = new Set(after.flatMap((message) => (message.role === 'tool' && message.toolCallId !== undefined ? [message.toolCallId] : [])));
      const open = native.filter((call) => !answered.has(call.toolCallId));
      if (open.length > 0) {
        const fallback = (toolCallId: string): LlmMessage => ({ role: 'tool', toolCallId, content: `Error: this call has no result — the turn stopped (${reason}) before it came back.` });
        // a call whose run is still going says it has no result: the run is being stopped with this one, and nothing
        // posts its result later (only a run the agent let go on in the background has that)
        const going = new Set<string>();
        for (const call of open) {
          const child = call.run === undefined ? undefined : await this.#deps.runs.get(call.run);
          if (child !== undefined && !isSettled(child.status)) going.add(call.toolCallId);
        }
        let replies: LlmMessage[];
        try {
          const made = (await this.#replies(open, await this.#exposedTo(run, session))).messages;
          replies = made.map((message) => (message.role === 'tool' && message.toolCallId !== undefined && going.has(message.toolCallId) ? { ...message, content: fallback(message.toolCallId).content } : message));
        } catch (error) {
          this.#deps.log.warn('agent.close-replies-failed', { run: run.id, reason, error: messageOf(error) });
          replies = [];
        }
        // every open call answered, whatever the replies hold
        const replied = new Set(replies.flatMap((message) => (message.role === 'tool' && message.toolCallId !== undefined ? [message.toolCallId] : [])));
        await conversation.answer(state.anchor, [...replies, ...open.flatMap((call) => (replied.has(call.toolCallId) ? [] : [fallback(call.toolCallId)]))]);
      }
      const next: AgentState = { ...state, pending: state.pending.filter((call) => call.block === true) };
      await this.#deps.store.table('runs').update(run.id, { resume: Json.parse(next) });
      this.#deps.log.info('agent.closed-open', { run: run.id, reason, closed: open.length });
      return next;
    } catch (error) {
      this.#deps.log.warn('agent.close-failed', { run: run.id, reason, error: messageOf(error) });
      return state;
    }
  }

  /** Who a session agent's replies are written for (fn names spelled as its model calls them); undefined when that can't be worked out. */
  async #exposedTo(run: Run, session: Session): Promise<ExposedTo | undefined> {
    try {
      const fn = await this.#deps.catalog.fn(run.fn);
      const turn = await this.#deps.store.table('turns').get(run.turn);
      if (fn === undefined || turn === undefined) return undefined;
      const payload = parseValue(LlmPayloadType, fn.decl.payload);
      const metadata = await this.#deps.models.resolve(session.model ?? ModelChoice.optional().parse(payload.model));
      return { session, agent: fn, model: metadata.model ?? AUTO_MODEL, access: await this.#deps.access.scope(turn.user.id) };
    } catch {
      return undefined;
    }
  }

  async #fail(run: Run, given: AgentState, failed: FnError): Promise<void> {
    const state = await this.#closeOpen(run, given, 'failed');
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
export function backgroundResult(run: Pick<Run, 'fn'>, settled: Exclude<RunSettled, { status: 'background' }>, reading: TableReading): string {
  return `<background-result fn="${run.fn}" status="${settled.status}">\n${settledReply(settled, reading)}\n</background-result>\n`
    + 'A call you made earlier finished after you stopped waiting for it. Tell the person what came of it, briefly, in your own words.';
}

/**
 * What a session's agent reads when a run proposed for the person's approval settles: approved and its result,
 * declined with who declined and why, or how else it ended, tagged so the agent can tell it from what a person wrote,
 * and asked to tell the person what came of it.
 */
export function proposedResult(run: Pick<Run, 'fn'>, settled: Exclude<RunSettled, { status: 'background' }>, reading: TableReading): string {
  const declined = settled.status === 'cancelled' && settled.error?.code === DECLINED_CODE;
  const outcome = declined ? 'declined' : settled.status === 'done' ? 'approved' : settled.status;
  const ask = declined
    ? 'The person declined a change you proposed earlier. Acknowledge it briefly and, if the reason suggests another way, offer it.'
    : 'A change you proposed earlier was answered. Tell the person what came of it, briefly, in your own words.';
  return `<approval-result fn="${run.fn}" outcome="${outcome}">\n${settledReply(settled, reading)}\n</approval-result>\n${ask}`;
}

/** What an agent's message says when its run fails. */
function failureText(error: FnError): string {
  return `I couldn't finish: ${error.message}`;
}

/** Whether an agent run stopped in a way Continue carries on: at its step limit, or cancelled. */
export function continuable(run: Pick<Run, 'status' | 'outcome'>): boolean {
  return run.status === 'cancelled' || (run.status === 'failed' && run.outcome?.status === 'failed' && run.outcome.error.code === MAX_ITERATIONS);
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

/** The answers of agents whose returns aren't objects, asked for as `{ result }`, made once per signature. */
const wrappedReturns = new WeakMap<FnSignature, Bundle<AgentOutput, HarnessGrammarArgs>>();

/**
 * How an agent's answer is asked for and read back: text as text, objects as they are, anything else wrapped. Its
 * schema is the fn's returns bound with the prompt's names, so a fn-name field in the answer comes back qualified.
 */
function outputOf(signature: FnSignature, names: FnNameSpelling): { schema?: Bindable<AgentOutput>; result: (output: AgentOutput) => Json } {
  if (signature.returns.name === 'text') return { result: (output) => (typeof output === 'string' ? output : JSON.stringify(output)) };
  const returns = signature.returnsFor<AgentOutput>(names);
  if (isObjectBound(signature.returnsFor())) return { schema: bindable(returns), result: (output) => Json.parse(output) };
  let wrapped = wrappedReturns.get(signature);
  if (wrapped === undefined) wrappedReturns.set(signature, (wrapped = HarnessGrammar.result<AgentOutput>(a.object({ result: returns.root }))));
  return { schema: bindable(wrapped.bind(signature.returns.registry, names)), result: (output) => Json.parse(JsonObject.parse(output)['result'] ?? null) };
}

/** A call core refused before it ran: which call, the tool the model called, what it was told, and its args as written. */
interface RefusedCall {
  readonly toolCallId: string;
  readonly tool: string;
  readonly error: string;
  readonly rawArgs?: string;
}

/** A tool's name, from the tool an event names (absent for a tool the request didn't have) or the name the model called. */
function toolNameOf(tool: { readonly name: string } | undefined, called: string): string {
  return tool?.name ?? called;
}

/** A string's JSON, or undefined when it holds none. */
function jsonOf(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined;
  try {
    return Json.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * The fn a refused call was for, and its args as the model wrote them: a fn's own tool (by the prompt's tools, or its
 * name read back), or the fn a static `run` names. A call through core's dispatcher (`run_tool`) carries `{ tool, args }`.
 */
function refusedFn(call: RefusedCall, names: ModelFnNames, fns: ReadonlyMap<string, QualifiedName>): { fn?: QualifiedName; args: Json } {
  const written = jsonOf(call.rawArgs);
  const object = JsonObject.safeParse(written).data;
  const args = object !== undefined && object['tool'] === call.tool && 'args' in object ? object['args'] ?? {} : written ?? {};
  if (call.tool !== 'run') {
    const fn = fns.get(call.tool) ?? names.fn(call.tool);
    return { ...(fn === undefined ? {} : { fn }), args };
  }
  const run = JsonObject.safeParse(args).data;
  const named = typeof run?.['fn'] === 'string' ? names.fn(run['fn']) : undefined;
  return { ...(named === undefined ? {} : { fn: named }), args: run?.['args'] ?? {} };
}

/**
 * The repairs core made in a call it decoded (`toolArgRepairAttempt`: top-level fields sent as a string of their JSON),
 * as paths in the fn's args: a fn tool's field is that arg; static `run`'s `args` is the whole of the fn's args.
 */
function repairsOfFields(tool: string, fields: readonly string[]): ArgRepair[] {
  if (tool !== 'run') return fields.map((path) => ({ path, repair: 'json-string' }));
  return fields.includes('args') ? [{ path: '', repair: 'json-string' }] : [];
}

/**
 * The streamer the agent's prompt calls, with every finished tool call's names learned before it is yielded: core
 * decodes a call as soon as it has it, and a cut model name (`ModelFnNames`) reads back only once learned.
 */
function learning(streamer: Streamer<HubCallContext, HubCallMetadata>, names: ModelFnNames): Streamer<HubCallContext, HubCallMetadata> {
  return async function* learned(request, context, metadata, signal) {
    const inner = streamer(request, context, metadata, signal);
    let finished = false;
    try {
      for (let next = await inner.next(); ; next = await inner.next()) {
        if (next.done === true) {
          finished = true;
          return next.value;
        }
        const call = next.value.toolCall;
        if (call !== undefined) await names.learn([jsonOf(call.arguments)]);
        yield next.value;
      }
    } finally {
      // the prompt stopped reading early (an abort, a suspend): the provider's stream is closed too; its value is unused
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a closed stream's return value is never read
      if (!finished) await inner.return(undefined as never);
    }
  };
}

/** Whether a call is held: it waits for earlier calls and has neither started nor been skipped. */
function isHeld(call: PendingCall): call is PendingCall & { held: HeldCall } {
  return call.held !== undefined && call.run === undefined && call.skipped !== true;
}

/** The runs of the calls these held calls wait for. */
function blockersOf(state: AgentState, held: ReadonlyArray<PendingCall & { held: HeldCall }>): RunId[] {
  const waitedFor = new Set(held.flatMap((call) => call.held.after));
  return state.pending.flatMap((call) => (call.run !== undefined && waitedFor.has(call.toolCallId) ? [call.run] : []));
}

/** What the model reads for a held call that never started: it waited for an earlier call working on the same things. */
export function heldReply(call: PendingCall & { held: HeldCall }, pending: readonly PendingCall[]): string {
  const earlier = [...new Set(call.held.after.flatMap((id) => pending.find((other) => other.toolCallId === id)?.fn ?? []))];
  return `Not run: it works on the same things as an earlier call (${earlier.join(', ')}), so it waited for that to finish, and it had not when `
    + 'this reply was written. Call it again once that call is done, if it is still needed.';
}

/** What follows a refused call's key (`toolCallKey`) on its run, with the refusal's number in the job. */
export const REFUSED_KEY = ':refused:';

/** The key of a tool call's run within its agent run. */
export function toolCallKey(iteration: number, toolCallId: string): string {
  return `${iteration}:${toolCallId}`;
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** The `<shown>` reference for a done `hub/resource_send` run, read from its args (none when they don't name a resource). */
function shownOf(args: Json): LlmMessage[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return [];
  const { uri, section } = args;
  return typeof uri === 'string' ? [shownMessage(uri, typeof section === 'string' ? section : undefined)] : [];
}
