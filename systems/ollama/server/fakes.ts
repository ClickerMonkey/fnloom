/**
 * Fakes for the Ollama system's tests: an Ollama server's HTTP API in memory, child processes that never run anything,
 * and a release source, download and unpack that never touch the network. Nothing here installs, starts or pulls
 * anything real.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OllamaShow } from '@aeye/ollama';
import { z } from 'zod';
import type { PullLine, TagsResponse } from '../shared/index.ts';
import type { OllamaServerApi } from './api.ts';
import type { Downloader, Extractor, Release, ReleaseSource } from './install.ts';
import type { ChildHandle, ChildRunner } from './serve.ts';

/** A model a fake server has. */
export interface FakeModel {
  readonly size: number;
  readonly show: OllamaShow;
  readonly details?: NonNullable<TagsResponse['models'][number]['details']>;
}

/** A chat model's `/api/show`, with tools, trained to `trained` and served with `numCtx` when given. */
export function chatShow(trained: number, numCtx?: number): OllamaShow {
  return {
    capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': trained },
    ...(numCtx === undefined ? {} : { parameters: `num_ctx ${String(numCtx)}` }), details: { family: 'qwen3', parameter_size: '8.2B' },
  };
}

/** An embedding model's `/api/show`, giving vectors of `dims`. */
export function embedShow(dims: number): OllamaShow {
  return { capabilities: ['embedding'], model_info: { 'nomic-bert.context_length': 2_048, 'nomic-bert.embedding_length': dims } };
}

/** One Ollama server in memory. `up` says whether it answers. */
export class FakeOllama implements OllamaServerApi {
  readonly url: string;
  up = true;
  serverVersion = '0.12.3';
  readonly models = new Map<string, FakeModel>();
  /** What a pull of a model streams before `success`, by model; absent, Ollama has no such model. */
  readonly registry = new Map<string, { lines: Array<Exclude<PullLine, { error: string }>>; model: FakeModel }>();
  readonly pulled: string[] = [];
  readonly removed: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  version(): Promise<string> {
    return this.up ? Promise.resolve(this.serverVersion) : Promise.reject(new Error('connect ECONNREFUSED'));
  }

  tags(): Promise<TagsResponse> {
    if (!this.up) { return Promise.reject(new Error('connect ECONNREFUSED')); }
    return Promise.resolve({ models: [...this.models].map(([name, m]) => ({ name, model: name, size: m.size, ...(m.details === undefined ? {} : { details: m.details }) })) });
  }

  show(model: string): Promise<OllamaShow> {
    const found = this.models.get(model);
    return found === undefined ? Promise.reject(new Error(`no ${model}`)) : Promise.resolve(found.show);
  }

  async pull(model: string, line: (line: Exclude<PullLine, { error: string }>) => void, signal: AbortSignal): Promise<void> {
    if (!this.up) { throw new Error('connect ECONNREFUSED'); }
    const entry = this.registry.get(model);
    if (entry === undefined) { throw new Error(`Ollama couldn't pull ${model}: pull model manifest: file does not exist`); }
    for (const each of entry.lines) {
      if (signal.aborted) { throw new Error('aborted'); }
      line(each);
      await Promise.resolve();
    }
    line({ status: 'success' });
    this.models.set(model, entry.model);
    this.pulled.push(model);
  }

  remove(model: string): Promise<boolean> {
    this.removed.push(model);
    return Promise.resolve(this.models.delete(model));
  }
}

