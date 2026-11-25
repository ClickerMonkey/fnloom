/**
 * The system side of the model providers a system brings (`provider()` in its contract): the hub's `providerChat`,
 * `providerEmbed`, `providerDecide` and `providerModels` calls run on the aeye `Provider` its implementation makes
 * for the current config. A model the contract doesn't declare is refused, and a live listing names only declared
 * models, so the hub can only reach what the manifest promised (and priced), which is what an admin reviewed. The
 * contract's runtime provider is called by this instance's name, and declares the models the system set last
 * (`RunningSystem.models`).
 */
import type { Provider } from '@aeye/ai';
import type { Chunk, Response } from '@aeye/core';
import { reject } from '@ayepi/core';
import {
  compact, DecisionAnswers, isEmbedImage, type LiveProviderModel, type ProviderChat, type ProviderChunk, type ProviderDecide, type ProviderDecideResult, type ProviderEmbed, type ProviderEmbedResult,
  type ProviderModelDecl, type ProviderModels, type ProviderModelsResult,
} from '@harness/core';
import type { SystemCtx } from '../ctx.ts';
import type { ProviderDef } from '../providers.ts';
import { AnswerDecoder, ChunkWriter, chunkToWire, decisionInputFromWire, requestFromWire, usageToWire } from './llm-wire.ts';
import { messageOf } from './wire.ts';

/** What the provider server needs. */
export interface ProviderServerParts {
  /** The contract's provider declarations by local name. */
  readonly defs: Readonly<Record<string, ProviderDef>>;
  /** The implementation's provider factories by local name. */
  readonly impls: Readonly<Record<string, (ctx: SystemCtx) => Provider>>;
  /** The system context now, on the system's own signal (throws when there is no valid config). */
  readonly ctx: () => SystemCtx;
  /** The current config version; a provider is made again when it changes. */
  readonly configVersion: () => number | undefined;
  /** The contract's runtime provider, if it has one: its local name, this instance's name and its models now. */
  readonly runtime?: { readonly local: string; readonly instance: () => string; readonly models: () => readonly ProviderModelDecl[] } | undefined;
}

/** How an error from a provider reads on the wire: what kind of failure it is, by aeye's error names. */
export function providerErrorKind(error: unknown): Extract<ProviderChunk, { type: 'error' }>['kind'] {
  const name = error instanceof Error ? error.name : '';
  if (/auth/i.test(name)) { return 'auth'; }
  if (/rate|quota/i.test(name)) { return 'limit'; }
  return 'provider';
}

/** Serves `providerChat`, `providerEmbed`, `providerDecide` and `providerModels` with the system's own aeye providers. */
export class ProviderServer {
  readonly #parts: ProviderServerParts;
  readonly #cache = new Map<string, { version: number | undefined; provider: Provider }>();

  constructor(parts: ProviderServerParts) {
    this.#parts = parts;
  }

  /**
   * Stream a chat call: the provider's chunks, then the usage it reported. The provider plans the request for its model,
   * so its answers are decoded here through that plan (`AnswerDecoder`): the hub gets tool calls and a structured
   * answer in the code shape, as from any provider it plans for itself.
   */
  async *chat(data: ProviderChat, signal: AbortSignal): AsyncGenerator<ProviderChunk> {
    let provider: Provider;
    try {
      provider = this.#provider(data.provider, data.model);
    } catch (error) {
      yield { type: 'error', message: messageOf(error), kind: 'model' };
      return;
    }
    const metadata = { model: data.model };
    try {
      const request = requestFromWire(data.request);
      const streamer = provider.createStreamer?.();
      if (streamer !== undefined) {
        const stream: AsyncGenerator<Chunk, Response> = streamer(request, {}, metadata, signal);
        const writer = new ChunkWriter();
        const decoder = new AnswerDecoder(request);
        let usage: Chunk['usage'];
        for (;;) {
          const next = await stream.next();
          if (next.done === true) {
            for (const chunk of decoder.end()) { yield { type: 'chunk', chunk: writer.write(chunk) }; }
            yield { type: 'done', usage: usageToWire(next.value.usage ?? usage) };
            return;
          }
          if (next.value.usage !== undefined) { usage = next.value.usage; }
          for (const chunk of decoder.chunk(next.value)) { yield { type: 'chunk', chunk: writer.write(chunk) }; }
        }
      }
      const executor = provider.createExecutor?.();
      if (executor === undefined) { throw new Error(`provider ${data.provider} can't chat`); }
      const response: Response = await executor(request, {}, metadata, signal);
      const decoder = new AnswerDecoder(request);
      const content = typeof request.responseFormat === 'object' && response.content !== '' ? decoder.answer(response.content) : response.content;
      yield { type: 'chunk', chunk: chunkToWire({ content, finishReason: response.finishReason }) };
      for (const call of response.toolCalls ?? []) {
        // named and finished at once, as aeye gives a whole response's calls as chunks
        const decoded = decoder.call(call);
        yield { type: 'chunk', chunk: chunkToWire({ toolCallNamed: decoded, toolCall: decoded }) };
      }
      yield { type: 'done', usage: usageToWire(response.usage) };
    } catch (error) {
      yield { type: 'error', message: messageOf(error), kind: providerErrorKind(error) };
    }
  }

