/**
 * The EmbeddingGemma HTTP client: batches texts to what the service accepts, retries when it is busy (429, after its
 * `Retry-After`) or still loading (503), checks every response with the shared zod schemas, and logs truncations.
 */
import type { Log } from '@harness/sdk';
import { GEMMA_DIMENSIONS, GemmaEmbedRequest, GemmaEmbedResponse, GemmaHealth, GemmaInfo, type GemmaTask } from '../shared/index.ts';
import type { GemmaClient, Sleep } from './index.ts';

/** How the client talks to the service. */
export interface GemmaLimits {
  /** Most texts per request (the service's `max_batch` also caps it). */
  readonly batch: number;
  /** Tries after a busy or loading answer. */
  readonly retries: number;
  /** The first wait when the service doesn't say how long; it doubles each try. */
  readonly retryDelay: number;
  /** The longest single wait. */
  readonly retryMax: number;
  /** How long one request may take. */
  readonly timeout: number;
}

/** The service answered with an error, or couldn't be reached (`status` 0). */
export class GemmaError extends Error {
  override readonly name = 'GemmaError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Statuses worth waiting out: busy, and loading the model. */
const RETRYABLE = new Set([429, 503]);
const SECOND = 1_000;

/** The wait a `Retry-After` header asks for, in ms (seconds form only). */
export function retryAfter(header: string | null): number | undefined {
  if (header === null || !/^\d+(\.\d+)?$/.test(header.trim())) { return undefined; }
  return Math.round(Number(header) * SECOND);
}

/** The EmbeddingGemma service over HTTP. */
export class HttpGemmaClient implements GemmaClient {
  private readonly url: () => string;
  private readonly fetch: typeof fetch;
  private readonly sleep: Sleep;
  private readonly limits: GemmaLimits;
  private readonly log: Log;
  /** The service's batch size, asked once per URL. */
  private info: { url: string; batch: Promise<number> } | undefined;

  constructor(deps: { url: () => string; fetch: typeof fetch; sleep: Sleep; limits: GemmaLimits; log: Log }) {
    this.url = deps.url;
    this.fetch = deps.fetch;
    this.sleep = deps.sleep;
    this.limits = deps.limits;
    this.log = deps.log;
  }

  async embed(texts: readonly string[], task: GemmaTask, signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) { return []; }
    const size = await this.batchSize(signal);
    const out: number[][] = [];
    for (let at = 0; at < texts.length; at += size) {
      out.push(...await this.embedBatch(texts.slice(at, at + size), task, signal));
    }
    return out;
  }

  async health(signal?: AbortSignal): Promise<GemmaHealth> {
    return GemmaHealth.parse(await (await this.request('/health', { method: 'GET' }, signal)).json());
  }

  private batchSize(signal: AbortSignal | undefined): Promise<number> {
    const url = this.url();
    if (this.info?.url !== url) {
      const batch = this.request('/info', { method: 'GET' }, signal)
        .then(async (response) => Math.min(this.limits.batch, GemmaInfo.parse(await response.json()).max_batch));
      // a failed probe is asked again next time
      batch.catch(() => { if (this.info?.batch === batch) { this.info = undefined; } });
      this.info = { url, batch };
    }
    return this.info.batch;
  }

  private async embedBatch(texts: readonly string[], task: GemmaTask, signal: AbortSignal | undefined): Promise<number[][]> {
    const body = GemmaEmbedRequest.parse({ texts, task, normalize: true, truncate: true });
    const response = await this.request('/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, signal);
    const parsed = GemmaEmbedResponse.parse(await response.json());
    if (parsed.dim !== GEMMA_DIMENSIONS || parsed.embeddings.length !== texts.length || parsed.embeddings.some((v) => v.length !== GEMMA_DIMENSIONS)) {
      throw new GemmaError(200, `The service returned ${parsed.embeddings.length} vectors of ${parsed.dim} numbers for ${texts.length} texts; expected ${GEMMA_DIMENSIONS} numbers each.`);
    }
    if (parsed.truncated_count > 0) { this.log.warn('embedder.truncated', { task, texts: texts.length, truncated: parsed.truncated_count }); }
    return parsed.embeddings;
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    const url = `${this.url().replace(/\/+$/, '')}${path}`;
    for (let attempt = 0; ; attempt += 1) {
      const timeout = AbortSignal.timeout(this.limits.timeout);
      let response: Response;
      try {
        response = await this.fetch(url, { ...init, signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) });
      } catch (error) {
        signal?.throwIfAborted();
        throw new GemmaError(0, `The embedder service at ${url} couldn't be reached: ${error instanceof Error ? error.message : 'unknown error'}.`);
      }
      if (response.ok) { return response; }
      if (!RETRYABLE.has(response.status) || attempt >= this.limits.retries) {
        throw new GemmaError(response.status, `The embedder service answered ${response.status} for ${path}: ${(await response.text()).slice(0, 200)}`);
      }
      const wait = Math.min(retryAfter(response.headers.get('retry-after')) ?? this.limits.retryDelay * 2 ** attempt, this.limits.retryMax);
      this.log.debug('embedder.retry', { path, status: response.status, attempt: attempt + 1, wait });
      await this.sleep(wait, signal);
    }
  }
}
