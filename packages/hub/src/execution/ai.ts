/**
 * The hub's one aeye `AI`, the only caller of real providers. Its hooks do what the hub promises about every LLM
 * call: a per-model rate check and a budget reservation before it (refused or delayed when a limit is reached), and
 * after it the real cost settled into the ledger, added to the run, and the whole interaction saved.
 *
 * aeye builds one context object per API call and hands the same object to `beforeRequest`, `afterRequest` and
 * `onError`, so the hooks pair a reservation with its settlement through a `WeakMap` keyed by that context.
 */
import type { BaseRequest, BaseResponse, Request, Response, Streamer, Usage } from '@aeye/core';
import { AI, type ModelInfo, type Providers } from '@aeye/ai';
import { models as knownModels, strictSupport } from '@aeye/models';
import { ProviderKind, type LlmInteractionId, type ModelInfo as ModelView, type ReservationId, type Usd } from '@harness/core';
import { limiter, type Limiter } from '@ayepi/rate';
import { BudgetRefused, LlmRateLimited, messageOf } from './errors.ts';
import type { CallSite, Ledger } from './index.ts';
import type { InteractionRecorder } from './interactions.ts';
import type { ExecutionBase, LlmEngine, RunCosts } from './ports.ts';
import type { HubCallContext, HubCallMetadata, LlmCallScope } from './scope.ts';
import { requestToWire, responseToWire, tokensOf, usageToWire } from './wire.ts';

/** The model a call went to, as the hooks see it. */
export interface CallModel {
  readonly id: string;
  readonly provider: string;
}

/** A call between its reservation and its settlement. */
interface OpenCall {
  readonly scope: LlmCallScope;
  readonly reservation: ReservationId;
  readonly interaction: LlmInteractionId;
  readonly model: CallModel;
  /** Where the call is made: what it reserved against, and what its ledger line says. */
  readonly site: CallSite;
}

/** True for a chat request (the hooks also see embedding and other requests, which carry no messages). */
function isChatRequest(request: BaseRequest): request is Request {
  return 'messages' in request && Array.isArray(request.messages);
}

/** True for a chat response. */
function isChatResponse(response: BaseResponse): response is Response {
  return 'content' in response && typeof response.content === 'string';
}

/** What the hooks use. */
export interface HubAiHooksDeps extends Pick<ExecutionBase, 'settings' | 'log' | 'clock'> {
  readonly ledger: Ledger;
  readonly recorder: InteractionRecorder;
  readonly costs: RunCosts;
  /** Per-model call starts, on the hub's rate store. */
  readonly modelLimit: Limiter;
}

/** Build the per-model call limiter from the execution settings on a rate store. */
export function modelLimiter(settings: ExecutionBase['settings'], store: Parameters<typeof limiter>[0]['store']): Limiter {
  return limiter({
    limit: settings.execution.HARNESS_MODEL_RATE_LIMIT,
    window: settings.execution.HARNESS_LLM_RATE_WINDOW,
    algorithm: 'sliding-window',
    prefix: 'llm:model:',
    ...(store === undefined ? {} : { store }),
  });
}

/** The hub's aeye hooks: reserve, rate-check, settle and save. */
export class HubAiHooks {
  readonly #deps: HubAiHooksDeps;
  readonly #open = new WeakMap<object, OpenCall>();

  constructor(deps: HubAiHooksDeps) {
    this.#deps = deps;
  }

  /**
   * Before a call: refuse it if its model is over its rate (`LlmRateLimited`) or a budget would go over
   * (`BudgetRefused`), else hold the estimate (times the margin) and save the interaction as streaming.
   */
  async before(ctx: object & HubCallContext, request: BaseRequest, model: CallModel, estimate: Usd): Promise<void> {
    const scope = ctx.call;
    if (scope === undefined) return;
    const rate = await this.#deps.modelLimit.check(model.id, { now: this.#deps.clock() });
    if (!rate.allowed) throw new LlmRateLimited(model.id, rate.retryAfter);
    const site: CallSite = { fn: scope.fn, model: model.id, ...(scope.system === undefined ? {} : { system: scope.system }) };
    const held = await this.#deps.ledger.reserve({ limits: scope.limits, estimate: estimate * this.#deps.settings.queue.HARNESS_BUDGET_MARGIN, run: scope.run, site });
    if (!held.ok) throw new BudgetRefused(held.reason, held.budget, held.wait);
    const wire = isChatRequest(request) ? requestToWire(request) : { messages: [] };
    const interaction = await this.#deps.recorder.open(scope, wire, model);
    this.#open.set(ctx, { scope, reservation: held.reservation, interaction, model, site });
  }