/** A child process that runs nothing: it exits when killed, or when a test says so. */
export class FakeChild implements ChildHandle {
  readonly pid: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> };
  readonly kills: boolean[] = [];
  /** Whether a polite kill makes it exit (a stuck one needs `force`). */
  politeExit = true;
  readonly #listeners = new Set<(line: string) => void>();
  #done: (exit: { code: number | null; signal: string | null }) => void = () => undefined;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  constructor(pid: number, command: string, args: readonly string[], options: FakeChild['options']) {
    this.pid = pid;
    this.command = command;
    this.args = args;
    this.options = options;
    this.exited = new Promise((done) => { this.#done = done; });
  }

  onLine(listener: (line: string) => void): void { this.#listeners.add(listener); }

  print(line: string): void { for (const listener of this.#listeners) { listener(line); } }

  /** It exits on its own (a crash, when it was wanted). */
  exit(code: number | null, signal: string | null = null): void { this.#done({ code, signal }); }

  kill(force: boolean): void {
    this.kills.push(force);
    if (force || this.politeExit) { this.#done({ code: null, signal: force ? 'SIGKILL' : 'SIGTERM' }); }
  }
}

/** Starts fake children; `started` is called with each (a test makes its fake server answer then). */
export class FakeRunner implements ChildRunner {
  readonly children: FakeChild[] = [];
  started: (child: FakeChild) => void = () => undefined;

  spawn(command: string, args: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): ChildHandle {
    const child = new FakeChild(1_000 + this.children.length, command, args, options);
    this.children.push(child);
    this.started(child);
    return child;
  }
}

/** The hex sha-256 of some bytes. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Releases kept in memory, by version (`latest` is the newest added). */
export class FakeReleases implements ReleaseSource {
  readonly releases = new Map<string, Release>();
  readonly asked: string[] = [];

  add(release: Release): this {
    this.releases.set(release.version, release);
    this.releases.set('latest', release);
    return this;
  }

  release(version: string): Promise<Release> {
    this.asked.push(version);
    const found = this.releases.get(version);
    return found === undefined ? Promise.reject(new Error(`Ollama has no release ${version}.`)) : Promise.resolve(found);
  }
}

/** Downloads served from memory, by URL, written to disk as a real download would be. */
export class FakeDownloader implements Downloader {
  readonly files = new Map<string, Uint8Array | string>();
  readonly downloaded: string[] = [];

  async download(url: string, to: string, progress: (received: number, total: number | undefined) => void): Promise<{ sha256: string; bytes: number }> {
    const body = this.files.get(url);
    if (body === undefined) { throw new Error(`The download answered 404.`); }
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
    this.downloaded.push(url);
    progress(Math.floor(bytes.length / 2), bytes.length);
    progress(bytes.length, bytes.length);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, bytes);
    return { sha256: sha256(bytes), bytes: bytes.length };
  }

  text(url: string): Promise<string> {
    const body = this.files.get(url);
    return body === undefined ? Promise.reject(new Error(`${url} answered 404.`)) : Promise.resolve(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
  }
}

/** "Unpacks" an archive by writing the files a test says it holds (relative paths), whatever the archive is. */
export class FakeExtractor implements Extractor {
  holds: readonly string[] = ['bin/ollama'];
  readonly extracted: Array<{ archive: string; into: string }> = [];

  async extract(archive: string, into: string): Promise<void> {
    this.extracted.push({ archive, into });
    for (const file of this.holds) {
      await mkdir(dirname(join(into, file)), { recursive: true });
      await writeFile(join(into, file), 'not a real program');
    }
  }
}

/** The body of a `/api/show` request. */
const ShowBody = z.object({ model: z.string().optional() });

/**
 * A `fetch` that answers Ollama's native and model-list API from fake servers by address (`/api/version`, `/api/tags`,
 * `/api/show`), as @aeye/ollama's provider reads them; anything else answers 404, and a server that is down refuses.
 */
export function fakeFetch(servers: ReadonlyMap<string, FakeOllama>): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const server = servers.get(url.origin);
    if (server === undefined || !server.up) { throw new TypeError('fetch failed: connect ECONNREFUSED'); }
    const body = ShowBody.parse(typeof init?.body === 'string' ? JSON.parse(init.body) : {});
    switch (url.pathname) {
      case '/api/version': return Response.json({ version: await server.version() });
      case '/api/tags': return Response.json(await server.tags());
      case '/api/show': return server.show(body.model ?? '').then((show) => Response.json(show), () => new Response('{"error":"not found"}', { status: 404 }));
      default: return new Response('{"error":"not found"}', { status: 404 });
    }
  };
}
