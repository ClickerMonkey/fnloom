/**
 * Test seams for the CLI: files in memory, a builder that records what it was asked, a hub whose endpoints are
 * functions over the real web API client (requests go through `fetchImpl`, so bodies and answers are checked by the
 * spec), and io over all three. Tests only.
 */
import { join, resolve, sep } from 'node:path';
import { client } from '@ayepi/core/client';
import type { CallReturn, ClientData } from '@ayepi/core';
import { hubWebSpec, type ContentRef, type HubWebSpec } from '@harness/core';
import { sha256 } from '@harness/hub/package';
import type { CliIo } from './command.ts';
import type { ContractSummary, SystemBuilder } from '@harness/build';
import type { CliFiles, FileStat } from './files.ts';
import { linesOf } from './commands/mcp.ts';
import { cliEnv, type HubSession } from './hub.ts';

/** Files kept in a map, by absolute path, with a clock for modification times. */
export class MemoryFiles implements CliFiles {
  readonly files = new Map<string, { bytes: Uint8Array; modified: number }>();
  now = 1_000;

  /** Put a file (text or bytes), at the current time. */
  put(path: string, body: string | Uint8Array): void {
    this.files.set(path, { bytes: typeof body === 'string' ? new TextEncoder().encode(body) : body, modified: this.now });
  }

  /** A file's text, or a failure. */
  text(path: string): string {
    const found = this.files.get(path);
    if (found === undefined) { throw new Error(`no file ${path}`); }
    return new TextDecoder().decode(found.bytes);
  }

  read(path: string): Promise<Uint8Array> {
    const found = this.files.get(path);
    return found === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(found.bytes);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  write(path: string, bytes: Uint8Array | string): Promise<void> {
    this.put(path, bytes);
    return Promise.resolve();
  }

  stat(path: string): Promise<FileStat | undefined> {
    const file = this.files.get(path);
    if (file !== undefined) { return Promise.resolve({ kind: 'file', modified: file.modified }); }
    const inside = [...this.files.entries()].filter(([p]) => p.startsWith(`${path}${sep}`));
    return Promise.resolve(inside.length === 0 ? undefined : { kind: 'folder', modified: Math.max(...inside.map(([, f]) => f.modified)) });
  }

  walk(folder: string, skip: readonly string[] = []): Promise<string[]> {
    return Promise.resolve([...this.files.keys()].filter((path) => {
      if (!path.startsWith(`${folder}${sep}`)) { return false; }
      const parts = path.slice(folder.length + 1).split(sep);
      return !parts.slice(0, -1).some((part) => skip.includes(part));
    }).sort());
  }

  remove(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) { if (key === path || key.startsWith(`${path}${sep}`)) { this.files.delete(key); } }
    return Promise.resolve();
  }

  copy(from: string, to: string): Promise<void> {
    for (const [key, file] of [...this.files]) { if (key.startsWith(`${from}${sep}`)) { this.files.set(`${to}${key.slice(from.length)}`, file); } }
    return Promise.resolve();
  }
}

/** A builder that writes stand-in output and records each call. */
export class FakeBuilder implements SystemBuilder {
  readonly calls: string[] = [];
  problems: string[] = [];
  names: string[] = [];
  readonly #files: MemoryFiles;

  constructor(files: MemoryFiles) {
    this.#files = files;
  }

  typecheck(dir: string): Promise<string[]> {
    this.calls.push(`typecheck ${dir}`);
    return Promise.resolve(this.problems);
  }

  contracts(module: string): Promise<ContractSummary[]> {
    this.calls.push(`contract ${module}`);
    return Promise.resolve(this.names.map((name) => ({ name, fns: [], context: [], requires: [], references: [] })));
  }

  bundleServer(input: { entry: string; outDir: string; fileName: string; external: readonly string[] }): Promise<void> {
    this.calls.push(`server ${input.entry} -> ${join(input.outDir, input.fileName)} external=${input.external.join(',')}`);
    this.#files.put(join(input.outDir, input.fileName), `// bundled ${input.entry}`);
    return Promise.resolve();
  }

