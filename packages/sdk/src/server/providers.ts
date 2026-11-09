/**
 * The system side of the model providers a system brings (`provider()` in its contract): the hub's `providerChat`
 * and `providerEmbed` calls run on the aeye `Provider` its implementation makes for the current config. A model the
 * contract doesn't declare is refused, so the hub can only reach what the manifest promised (and priced).
 */
import type { Provider } from '@aeye/ai';
import type { Chunk, Response } from '@aeye/core';
import { reject } from '@ayepi/core';
import type { ProviderChat, ProviderChunk, ProviderEmbed, ProviderEmbedResult } from '@harness/core';
import type { SystemCtx } from '../ctx.ts';
import type { ProviderDef } from '../providers.ts';
import { chunkToWire, requestFromWire, usageToWire } from './llm-wire.ts';
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
}

/** How an error from a provider reads on the wire: what kind of failure it is, by aeye's error names. */
export function providerErrorKind(error: unknown): Extract<ProviderChunk, { type: 'error' }>['kind'] {
  const name = error instanceof Error ? error.name : '';
  if (/auth/i.test(name)) { return 'auth'; }
  if (/rate|quota/i.test(name)) { return 'limit'; }
  return 'provider';
}

/** Serves `providerChat` and `providerEmbed` with the system's own aeye providers. */
export class ProviderServer {
  readonly #parts: ProviderServerParts;
  readonly #made = new Map<string, { version: number | undefined; provider: Provider }>();

  constructor(parts: ProviderServerParts) {
    this.#parts = parts;
  }

  /** Stream a chat call: the provider's chunks, then the usage it reported. */
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
        let usage: Chunk['usage'];
        for (;;) {
          const next = await stream.next();
          if (next.done === true) {
            yield { type: 'done', usage: usageToWire(next.value.usage ?? usage) };
            return;
          }
          if (next.value.usage !== undefined) { usage = next.value.usage; }
          yield { type: 'chunk', chunk: chunkToWire(next.value) };
        }
      }
      const executor = provider.createExecutor?.();
      if (executor === undefined) { throw new Error(`provider ${data.provider} can't chat`); }
      const response: Response = await executor(request, {}, metadata, signal);
      yield { type: 'chunk', chunk: chunkToWire({ content: response.content, finishReason: response.finishReason }) };
      for (const call of response.toolCalls ?? []) { yield { type: 'chunk', chunk: chunkToWire({ toolCall: call }) }; }
      yield { type: 'done', usage: usageToWire(response.usage) };
    } catch (error) {
      yield { type: 'error', message: messageOf(error), kind: providerErrorKind(error) };
    }
  }

  /** Embed texts with an embedding model of a provider. */
  async embed(data: ProviderEmbed, signal: AbortSignal): Promise<ProviderEmbedResult> {
    const provider = this.#provider(data.provider, data.model);
    if (provider.embed === undefined) { throw reject(400, 'NOT_EMBEDDING', `provider ${data.provider} can't embed`); }
    const response = await provider.embed({ texts: data.texts, model: data.model }, { metadata: { model: data.model }, signal });
    const vectors = [...response.embeddings].sort((a, b) => a.index - b.index).map((e) => e.embedding);
    const tokens = response.usage?.text?.input;
    return { vectors, ...(tokens === undefined ? {} : { tokens }) };
  }

  /** The provider for a declared model, made for the current config (and kept until the config changes). */
  #provider(name: string, model: string): Provider {
    const def = this.#parts.defs[name];
    const make = this.#parts.impls[name];
    if (def === undefined || make === undefined) { throw reject(404, 'NOT_FOUND', `No provider ${name}.`); }
    if (!def.models.some((m) => m.id === model)) { throw reject(404, 'NOT_FOUND', `Provider ${name} declares no model ${model}.`); }
    const version = this.#parts.configVersion();
    const made = this.#made.get(name);
    if (made !== undefined && made.version === version) { return made.provider; }
    const provider = make(this.#parts.ctx());
    this.#made.set(name, { version, provider });
    return provider;
  }
}
