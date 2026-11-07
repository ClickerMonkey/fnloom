/**
 * `ctx.resources`: reading any resource the actor may see. The hub routes each URI to the system that serves it, so
 * this goes through `HubLink.resource`; long text comes back by ref and is downloaded in chunks.
 */
import { ApiError } from '@ayepi/core';
import type { ReadWant, ResourceHit, ResourceLink, ResourceRead, ResourceStat, ResourceUri, RunId, Section, SectionKey } from '@harness/core';
import type { Resources } from '../ctx.ts';
import type { ContentTransfer } from './content.ts';
import type { HubAccess } from './link.ts';
import { LinkGap } from './wire.ts';

/** `Resources` over the link, on behalf of a run (or of the system itself, outside runs). */
export class HubResources implements Resources {
  readonly #hub: HubAccess;
  readonly #content: ContentTransfer;
  readonly #run: RunId | undefined;
  readonly #signal: AbortSignal | undefined;

  constructor(hub: HubAccess, content: ContentTransfer, scope: { run?: RunId; signal?: AbortSignal }) {
    this.#hub = hub;
    this.#content = content;
    this.#run = scope.run;
    this.#signal = scope.signal;
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

  async links(uri: ResourceUri): Promise<ResourceLink[]> {
    return (await this.#read(uri, ['links']))?.links ?? [];
  }

  sections(_uri: ResourceUri): Promise<Section[]> {
    return Promise.reject(new LinkGap('Listing a resource\'s sections needs a hub endpoint the link does not have yet.'));
  }

  search(_query: string): Promise<ResourceHit[]> {
    return Promise.reject(new LinkGap('Searching resources from a system needs a hub endpoint; declare hub.fns.search_resources as a dep and call it.'));
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
