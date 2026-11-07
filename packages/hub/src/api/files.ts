/**
 * Content refs on an `@ayepi/files` `FileStore`. Bytes live under `content/<sha-256>`, so the same bytes are stored
 * once. Browsers upload with a presigned `PUT` to `uploads/<id>`; `finish` checks the declared size, hashes the
 * upload and moves it into `content/`. Presigned downloads use the key `content/<hash>/<name>`, which the
 * `NamedContentFiles` wrapper maps back to the bytes, so the browser saves the file under its own name.
 */
import { randomBytes } from 'node:crypto';
import { reject } from '@ayepi/core';
import type { FileBody, FileInfo, FileObject, FileStore, ListOptions, ListResult, Presigner, PutOptions } from '@ayepi/files';
import { CONTENT_HASH, ContentRef } from '@harness/core';
import { contentHash, contentHasher } from '@harness/sdk/server';
import { z } from 'zod';
import type { ContentStore } from './index.ts';

const CONTENT = 'content/';
const UPLOADS = 'uploads/';

/** What the hub remembers about an upload until it is finished. */
const UploadMeta = z.object({ mime: z.string(), size: z.number().int().min(0), expiresAt: z.number().int() });

/** The key the bytes of a ref live under. */
export const contentKey = (hash: string): string => `${CONTENT}${hash}`;