  buildClient(input: { entry: string; outDir: string }): Promise<void> {
    this.calls.push(`client ${input.entry} -> ${input.outDir}`);
    this.#files.put(join(input.outDir, 'index.js'), '// client');
    return Promise.resolve();
  }
}

type Endpoints = HubWebSpec['endpoints'];
type EndpointName = Extract<keyof Endpoints, string>;

/** Fake endpoints, by name: what a test's hub answers, given what the client sent (both typed by the spec). */
export type FakeEndpoints = { [K in EndpointName]?: (body: ClientData<Endpoints[K]>) => Awaited<CallReturn<Endpoints[K]>> | CallReturn<Endpoints[K]> };

/** A hub whose endpoints a test gives, with uploads and downloads kept in memory. */
export class FakeHub implements HubSession {
  readonly api: HubSession['api'];
  readonly uploads: Array<{ name: string; mime: string; bytes: Uint8Array }> = [];
  readonly downloads = new Map<string, Uint8Array>();
  readonly called: string[] = [];
  closed = 0;

  constructor(endpoints: FakeEndpoints) {
    this.api = client<HubWebSpec>({
      baseUrl: 'http://hub.test/api', manifest: hubWebSpec,
      fetchImpl: async (request) => {
        const name = new URL(request.url).pathname.split('/').filter((part) => part !== '').at(-1) ?? '';
        this.called.push(name);
        const handler: unknown = Reflect.get(endpoints, name);
        if (typeof handler !== 'function') { return Response.json({ error: { code: 'NOT_FAKED', message: `the fake hub has no ${name}` } }, { status: 501 }); }
        const text = await request.text();
        const body: unknown = text === '' ? undefined : JSON.parse(text);
        try {
          const answer: unknown = await Reflect.apply(handler, endpoints, [body]);
          return Response.json(answer ?? {});
        } catch (error) {
          return Response.json({ error: { code: 'FAILED', message: error instanceof Error ? error.message : String(error) } }, { status: 422 });
        }
      },
    });
  }

  upload(bytes: Uint8Array, name: string, mime: string): Promise<ContentRef> {
    this.uploads.push({ name, mime, bytes });
    return Promise.resolve({ hash: sha256(bytes), size: bytes.length, mime });
  }

  download(url: string): Promise<Uint8Array> {
    const found = this.downloads.get(url);
    return found === undefined ? Promise.reject(new Error(`no download at ${url}`)) : Promise.resolve(found);
  }

  close(): void {
    this.closed += 1;
  }
}

/** What a test's io recorded. */
export interface TestIo extends CliIo {
  readonly lines: string[];
  readonly warnings: string[];
  readonly memory: MemoryFiles;
  readonly built: FakeBuilder;
}

/** Io over memory files, a fake builder and the given hub; `cwd` is a made-up absolute folder. */
export function testIo(options: { hub?: FakeHub; cwd?: string; stdin?: readonly string[] } = {}): TestIo {
  const memory = new MemoryFiles();
  const lines: string[] = [];
  const warnings: string[] = [];
  const cwd = options.cwd ?? resolve(sep, 'work');
  cliEnv.set({});
  const settings = cliEnv.parse();
  const built = new FakeBuilder(memory);
  return {
    lines, warnings, memory, built, builder: built,
    out: { line: (text) => { lines.push(text); }, warn: (text) => { warnings.push(text); } },
    files: memory,
    cwd,
    settings,
    sleep: () => Promise.resolve(),
    stdin: () => linesOf((options.stdin ?? []).map((line) => `${line}\n`)),
    hub: () => (options.hub === undefined ? Promise.reject(new Error('this test has no hub')) : Promise.resolve(options.hub)),
  };
}

/** Put a folder's files into memory: `{ 'system.json': '…', 'server/main.ts': '…' }` under `dir`. */
export function putFolder(files: MemoryFiles, dir: string, contents: Readonly<Record<string, string>>): void {
  for (const [path, body] of Object.entries(contents)) { files.put(join(dir, ...path.split('/')), body); }
}
