/**
 * The browser's logs and API traffic, kept as hub resources: one JSON-lines file per person at a time, under
 * `hub://resources/logs/<person>/`, a folder only that person (and admins) may see. A batch goes into the person's
 * current file, which is kept again as a new version; the next batch starts a new file when the current one would
 * grow past the size limit, or after the quiet spell (a batch more than five minutes after the last, by default).
 * A hub restart starts each person's next batch in a new file.
 */
import { HUB_RESOURCE_ROOT, type ActorId, type ClientLogBatch, type ClientLogReceipt } from '@harness/core';
import type { Logger } from '@ayepi/log';
import type { AccessService } from '../access/index.ts';
import type { ContentStore } from '../api/index.ts';
import type { ResourceLibrary } from '../resources/index.ts';
import type { FnsTuning } from './env.ts';
import type { ClientLogs } from './index.ts';

/** What the writer uses. */
export interface ClientLogDeps {
  readonly content: () => Pick<ContentStore, 'put'>;
  readonly library: () => Pick<ResourceLibrary, 'keepMade'>;
  readonly access: () => Pick<AccessService, 'own'>;
  readonly clock: () => number;
  readonly log: Logger;
  readonly tuning: Pick<FnsTuning, 'HARNESS_CLIENT_LOG_MAX_BYTES' | 'HARNESS_CLIENT_LOG_QUIET'>;
}

/** A person's current file. */
interface OpenFile {
  readonly name: string;
  text: string;
  bytes: number;
  last: number;
}

/** The folder a person's logs go in, under the hub's resources. */
export function logFolder(user: ActorId): string {
  return `logs/${user}`;
}

/** A file's name from when it started: `2026-11-10T14-03-07Z.jsonl`. */
export function logFileName(at: number): string {
  return `${new Date(at).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}.jsonl`;
}

/** The writer, keeping each person's current file in memory between batches. */
export class ResourceClientLogs implements ClientLogs {
  readonly #deps: ClientLogDeps;
  readonly #open = new Map<ActorId, OpenFile>();
  /** One batch at a time per person, so lines keep their order. */
  readonly #writing = new Map<ActorId, Promise<unknown>>();

  constructor(deps: ClientLogDeps) {
    this.#deps = deps;
  }

  write(user: ActorId, batch: ClientLogBatch): Promise<ClientLogReceipt> {
    const before = this.#writing.get(user) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(() => this.#write(user, batch));
    this.#writing.set(user, next);
    return next;
  }

  async #write(user: ActorId, batch: ClientLogBatch): Promise<ClientLogReceipt> {
    const now = this.#deps.clock();
    const lines = batch.entries.map((entry) => JSON.stringify(batch.page === undefined ? entry : { ...entry, page: batch.page })).join('\n') + '\n';
    const bytes = new TextEncoder().encode(lines).length;
    const current = this.#open.get(user);
    const { HARNESS_CLIENT_LOG_MAX_BYTES: most, HARNESS_CLIENT_LOG_QUIET: quiet } = this.#deps.tuning;
    const fresh = current === undefined || now - current.last > quiet || current.bytes + bytes > most;
    const file: OpenFile = fresh ? { name: logFileName(now), text: '', bytes: 0, last: now } : current;
    if (fresh) {
      // the folder is the person's alone; admins see every resource
      await this.#deps.access().own({ kind: 'root', uri: `${HUB_RESOURCE_ROOT}${logFolder(user)}` }, user, { visibility: 'private', with: [] });
      this.#deps.log.info('fns.client-logs.file', { user, file: file.name });
    }
    file.text += lines;
    file.bytes += bytes;
    file.last = now;
    this.#open.set(user, file);
    const content = await this.#deps.content().put(new TextEncoder().encode(file.text), 'application/x-ndjson');
    const record = await this.#deps.library().keepMade({ content, path: logFolder(user), name: file.name, source: { from: 'upload', by: user } }, { actor: user });
    return { uri: record.uri, written: batch.entries.length };
  }
}
