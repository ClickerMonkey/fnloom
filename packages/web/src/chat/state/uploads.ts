/**
 * Files staged in the composer: each is uploaded as soon as it is added (the hub presigns a URL, the bytes go
 * there with progress, then the hub hashes them into a content ref), shown as a chip with a progress ring, and sent
 * as a `file` part. Send waits while any is still uploading. `sendFile` is the one upload path, shared with voice.
 */
import type { ContentRef, OutgoingPart } from '@harness/core';
import { computed, shallowRef } from 'vue';
import { problemText } from '../../state/problems.ts';
import type { ChatApi, FileSender } from '../api.ts';

/** The callers an upload uses. */
export type UploadApi = Pick<ChatApi, 'upload' | 'uploaded'>;

/** Upload one file and return its content ref. */
export async function sendFile(api: UploadApi, sender: FileSender, file: Blob, name: string, progress: (fraction: number) => void, signal: AbortSignal): Promise<ContentRef> {
  const mime = file.type === '' ? 'application/octet-stream' : file.type;
  const { url, upload } = await api.upload.call({ name, mime, size: file.size });
  await sender.put(url, file, progress, signal);
  return api.uploaded.call({ upload });
}

/** A file in the composer. */
export interface StagedFile {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly status: 'uploading' | 'ready' | 'failed';
  /** 0 to 1. */
  readonly progress: number;
  readonly ref?: ContentRef;
  readonly problem?: string;
  /** A local preview URL for images. */
  readonly preview?: string;
}

/** Make and revoke local preview URLs (the browser's object URLs; tests pass their own). */
export interface Previews {
  make(file: Blob): string | undefined;
  revoke(url: string): void;
}

/** Object URLs for image previews. */
export const browserPreviews: Previews = {
  make: (file) => (file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined),
  revoke: (url) => { URL.revokeObjectURL(url); },
};

interface Entry {
  readonly file: File;
  readonly abort: AbortController;
}

/** The composer's staged files. */
export class UploadQueue {
  readonly #api: UploadApi;
  readonly #sender: FileSender;
  readonly #previews: Previews;
  readonly #entries = new Map<number, Entry>();
  #next = 1;

  readonly items = shallowRef<readonly StagedFile[]>([]);
  /** Whether any file is still uploading. */
  readonly busy = computed(() => this.items.value.some((f) => f.status === 'uploading'));
  /** The files ready to send, as parts. */
  readonly parts = computed<OutgoingPart[]>(() => this.items.value.flatMap((f) => (f.ref === undefined ? [] : [{ type: 'file' as const, ref: f.ref, name: f.name }])));

  constructor(api: UploadApi, sender: FileSender, previews: Previews = browserPreviews) {
    this.#api = api;
    this.#sender = sender;
    this.#previews = previews;
  }

  /** Stage files and start uploading them. */
  add(files: Iterable<File>): void {
    for (const file of files) {
      const id = this.#next++;
      const preview = this.#previews.make(file);
      this.#entries.set(id, { file, abort: new AbortController() });
      this.items.value = [...this.items.value, {
        id, name: file.name === '' ? 'pasted file' : file.name, size: file.size, mime: file.type, status: 'uploading', progress: 0,
        ...(preview === undefined ? {} : { preview }),
      }];
      void this.#upload(id);
    }
  }

  /** Remove a staged file, stopping its upload. */
  remove(id: number): void {
    this.#entries.get(id)?.abort.abort();
    this.#entries.delete(id);
    const gone = this.items.value.find((f) => f.id === id);
    if (gone?.preview !== undefined) { this.#previews.revoke(gone.preview); }
    this.items.value = this.items.value.filter((f) => f.id !== id);
  }

  /** Try a failed upload again. */
  retry(id: number): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) { return; }
    this.#entries.set(id, { file: entry.file, abort: new AbortController() });
    this.#patch(id, { status: 'uploading', progress: 0 });
    void this.#upload(id);
  }

  /** Forget every staged file (after a send), keeping nothing uploading. */
  clear(): void {
    for (const id of [...this.#entries.keys()]) { this.remove(id); }
  }

  async #upload(id: number): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry === undefined) { return; }
    try {
      const ref = await sendFile(this.#api, this.#sender, entry.file, entry.file.name === '' ? 'pasted file' : entry.file.name, (progress) => { this.#patch(id, { progress }); }, entry.abort.signal);
      this.#patch(id, { status: 'ready', progress: 1, ref });
    } catch (error) {
      if (!this.#entries.has(id)) { return; }
      this.#patch(id, { status: 'failed', problem: problemText(error, error instanceof Error ? error.message : 'Upload failed.') });
    }
  }

  #patch(id: number, change: Partial<Omit<StagedFile, 'id'>>): void {
    this.items.value = this.items.value.map((f) => (f.id === id ? { ...f, ...change } : f));
  }
}
