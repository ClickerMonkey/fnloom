/**
 * Uploading fetched bytes to the hub. A run's services offer `files.share(path)` only, which reads a file and names
 * its type by extension; the web system has bytes in memory and a detected type. The SDK hands each run's
 * `FilesFactory` the run's content transfer and signal, so `RunUploads` is that factory: it keeps each run's transfer
 * by its signal, and `upload(ctx.signal, …)` uses it. Nothing is kept past the run (the map is weak).
 */
import type { ContentRef } from '@harness/core';
import type { Files } from '@harness/sdk';
import { NodeFiles, type FilesFactory, type FilesScope } from '@harness/sdk/server';
import type { ContentUploads } from './index.ts';

/** The `FilesFactory` for `serve` that also lets fns upload bytes for their run. */
export class RunUploads implements ContentUploads {
  readonly #transfers = new WeakMap<AbortSignal, FilesScope['content']>();
  readonly #files: FilesFactory;

  /** `base` is where `ctx.files` works (the system's state folder). */
  constructor(base: string) {
    this.#files = NodeFiles.at(base);
  }

  /** The factory to pass as `serve`'s `files`. */
  readonly factory: FilesFactory = (scope: FilesScope): Files => {
    this.#transfers.set(scope.signal, scope.content);
    return this.#files(scope);
  };

  upload(signal: AbortSignal, bytes: Uint8Array, mime: string): Promise<ContentRef> {
    const transfer = this.#transfers.get(signal);
    if (transfer === undefined) { return Promise.reject(new Error('No content transfer for this run: the system was not served with RunUploads.factory.')); }
    return transfer.upload(bytes, mime, signal);
  }
}
