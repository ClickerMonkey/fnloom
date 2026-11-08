/**
 * The hub's one aeye `AI`, the only caller of real providers, for every modality (chat, embeddings, images,
 * transcription, speech). Its hooks do what the hub promises about every model call: a `ModelCall` record of what it
 * used, cost and took; for a run's calls, a per-model rate check and a budget reservation before it (refused or
 * delayed when a limit is reached) and after it the real cost settled into the ledger and added to the run; for a
 * run's chat calls, the whole interaction saved.
 *
 * aeye builds one context object per API call and hands the same object to `beforeRequest`, `afterRequest` and
 * `onError`, so the hooks pair a reservation with its settlement through a `WeakMap` keyed by that context.
 */
import type { BaseRequest, BaseResponse, Request, Response, Streamer, Usage } from '@aeye/core';
import { AI, type ModelInfo, type Providers } from '@aeye/ai';
import { models as knownModels, strictSupport } from '@aeye/models';
import { compact, ProviderKind, type LlmInteractionId, type Modality, type ModelInfo as ModelView, type ReservationId, type Usd } from '@harness/core';
import { limiter, type Limiter } from '@ayepi/rate';
import type { ModelCallLog, OpenModelCall } from '../metrics/index.ts';
import { BudgetRefused, LlmRateLimited, messageOf } from './errors.ts';
import type { CallSite, Ledger } from './index.ts';
import type { InteractionRecorder } from './interactions.ts';
import {
  audioFile, audioMime, modalityOf, sizesOf, unitsOf, type EmbedCall, type Heard, type ImageCall, type MadeImage, type SpeechCall, type Spoken, type TranscribeCall,
} from './media.ts';
import type { ExecutionBase, LlmEngine, RunCosts } from './ports.ts';
import type { CallReceipts, HubCallContext, HubCallMetadata, LlmCallScope } from './scope.ts';
import { requestToWire, responseToWire, tokensOf, usageToWire } from './wire.ts';

/** The model a call went to, as the hooks see it. */
export interface CallModel {
  readonly id: string;
  readonly provider: string;
}

/** A call between its start and its end. */
interface OpenCall {
  /** The run scope that pays for it; absent for the hub's own work. */
  readonly scope: LlmCallScope | undefined;
  readonly receipts: CallReceipts | undefined;
  readonly modality: Modality;
  readonly request: BaseRequest;
  readonly model: CallModel;
  /** Its `ModelCall`. */
  readonly record: OpenModelCall;
  /** The budget hold and where the call is made, for calls a run pays for. */
  readonly held: { readonly reservation: ReservationId; readonly site: CallSite } | undefined;
  /** The whole request and response, for chat calls a run makes. */
  readonly interaction: LlmInteractionId | undefined;
}

/** True for a chat request (the hooks also see embedding and other requests, which carry no messages). */
function isChatRequest(request: BaseRequest): request is Request {
  return 'messages' in request && Array.isArray(request.messages);
}

/** True for a chat response. */
function isChatResponse(response: BaseResponse): response is Response {
  return 'content' in response && typeof response.content === 'string';
}

/** The purpose of a call no run pays for, when its caller didn't say. */
export const HUB_PURPOSE = 'hub';

/** What the hooks use. */
export interface HubAiHooksDeps extends Pick<ExecutionBase, 'settings' | 'log' | 'clock'> {
  readonly ledger: Ledger;
  readonly recorder: InteractionRecorder;
  readonly costs: RunCosts;
  /** The record of every model call. */
  readonly calls: ModelCallLog;
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

/** How a call ended, for its records. */
interface CallEnd {
  readonly status: 'done' | 'failed' | 'aborted';
  readonly response?: BaseResponse | undefined;
  readonly cost: Usd;
  readonly usage: Usage;
  readonly error?: string | undefined;
}

/**
 * The hub's aeye hooks, around every call of every modality: a `ModelCall` for each; for calls a run pays for, a rate
 * check, a budget hold and its settlement into the ledger and the run; for a run's chat calls, the whole interaction.
 */
export class HubAiHooks {
  readonly #deps: HubAiHooksDeps;
  readonly #open = new WeakMap<object, OpenCall>();

  constructor(deps: HubAiHooksDeps) {
    this.#deps = deps;
  }

