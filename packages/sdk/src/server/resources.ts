/**
 * `ctx.resources`: reading any resource the actor may see. The hub routes each URI to the system that serves it, so
 * this goes through `HubLink.resource`; long text comes back by ref and is downloaded in chunks. Searching needs a
 * person to search as: a mention provider's `search` has one (the hub's `@` search request, `mentionResources`).
 */
import { ApiError } from '@ayepi/core';
import type { MentionRequestId, ReadWant, ResourceHit, ResourceLink, ResourceRead, ResourceStat, ResourceUri, RunId, Section, SectionKey } from '@harness/core';
import type { Resources } from '../ctx.ts';
import type { ContentTransfer } from './content.ts';
import type { HubAccess } from './link.ts';
import { LinkGap } from './wire.ts';

/** How many hits a mention's resource search asks for when it names no limit. */
const MENTION_SEARCH_LIMIT = 10;

/** `Resources` over the link, on behalf of a run (or of the system itself, outside runs). */
export class HubResources implements Resources {
  readonly #hub: HubAccess;
  readonly #content: ContentTransfer;
  readonly #run: RunId | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #mention: MentionRequestId | undefined;

  /** `mention`: the hub's `@` search request this context answers, which a search runs as. */
  constructor(hub: HubAccess, content: ContentTransfer, scope: { run?: RunId; signal?: AbortSignal; mention?: MentionRequestId }) {
    this.#hub = hub;
    this.#content = content;
    this.#run = scope.run;
    this.#signal = scope.signal;
    this.#mention = scope.mention;
  }

  async stat(uri: ResourceUri): Promise<ResourceStat | undefined> {
    const read = await this.#read(uri, []);
    return read?.stat;
  }

  async text(uri: ResourceUri, sections?: SectionKey[]): Promise<string> {
    if (sections !== undefined && sections.length > 0) {
      throw new LinkGap('Reading chosen sections needs a hub endpoint the link does not have yet; read the whole text.');
    }
    const read = await this.#read(uri, ['text']);
    if (read === undefined) { throw new Error(`No resource at ${uri}.`); }
    if (read.text === undefined) { return ''; }
    if ('inline' in read.text) { return read.text.inline; }
    return new TextDecoder().decode(await this.#content.download(read.text.ref, this.#signal));
  }

  async bytes(uri: ResourceUri): Promise<Uint8Array> {
    const read = await this.#read(uri, ['bytes']);
    if (read === undefined) { throw new Error(`No resource at ${uri}.`); }
    if (read.bytes !== undefined) { return await this.#content.download(read.bytes, this.#signal); }
    // a resource with no raw form (a page, a record) is its text
    return new TextEncoder().encode(await this.text(uri));
  }

  async links(uri: ResourceUri): Promise<ResourceLink[]> {
    return (await this.#read(uri, ['links']))?.links ?? [];
  }

  async sections(uri: ResourceUri): Promise<Section[]> {
    const hub = await this.#hub.ready(this.#signal);
    return hub.call('resourceSections', { uri, ...(this.#run === undefined ? {} : { run: this.#run }) }, this.#signal === undefined ? {} : { signal: this.#signal });
  }

  async search(query: string, options: { roots?: ResourceUri[]; limit?: number } = {}): Promise<ResourceHit[]> {
    if (this.#mention === undefined) {
      throw new LinkGap('Searching resources needs a person to search as: it works in the search of a mention provider; a fn declares hub.fns.search_resources as a dep and calls it.');
    }
    const hub = await this.#hub.ready(this.#signal);
    const { hits } = await hub.call('mentionResources', {
      request: this.#mention,
      query,
      limit: options.limit ?? MENTION_SEARCH_LIMIT,
      ...(options.roots === undefined ? {} : { roots: options.roots }),
    }, this.#signal === undefined ? {} : { signal: this.#signal });
    return hits;
  }

  async #read(uri: ResourceUri, want: ReadWant[]): Promise<ResourceRead | undefined> {
    const hub = await this.#hub.ready(this.#signal);
    try {
      return await hub.call('resource', { uri, want, ...(this.#run === undefined ? {} : { run: this.#run }) }, this.#signal === undefined ? {} : { signal: this.#signal });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) { return undefined; }
      throw error;
    }
  }
}