  /**
   * After a call (finished, or ended early with what it streamed): settle the real cost and save the interaction as
   * done, aborted (its caller stopped it) or failed.
   */
  async after(ctx: object, response: BaseResponse, complete: boolean, aborted: boolean, usage: Usage, cost: Usd): Promise<void> {
    const call = this.#take(ctx);
    if (call === undefined) return;
    await this.#finish(call, {
      status: complete ? 'done' : aborted ? 'aborted' : 'failed',
      response: isChatResponse(response) ? responseToWire(response, complete) : undefined,
      cost,
      usage,
    });
  }

  /** A call failed before `after` could run (a non-streaming call, or a refused one): release what it held. */
  async failed(ctx: object | undefined, error: unknown): Promise<void> {
    const call = ctx === undefined ? undefined : this.#take(ctx);
    if (call === undefined) return;
    await this.#finish(call, { status: 'failed', cost: 0, usage: {}, error: messageOf(error) });
  }

  /** Settle, record on the run and the scope, and close the interaction. */
  async #finish(call: OpenCall, end: { status: 'done' | 'failed' | 'aborted'; response?: ReturnType<typeof responseToWire> | undefined; cost: Usd; usage: Usage; error?: string }): Promise<void> {
    const usage = usageToWire(end.usage);
    const { scope } = call;
    await this.#deps.ledger.settle(call.reservation, {
      cost: end.cost,
      tokens: tokensOf(usage),
      actor: scope.actor,
      run: scope.run,
      llmCall: call.interaction,
      ...call.site,
      ...(scope.session === undefined ? {} : { session: scope.session }),
    });
    await this.#deps.recorder.close(call.interaction, { status: end.status, response: end.response, usage, cost: end.cost, error: end.error }, scope.firstTokenAt);
    if (end.cost > 0) await this.#deps.costs.addCost(scope.run, end.cost);
    scope.record({ interaction: call.interaction, model: call.model.id, cost: end.cost, usage });
    this.#deps.log.info('llm.settled', { run: scope.run, interaction: call.interaction, model: call.model.id, status: end.status, cost: end.cost, tokens: tokensOf(usage) });
  }

  #take(ctx: object): OpenCall | undefined {
    const call = this.#open.get(ctx);
    this.#open.delete(ctx);
    return call;
  }
}

/** What the hub AI is made from. */
export interface HubAiInput {
  readonly providers: Providers;
  readonly hooks: HubAiHooks;
  /** The models selection can pick from; defaults to `@aeye/models`. */
  readonly models?: ModelInfo[];
  readonly log: ExecutionBase['log'];
}

/** Make the hub's aeye `AI` with its hooks installed. */
export function createHubAi(input: HubAiInput) {
  const { hooks, log } = input;
  const settle = (promise: Promise<void>, what: string): Promise<void> =>
    promise.catch((error: unknown) => { log.error('llm.hook-failed', { hook: what, error: messageOf(error) }); });
  return AI.with<HubCallContext>()
    .providers(input.providers)
    .create({ models: input.models ?? knownModels, modelOverrides: [...strictSupport] })
    .withHooks({
      beforeRequest: (ctx, request, selected, _usage, estimate) => hooks.before(ctx, request, { id: selected.model.id, provider: selected.model.provider }, estimate),
      afterRequest: (ctx, _request, response, complete, _selected, usage, cost) => settle(hooks.after(ctx, response, complete, ctx.signal?.aborted === true, usage, cost), 'afterRequest'),
      onError: (type, message, error, ctx) => {
        log.warn('llm.error', { type, message });
        void settle(hooks.failed(ctx, error ?? message), 'onError');
      },
    });
}

/** The hub AI's type. */
export type HubAi = ReturnType<typeof createHubAi>;

/**
 * The hub AI behind a switch: callers keep this one engine while `use` swaps in an AI built with new providers (an
 * admin configured one). Calls already streaming finish on the AI they started on.
 */
export class SwitchingLlm implements LlmEngine {
  #current: LlmEngine;
  readonly #make: (providers: Providers) => LlmEngine;

  constructor(make: (providers: Providers) => LlmEngine, providers: Providers) {
    this.#make = make;
    this.#current = make(providers);
  }

  get streamer(): Streamer<HubCallContext, HubCallMetadata> {
    return this.#current.streamer;
  }

  embed(texts: readonly string[], scope?: LlmCallScope): Promise<{ vectors: number[][]; cost: Usd }> {
    return this.#current.embed(texts, scope);
  }

  transcribe(audio: Uint8Array, model: string): Promise<string> {
    return this.#current.transcribe(audio, model);
  }

  models(): ModelView[] {
    return this.#current.models();
  }

  /** Build the AI again with these providers. */
  use(providers: Providers): void {
    this.#current = this.#make(providers);
  }
}

/** The hub AI as the agent loop and gateway use it. */
export class AeyeLlm implements LlmEngine {
  readonly #ai: HubAi;
  readonly streamer: Streamer<HubCallContext, HubCallMetadata>;

  constructor(ai: HubAi) {
    this.#ai = ai;
    this.streamer = ai.chat.createStreamer();
  }

  async embed(texts: readonly string[], scope?: LlmCallScope): Promise<{ vectors: number[][]; cost: Usd }> {
    const before = scope?.cost ?? 0;
    const response = await this.#ai.embed.get({ texts: [...texts] }, scope === undefined ? {} : { call: scope });
    const vectors = [...response.embeddings].sort((a, b) => a.index - b.index).map((e) => e.embedding);
    return { vectors, cost: (scope?.cost ?? before) - before };
  }

  async transcribe(audio: Uint8Array, model: string): Promise<string> {
    return (await this.#ai.transcribe.get({ audio, model })).text;
  }

  /**
   * The models of the providers this AI was built with, each once (the model list also knows models of providers it
   * lacks, and can hold a model both from the given list and from its provider). Providers that aren't a configurable
   * `ProviderKind` are left out: the admin pages only know those.
   */
  models(): ModelView[] {
    const providers = new Set(Object.keys(this.#ai.providers));
    const seen = new Set<string>();
    const fresh = (key: string): boolean => !seen.has(key) && seen.add(key).has(key);
    return this.#ai.models.list().flatMap((model): ModelView[] => {
      const kind = ProviderKind.safeParse(model.provider);
      if (!kind.success || !providers.has(kind.data) || !fresh(`${kind.data}/${model.id}`)) return [];
      const text = model.pricing.text;
      return [{
        id: model.id, provider: kind.data, name: model.name, contextWindow: model.contextWindow, capabilities: [...model.capabilities],
        ...(text?.input === undefined && text?.output === undefined ? {} : { pricing: { input: text.input ?? 0, output: text.output ?? 0 } }),
      }];
    });
  }
}