  /**
   * Before a call: refuse it if its model is over its rate (`LlmRateLimited`) or a budget would go over
   * (`BudgetRefused`), else hold the estimate (times the margin), open its `ModelCall` and, for a chat call, save the
   * interaction as streaming.
   */
  async before(ctx: object & HubCallContext, request: BaseRequest, model: CallModel, estimate: Usd): Promise<void> {
    const scope = ctx.call;
    const modality = modalityOf(request);
    let held: OpenCall['held'];
    if (scope !== undefined) {
      const rate = await this.#deps.modelLimit.check(model.id, { now: this.#deps.clock() });
      if (!rate.allowed) throw new LlmRateLimited(model.id, rate.retryAfter);
      const site: CallSite = { fn: scope.fn, model: model.id, ...(scope.system === undefined ? {} : { system: scope.system }) };
      const reserved = await this.#deps.ledger.reserve({ limits: scope.limits, estimate: estimate * this.#deps.settings.queue.HARNESS_BUDGET_MARGIN, run: scope.run, site });
      if (!reserved.ok) throw new BudgetRefused(reserved.reason, reserved.budget, reserved.wait);
      held = { reservation: reserved.reservation, site };
    }
    const interaction = scope !== undefined && isChatRequest(request) ? await this.#deps.recorder.open(scope, requestToWire(request), model) : undefined;
    const record = await this.#deps.calls.begin({
      modality, provider: model.provider, model: model.id,
      ...(scope === undefined
        ? { purpose: ctx.purpose ?? HUB_PURPOSE }
        : compact({ run: scope.run, turn: scope.turn, session: scope.session, system: scope.system, fn: scope.fn, priority: scope.priority, purpose: ctx.purpose })),
    }, scope?.queuedAt ?? this.#deps.clock());
    this.#open.set(ctx, { scope, receipts: ctx.receipts, modality, request, model, record, held, interaction });
  }

  /**
   * After a call (finished, or ended early with what it streamed): settle the real cost and close its records as done,
   * aborted (its caller stopped it) or failed.
   */
  async after(ctx: object, response: BaseResponse, complete: boolean, aborted: boolean, usage: Usage, cost: Usd): Promise<void> {
    const call = this.#take(ctx);
    if (call === undefined) return;
    await this.#finish(call, { status: complete ? 'done' : aborted ? 'aborted' : 'failed', response, cost, usage });
  }

  /** A call failed before `after` could run (a non-streaming call, or a refused one): release what it held. */
  async failed(ctx: object | undefined, error: unknown): Promise<void> {
    const call = ctx === undefined ? undefined : this.#take(ctx);
    if (call === undefined) return;
    await this.#finish(call, { status: 'failed', cost: 0, usage: {}, error: messageOf(error) });
  }

  /** Settle, record on the run and the scope, and close the interaction and the model call. */
  async #finish(call: OpenCall, end: CallEnd): Promise<void> {
    const { scope, record, modality, request } = call;
    const units = unitsOf(modality, request, end.response, end.usage);
    const wire = usageToWire(end.usage);
    const tokens = units.modality === 'chat' ? tokensOf(wire) : units.modality === 'embed' ? units.tokens ?? 0 : 0;
    if (scope !== undefined && call.held !== undefined) {
      await this.#deps.ledger.settle(call.held.reservation, {
        cost: end.cost, tokens, actor: scope.actor, run: scope.run, modelCall: record.id, ...call.held.site,
        ...(call.interaction === undefined ? {} : { llmCall: call.interaction }),
        ...(scope.session === undefined ? {} : { session: scope.session }),
      });
    }
    if (call.interaction !== undefined) {
      const response = end.response !== undefined && isChatResponse(end.response) ? responseToWire(end.response, end.status === 'done') : undefined;
      await this.#deps.recorder.close(call.interaction, { status: end.status, response, usage: wire, cost: end.cost, error: end.error, modelCall: record.id }, scope?.firstTokenAt);
    }
    if (scope !== undefined) {
      if (end.cost > 0) await this.#deps.costs.addCost(scope.run, end.cost);
      if (tokens > 0) await this.#deps.costs.addTokens(scope.run, tokens);
    }
    if (scope?.firstTokenAt !== undefined) record.firstByte(scope.firstTokenAt);
    if (end.status === 'done') {
      await record.done({ units, cost: end.cost, ...sizesOf(modality, request, end.response), ...(call.interaction === undefined ? {} : { interaction: call.interaction }) });
    } else {
      await record.failed(end.error ?? (end.status === 'aborted' ? 'stopped by its caller' : 'the call ended early'), end.status === 'aborted', call.interaction);
    }
    if (scope !== undefined && call.interaction !== undefined) scope.record({ interaction: call.interaction, modelCall: record.id, model: call.model.id, cost: end.cost, usage: wire });
    call.receipts?.record({ modelCall: record.id, model: call.model.id, cost: end.cost });
    this.#deps.log.info('llm.settled', {
      run: scope?.run ?? null, modality, call: record.id, interaction: call.interaction ?? null, model: call.model.id, status: end.status, cost: end.cost, tokens,
    });
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
  readonly #make: (providers: Providers) => RefreshableEngine;

  constructor(make: (providers: Providers) => RefreshableEngine, providers: Providers) {
    this.#make = make;
    this.#current = make(providers);
  }

  get streamer(): Streamer<HubCallContext, HubCallMetadata> {
    return this.#current.streamer;
  }

  embed(input: EmbedCall, ctx: HubCallContext, signal?: AbortSignal): Promise<number[][]> {
    return this.#current.embed(input, ctx, signal);
  }

  image(input: ImageCall, ctx: HubCallContext, signal?: AbortSignal): Promise<MadeImage[]> {
    return this.#current.image(input, ctx, signal);
  }

  transcribe(input: TranscribeCall, ctx: HubCallContext, signal?: AbortSignal): Promise<Heard> {
    return this.#current.transcribe(input, ctx, signal);
  }

  speech(input: SpeechCall, ctx: HubCallContext, signal?: AbortSignal): Promise<Spoken> {
    return this.#current.speech(input, ctx, signal);
  }

  models(): ModelView[] {
    return this.#current.models();
  }

  /**
   * Build the AI again with these providers, and ask each for the models it serves before calls switch over, so a
   * provider whose models no list knows (a local Ollama) offers them at once.
   */
  async use(providers: Providers): Promise<void> {
    const next = this.#make(providers);
    await next.refresh();
    this.#current = next;
  }
}

