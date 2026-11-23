/**
 * Talking to one Ollama server. Reading what a server has goes through `@aeye/ollama`'s `OllamaApi` (`/api/tags`,
 * `/api/show`, `/api/version`), the same client its provider lists models with; this adds the two calls it doesn't
 * make, pulling (`POST /api/pull`, a stream of NDJSON lines) and removing (`DELETE /api/delete`), each line and answer
 * parsed with the zod shapes in `shared/schemas.ts`.
 */
import { OllamaApi, type OllamaShow } from '@aeye/ollama';
import { PullLine, TagsResponse } from '../shared/index.ts';

/** One Ollama server, as the system uses it. An interface so tests use a fake. */
export interface OllamaServerApi {
  readonly url: string;
  /** The server's version; throws when it doesn't answer. */
  version(): Promise<string>;
  /** The installed models with their sizes and details. */
  tags(): Promise<TagsResponse>;
  /** What one model is and can do. */
  show(model: string): Promise<OllamaShow>;
  /** Pull a model, calling `line` with each progress line; rejects with the server's error. */
  pull(model: string, line: (line: Exclude<PullLine, { error: string }>) => void, signal: AbortSignal): Promise<void>;
  /** Remove a model; false when the server has no such model. */
  remove(model: string): Promise<boolean>;
}

/** Makes the client for a server's address. */
export type OllamaApiFactory = (url: string) => OllamaServerApi;

/** The real client over `fetch`. */
export class HttpOllamaApi implements OllamaServerApi {
  readonly url: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #native: OllamaApi;

  constructor(url: string, fetcher: typeof fetch, timeout: number) {
    this.url = url.replace(/\/+$/, '');
    this.#fetch = fetcher;
    this.#timeout = timeout;
    // every native read has the same deadline
    this.#native = new OllamaApi(this.url, (input, init) => fetcher(input, { ...init, signal: AbortSignal.timeout(timeout) }));
  }

  version(): Promise<string> {
    return this.#native.version();
  }

  async tags(): Promise<TagsResponse> {
    // OllamaApi types only the names; the same answer carries sizes and details
    return TagsResponse.parse(await this.#native.tags());
  }

  show(model: string): Promise<OllamaShow> {
    return this.#native.show(model);
  }

  async pull(model: string, line: (line: Exclude<PullLine, { error: string }>) => void, signal: AbortSignal): Promise<void> {
    const response = await this.#fetch(`${this.url}/api/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal,
    });
    if (!response.ok || response.body === null) { throw new Error(`Ollama couldn't pull ${model}: ${await failureOf(response)}`); }
    let success = false;
    for await (const text of ndjsonLines(response.body)) {
      const parsed = PullLine.safeParse(JSON.parse(text));
      if (!parsed.success) { continue; }
      if ('error' in parsed.data) { throw new Error(`Ollama couldn't pull ${model}: ${parsed.data.error}`); }
      if (parsed.data.status === 'success') { success = true; }
      line(parsed.data);
    }
    if (!success) { throw new Error(`Ollama's pull of ${model} ended before it finished.`); }
  }

  async remove(model: string): Promise<boolean> {
    const response = await this.#fetch(`${this.url}/api/delete`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(this.#timeout),
    });
    if (response.status === 404) { return false; }
    if (!response.ok) { throw new Error(`Ollama couldn't remove ${model}: ${await failureOf(response)}`); }
    return true;
  }
}

/** Why a response failed, in the server's words when it gave some. */
async function failureOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') { return body.error; }
  } catch {
    // not JSON: its text, below
  }
  return text.trim() === '' ? `it answered ${response.status}` : text.trim().slice(0, 300);
}

/** The non-empty lines of a byte stream, as they arrive. */
export async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of body) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) { if (line.trim() !== '') { yield line; } }
  }
  rest += decoder.decode();
  if (rest.trim() !== '') { yield rest; }
}
