/**
 * Content by reference. Large bytes never ride inside a frame: they move as a `ContentRef` (sha-256, size, mime) and
 * are fetched in base64 chunks no bigger than the hub's `maxChunk`. `HubContent` uploads to and downloads from the hub;
 * `LocalContent` holds content this system produced so the hub can fetch it (`SystemLink.content`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { ContentRef } from '@harness/core';
import type { HubAccess } from './link.ts';

/** Hashes content into its `ContentRef.hash` a piece at a time, for content that arrives as a stream. */
export interface ContentHasher {
  update(bytes: Uint8Array): ContentHasher;
  /** The hash of everything given so far. */
  digest(): string;
}

/**
 * A hasher for `ContentRef.hash`: sha-256, hex. The one definition of a content ref's hash, used by the SDK, the
 * systems and the hub's content store.
 */
export function contentHasher(): ContentHasher {
  const hash = createHash('sha256');
  const hasher: ContentHasher = {
    update: (bytes) => { hash.update(bytes); return hasher; },
    digest: () => hash.digest('hex'),
  };
  return hasher;
}

/** The `ContentRef.hash` of some bytes. */
export function contentHash(bytes: Uint8Array): string {
  return contentHasher().update(bytes).digest();
}

/** The raw bytes that fit in one base64 chunk of at most `maxChunk` characters. */
export function rawChunkSize(maxChunk: number): number {
  return Math.max(1, Math.floor(maxChunk / 4) * 3);
}

/** Moves content between this system and the hub. */
export interface ContentTransfer {
  /** Upload bytes to the hub; returns their ref. */
  upload(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<ContentRef>;
  /** Download content by ref, from the hub (which may in turn fetch it from the system that holds it). */
  download(ref: ContentRef, signal?: AbortSignal): Promise<Uint8Array>;
}

/** `ContentTransfer` over the link. */
export class HubContent implements ContentTransfer {
  readonly #hub: HubAccess;

  constructor(hub: HubAccess) {
    this.#hub = hub;
  }

  async upload(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<ContentRef> {
    const hub = await this.#hub.ready(signal);
    const size = rawChunkSize(this.#hub.limits().maxChunk);
    const upload = randomUUID();
    for (let offset = 0; ; offset += size) {
      const last = offset + size >= bytes.length;
      const chunk = Buffer.from(bytes.subarray(offset, offset + size)).toString('base64');
      const reply = await hub.call('upload', { upload, chunk, last, mime }, signal === undefined ? {} : { signal });
      if (last) {
        if (reply.ref === undefined) { throw new Error('The hub took the upload but returned no content ref.'); }
        return reply.ref;
      }
    }
  }

  async download(ref: ContentRef, signal?: AbortSignal): Promise<Uint8Array> {
    const hub = await this.#hub.ready(signal);
    const size = rawChunkSize(this.#hub.limits().maxChunk);
    const out = new Uint8Array(ref.size);
    for (let offset = 0; offset < ref.size; offset += size) {
      const length = Math.min(size, ref.size - offset);
      const { chunk } = await hub.call('content', { ref, offset, length }, signal === undefined ? {} : { signal });
      out.set(Buffer.from(chunk, 'base64'), offset);
    }
    if (contentHash(out) !== ref.hash) { throw new Error(`Content ${ref.hash} came back with a different hash.`); }
    return out;
  }
}

/**
 * Content this system holds for the hub to fetch, kept up to a byte budget (oldest dropped first). Resource reads put
 * long text here and send its ref instead.
 */
export class LocalContent {
  readonly #entries = new Map<string, Uint8Array>();
  readonly #budget: number;
  #bytes = 0;

  constructor(budget: number) {
    this.#budget = budget;
  }

  /** Keep bytes; returns their ref. */
  put(bytes: Uint8Array, mime: string): ContentRef {
    const hash = contentHash(bytes);
    if (!this.#entries.has(hash)) {
      this.#entries.set(hash, bytes);
      this.#bytes += bytes.length;
      this.#trim(hash);
    }
    return ContentRef.parse({ hash, size: bytes.length, mime });
  }

  /** A base64 chunk of held content, or `undefined` when it isn't held. */
  chunk(ref: ContentRef, offset: number, length: number): string | undefined {
    const bytes = this.#entries.get(ref.hash);
    if (bytes === undefined) { return undefined; }
    return Buffer.from(bytes.subarray(offset, offset + length)).toString('base64');
  }

  #trim(keep: string): void {
    for (const [hash, bytes] of this.#entries) {
      if (this.#bytes <= this.#budget) { return; }
      if (hash === keep) { continue; }
      this.#entries.delete(hash);
      this.#bytes -= bytes.length;
    }
  }
}