/** An engine that can ask its providers for the models they serve now. */
export interface RefreshableEngine extends LlmEngine {
  refresh(): Promise<void>;
}

/** A request's model, when the metadata names one (weights choose a model instead). */
function modelOf(metadata: HubCallMetadata): { model?: string } {
  return metadata.model === undefined ? {} : { model: metadata.model };
}

/** The aeye context of a non-chat call: the hub's part, its selection metadata and its stop signal. */
function contextOf(ctx: HubCallContext, metadata: HubCallMetadata, signal: AbortSignal | undefined): HubCallContext & { metadata: HubCallMetadata; signal?: AbortSignal } {
  return { ...ctx, metadata, ...(signal === undefined ? {} : { signal }) };
}

/** The hub AI as the agent loop and gateway use it. */
export class AeyeLlm implements RefreshableEngine {
  readonly #ai: HubAi;
  readonly streamer: Streamer<HubCallContext, HubCallMetadata>;

  constructor(ai: HubAi) {
    this.#ai = ai;
    this.streamer = ai.chat.createStreamer();
  }

  /** Ask every provider for the models it serves (a provider that can't answer keeps the known list's models). */
  refresh(): Promise<void> {
    return this.#ai.models.refresh();
  }

  async embed(input: EmbedCall, ctx: HubCallContext, signal?: AbortSignal): Promise<number[][]> {
    const response = await this.#ai.embed.get({ texts: [...input.texts], ...modelOf(input.metadata) }, contextOf(ctx, input.metadata, signal));
    return [...response.embeddings].sort((a, b) => a.index - b.index).map((e) => e.embedding);
  }

  async image(input: ImageCall, ctx: HubCallContext, signal?: AbortSignal): Promise<MadeImage[]> {
    const response = await this.#ai.image.generate.get({
      prompt: input.prompt, responseFormat: 'b64_json', outputFormat: 'png', ...modelOf(input.metadata),
      ...(input.size === undefined ? {} : { size: input.size }), ...(input.count === undefined ? {} : { n: input.count }),
    }, contextOf(ctx, input.metadata, signal));
    return Promise.all(response.images.map(async (image): Promise<MadeImage> => {
      if (image.b64_json !== undefined) return { bytes: Uint8Array.from(Buffer.from(image.b64_json, 'base64')), mime: 'image/png' };
      if (image.url === undefined) throw new Error('the image model answered with no image');
      const fetched = await fetch(image.url, signal === undefined ? {} : { signal });
      return { bytes: new Uint8Array(await fetched.arrayBuffer()), mime: fetched.headers.get('content-type') ?? 'image/png' };
    }));
  }

  async transcribe(input: TranscribeCall, ctx: HubCallContext, signal?: AbortSignal): Promise<Heard> {
    const response = await this.#ai.transcribe.get({
      audio: audioFile(input.audio, input.mime), ...modelOf(input.metadata), ...(input.language === undefined ? {} : { language: input.language }),
    }, contextOf(ctx, input.metadata, signal));
    return {
      text: response.text,
      ...(response.segments === undefined ? {} : { segments: response.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) }),
    };
  }

  async speech(input: SpeechCall, ctx: HubCallContext, signal?: AbortSignal): Promise<Spoken> {
    const format = input.format === 'ogg' ? 'opus' : input.format;
    const response = await this.#ai.speech.get({
      text: input.text, ...modelOf(input.metadata), ...(input.voice === undefined ? {} : { voice: input.voice }), ...(format === undefined ? {} : { responseFormat: format }),
    }, contextOf(ctx, input.metadata, signal));
    return { audio: new Uint8Array(await new Response(response.audio).arrayBuffer()), mime: audioMime(response.responseFormat ?? format) };
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