  /**
   * Embed inputs with an embedding model of a provider: aeye's one `inputs` list when it has images, else its `texts`
   * shorthand (so a text-only provider reading `texts` keeps working). An image is an http(s) or data URL, which every
   * aeye provider reads as an `EmbeddingImage`.
   */
  async embed(data: ProviderEmbed, signal: AbortSignal): Promise<ProviderEmbedResult> {
    const provider = this.#provider(data.provider, data.model);
    if (provider.embed === undefined) { throw reject(400, 'NOT_EMBEDDING', `provider ${data.provider} can't embed`); }
    const texts = data.inputs.filter((input): input is string => !isEmbedImage(input));
    const what = texts.length === data.inputs.length ? { texts } : { inputs: data.inputs.map((input) => (isEmbedImage(input) ? compact(input) : input)) };
    const response = await provider.embed({ ...what, model: data.model }, { metadata: { model: data.model }, signal });
    const vectors = [...response.embeddings].sort((a, b) => a.index - b.index).map((e) => e.embedding);
    const tokens = response.usage?.text?.input;
    return { vectors, ...(tokens === undefined ? {} : { tokens }) };
  }

  /** Answer questions about an input with a decision model of a provider (aeye's `decide`). */
  async decide(data: ProviderDecide, signal: AbortSignal): Promise<ProviderDecideResult> {
    const provider = this.#provider(data.provider, data.model);
    if (provider.decide === undefined) { throw reject(400, 'NOT_DECISION', `provider ${data.provider} can't decide`); }
    const response = await provider.decide({ input: decisionInputFromWire(data.input), questions: data.questions, model: data.model }, { metadata: { model: data.model }, signal });
    const tokens = response.usage?.text?.input;
    return { answers: DecisionAnswers.parse(response.answers), ...(tokens === undefined ? {} : { tokens }) };
  }

  /**
   * The declared models a provider serves now, from its aeye `listModels`, with the limits it serves them with; a
   * provider that can't list says so (`listed: false`), and the hub then offers every declared model.
   */
  async models(data: ProviderModels): Promise<ProviderModelsResult> {
    const { def, local } = this.#def(data.provider);
    const provider = this.#made(local);
    if (provider.listModels === undefined) { return { listed: false }; }
    const declared = new Set(def.models.map((m) => m.id));
    const live = await provider.listModels();
    const models = live.filter((model) => declared.has(model.id)).map((model): LiveProviderModel => ({
      id: model.id,
      ...(model.contextWindow > 0 ? { contextWindow: Math.floor(model.contextWindow) } : {}),
      ...(model.maxOutputTokens === undefined || model.maxOutputTokens < 1 ? {} : { maxOutput: Math.floor(model.maxOutputTokens) }),
      ...(model.maxQuestions === undefined || model.maxQuestions < 1 ? {} : { maxQuestions: Math.floor(model.maxQuestions) }),
      ...(model.maxRequestBytes === undefined || model.maxRequestBytes < 1 ? {} : { maxRequestBytes: Math.floor(model.maxRequestBytes) }),
    }));
    return { listed: true, models };
  }

  /**
   * A declared provider's declaration and the local name its implementation has: a contract provider by its own name,
   * the runtime provider by this instance's (with the models set last).
   */
  #def(name: string): { def: ProviderDef; local: string } {
    const runtime = this.#parts.runtime;
    if (runtime !== undefined && name === runtime.instance()) {
      const def = this.#parts.defs[runtime.local];
      if (def !== undefined && this.#parts.impls[runtime.local] !== undefined) { return { def: { ...def, models: runtime.models() }, local: runtime.local }; }
    }
    const def = this.#parts.defs[name];
    if (def === undefined || def.runtime || this.#parts.impls[name] === undefined) { throw reject(404, 'NOT_FOUND', `No provider ${name}.`); }
    return { def, local: name };
  }

  /** The provider for a declared model, made for the current config (and kept until the config changes). */
  #provider(name: string, model: string): Provider {
    const { def, local } = this.#def(name);
    if (!def.models.some((m) => m.id === model)) { throw reject(404, 'NOT_FOUND', `Provider ${name} declares no model ${model}.`); }
    return this.#made(local);
  }

  /** A declared provider made for the current config (and kept until the config changes). */
  #made(name: string): Provider {
    const make = this.#parts.impls[name];
    if (make === undefined) { throw reject(404, 'NOT_FOUND', `No provider ${name}.`); }
    const version = this.#parts.configVersion();
    const made = this.#cache.get(name);
    if (made !== undefined && made.version === version) { return made.provider; }
    const provider = make(this.#parts.ctx());
    this.#cache.set(name, { version, provider });
    return provider;
  }
}
