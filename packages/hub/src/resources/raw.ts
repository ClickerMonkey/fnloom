/**
 * Reading a system resource's raw content: the system is asked for its bytes, its own text and its links in one
 * read. Content it hands out by ref is read from the hub's content store when the system uploaded it there
 * (`ctx.files.share`), else fetched in chunks of the link's largest chunk from the instance serving the URI. A seam
 * (`RawReader`) so the forms service is tested without a link.
 */
import { reject } from '@ayepi/core';
import type { ContentRef, ResourceLink, ResourceStat, ResourceUri, SystemName } from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import type { LinkService, ResourceRouter } from '../link/index.ts';

/** A resource's raw content as its system sent it. */
export interface RawResource {
  /** The system that served it. */
  readonly system: SystemName;
  readonly stat: ResourceStat;
  readonly links: ResourceLink[];
  /** The bytes, when the system sent them. */
  readonly bytes?: Uint8Array;
  /** The system's own text (one it converted itself, a record's text), when it sent one. */
  readonly text?: string;
}

/** Reads system resources' raw content. */
export interface RawReader {
  read(uri: ResourceUri, signal?: AbortSignal): Promise<RawResource>;
  /** What the system says about a resource now (its version tells whether a snapshot is current). */
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
}

/** What reading over the link needs. */
export interface LinkRawReaderOptions {
  readonly router: () => ResourceRouter;
  readonly links: () => LinkService;
  /** The hub's content store, where a system may have uploaded the bytes already. */
  readonly content: Pick<ContentStore, 'has' | 'read'>;
  /** The largest chunk asked for at once (`HARNESS_MAX_CHUNK`). */
  readonly maxChunk: number;
}

/** Raw content over the system link. */
export class LinkRawReader implements RawReader {
  readonly #o: LinkRawReaderOptions;

  constructor(options: LinkRawReaderOptions) {
    this.#o = options;
  }

  async read(uri: ResourceUri, signal?: AbortSignal): Promise<RawResource> {
    const route = this.#o.router().route(uri);
    const connection = route === undefined ? undefined : this.#o.links().connection(route.system, route.instance);
    if (connection === undefined) { throw reject(404, 'NO_RESOURCE', `no connected system serves ${uri}`); }
    const options = signal === undefined ? {} : { signal };
    const read = await connection.peer.call('read', { uri, want: ['bytes', 'text', 'links'] }, options);
    const fetch = async (ref: ContentRef): Promise<Uint8Array> => {
      if (await this.#o.content.has(ref)) { return this.#o.content.read(ref, 0, ref.size); }
      const parts: Uint8Array[] = [];
      let offset = 0;
      while (offset < ref.size) {
        const { chunk } = await connection.peer.call('content', { ref, offset, length: Math.min(this.#o.maxChunk, ref.size - offset) }, options);
        const bytes = Buffer.from(chunk, 'base64');
        if (bytes.length === 0) { break; }
        parts.push(bytes);
        offset += bytes.length;
      }
      if (offset !== ref.size) { throw reject(502, 'CONTENT_SHORT', `${connection.system} sent ${offset} of the ${ref.size} bytes of ${uri}`); }
      return Buffer.concat(parts);
    };
    const bytes = read.bytes === undefined ? undefined : await fetch(read.bytes);
    const text = read.text === undefined ? undefined : 'inline' in read.text ? read.text.inline : Buffer.from(await fetch(read.text.ref)).toString('utf8');
    return { system: connection.system, stat: read.stat, links: read.links ?? [], ...(bytes === undefined ? {} : { bytes }), ...(text === undefined ? {} : { text }) };
  }

  stat(uri: ResourceUri): Promise<ResourceStat | undefined> {
    return this.#o.router().stat(uri);
  }
}