/** Read `length` bytes from `offset` out of a stream, without holding the rest. */
export async function sliceStream(stream: ReadableStream<Uint8Array>, offset: number, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let position = 0;
  let filled = 0;
  const reader = stream.getReader();
  try {
    while (filled < length) {
      const { done, value } = await reader.read();
      if (done) { break; }
      const start = Math.max(0, offset - position);
      const end = Math.min(value.length, offset + length - position);
      if (end > start) {
        out.set(value.subarray(start, end), filled);
        filled += end - start;
      }
      position += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.subarray(0, filled);
}

/** A stream's `ContentRef.hash` and byte count. */
export async function hashStream(stream: ReadableStream<Uint8Array>): Promise<{ hash: string; size: number }> {
  const hash = contentHasher();
  let size = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { hash: hash.digest(), size };
}

/**
 * A `FileStore` that serves `content/<hash>/<name>` from `content/<hash>`, so a presigned download carries a file
 * name. Everything else passes through.
 */
export class NamedContentFiles implements FileStore {
  readonly #inner: FileStore;

  constructor(inner: FileStore) {
    this.#inner = inner;
  }

  put(key: string, body: FileBody, opts?: PutOptions): Promise<FileInfo> {
    return this.#inner.put(key, body, opts);
  }

  get(key: string): Promise<FileObject | undefined> {
    return this.#inner.get(this.#resolve(key));
  }

  head(key: string): Promise<FileInfo | undefined> {
    return this.#inner.head(this.#resolve(key));
  }

  delete(key: string): Promise<boolean> {
    return this.#inner.delete(key);
  }

  list(prefix: string, opts?: ListOptions): Promise<ListResult> {
    return this.#inner.list(prefix, opts);
  }

  #resolve(key: string): string {
    if (!key.startsWith(CONTENT)) { return key; }
    const slash = key.indexOf('/', CONTENT.length);
    return slash === -1 ? key : key.slice(0, slash);
  }
}

/** What the content store needs. */
export interface FileContentOptions {
  readonly files: FileStore;
  readonly presign: Presigner;
  /** The largest upload, in bytes. */
  readonly maxUpload: number;
  /** How long presigned URLs stay valid. */
  readonly presignTtl: number;
  readonly clock: () => number;
}

/** Content refs on a file store. */
export class FileContentStore implements ContentStore {
  readonly #o: FileContentOptions;

  constructor(options: FileContentOptions) {
    this.#o = options;
  }

  async put(bytes: Uint8Array, mime: string): Promise<ContentRef> {
    const hash = contentHash(bytes);
    if ((await this.#o.files.head(contentKey(hash))) === undefined) {
      await this.#o.files.put(contentKey(hash), bytes, { contentType: mime });
    }
    return ContentRef.parse({ hash, size: bytes.length, mime });
  }

  async has(ref: ContentRef): Promise<boolean> {
    return (await this.#o.files.head(contentKey(ref.hash))) !== undefined;
  }

  async read(ref: ContentRef, offset: number, length: number): Promise<Uint8Array> {
    const file = await this.open(ref.hash);
    if (file === undefined) { throw reject(404, 'CONTENT_NOT_FOUND', `no content ${ref.hash}`); }
    return sliceStream(file.stream, offset, length);
  }

  async open(hash: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number; mime: string } | undefined> {
    if (!CONTENT_HASH.test(hash)) { return undefined; }
    const file = await this.#o.files.get(contentKey(hash));
    return file === undefined ? undefined : { stream: file.stream(), size: file.info.size, mime: file.info.contentType ?? 'application/octet-stream' };
  }

  async presignUpload(input: { mime: string; size: number }): Promise<{ url: string; upload: string }> {
    if (input.size > this.#o.maxUpload) { throw reject(413, 'TOO_LARGE', `uploads are limited to ${this.#o.maxUpload} bytes`); }
    const upload = randomBytes(18).toString('base64url');
    const meta = UploadMeta.parse({ mime: input.mime, size: input.size, expiresAt: this.#o.clock() + this.#o.presignTtl });
    await this.#o.files.put(this.#metaKey(upload), JSON.stringify(meta), { contentType: 'application/json' });
    const url = await this.#o.presign.presignUpload(`${UPLOADS}${upload}`, { expiresIn: this.#seconds(), contentType: input.mime });
    return { url, upload };
  }

  async finish(upload: string): Promise<ContentRef> {
    if (!/^[A-Za-z0-9_-]+$/.test(upload)) { throw reject(400, 'BAD_UPLOAD', 'not an upload id'); }
    const metaFile = await this.#o.files.get(this.#metaKey(upload));
    if (metaFile === undefined) { throw reject(404, 'UPLOAD_NOT_FOUND', 'no such upload'); }
    const meta = UploadMeta.parse(JSON.parse(await metaFile.text()));
    const key = `${UPLOADS}${upload}`;
    const file = await this.#o.files.get(key);
    if (file === undefined) { throw reject(409, 'UPLOAD_EMPTY', 'nothing was uploaded'); }
    const { hash, size } = await hashStream(file.stream());
    if (size !== meta.size) {
      await this.#discard(upload);
      throw reject(422, 'UPLOAD_SIZE', `expected ${meta.size} bytes, got ${size}`);
    }
    if ((await this.#o.files.head(contentKey(hash))) === undefined) {
      const again = await this.#o.files.get(key);
      if (again === undefined) { throw reject(409, 'UPLOAD_EMPTY', 'nothing was uploaded'); }
      await this.#o.files.put(contentKey(hash), again.stream(), { contentType: meta.mime });
    }
    await this.#discard(upload);
    return ContentRef.parse({ hash, size, mime: meta.mime });
  }

  /** Remove uploads whose presigned URL has expired and that were never finished. Returns how many. */
  async sweep(): Promise<number> {
    const now = this.#o.clock();
    let removed = 0;
    let cursor: string | undefined;
    do {
      const page = await this.#o.files.list(UPLOADS, { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const file of page.files.filter((f) => f.key.endsWith('.json'))) {
        const meta = await this.#o.files.get(file.key);
        const parsed = meta === undefined ? undefined : UploadMeta.safeParse(JSON.parse(await meta.text()));
        if (parsed?.success !== true || parsed.data.expiresAt < now) {
          await this.#discard(file.key.slice(UPLOADS.length, -'.json'.length));
          removed += 1;
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return removed;
  }

  async presignDownload(ref: ContentRef, name: string): Promise<string> {
    const safe = name.replace(/[/\\]/g, '_').trim() || ref.hash;
    return this.#o.presign.presignDownload(`${contentKey(ref.hash)}/${safe}`, { expiresIn: this.#seconds() });
  }

  async #discard(upload: string): Promise<void> {
    await this.#o.files.delete(`${UPLOADS}${upload}`);
    await this.#o.files.delete(this.#metaKey(upload));
  }

  #metaKey(upload: string): string {
    return `${UPLOADS}${upload}.json`;
  }

  /** `@ayepi/files` takes seconds. */
  #seconds(): number {
    return Math.max(1, Math.round(this.#o.presignTtl / 1000));
  }
}
