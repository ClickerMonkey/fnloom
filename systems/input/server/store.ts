/**
 * Saved forms. Each is also an `input/form` fn the system adds at runtime; this store keeps what the hub doesn't:
 * who saved it, who may reuse it, and the embedding `get_input` matches descriptions against. `FileForms` keeps them
 * as one JSON file in the system's data folder; `MemoryForms` is for tests.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ActorId, LocalName, Timestamp, Visibility } from '@harness/core';
import { z } from 'zod';
import { InputFormSchema } from '../shared/index.ts';

/** A saved form. */
export const SavedRecord = z.object({
  /** Its fn's local name (`trip_details`). */
  name: LocalName,
  title: z.string(),
  description: z.string(),
  form: InputFormSchema,
  owner: ActorId,
  visibility: Visibility,
  /** The embedding of its title and description; empty when embedding failed. */
  vector: z.array(z.number()),
  savedAt: Timestamp,
});
export type SavedRecord = z.infer<typeof SavedRecord>;

/** Where saved forms are kept. */
export interface FormStore {
  all(): Promise<SavedRecord[]>;
  /** Add a form, or replace the one with its name. */
  put(record: SavedRecord): Promise<void>;
}

/** Saved forms in memory. */
export class MemoryForms implements FormStore {
  readonly records = new Map<string, SavedRecord>();

  all(): Promise<SavedRecord[]> {
    return Promise.resolve([...this.records.values()]);
  }

  put(record: SavedRecord): Promise<void> {
    this.records.set(record.name, record);
    return Promise.resolve();
  }
}

/** Saved forms in `<dataDir>/forms.json`, written whole (through a temp file) on each change. */
export class FileForms implements FormStore {
  readonly #file: string;
  #cache: Map<string, SavedRecord> | undefined;

  constructor(dataDir: string) {
    this.#file = join(dataDir, 'forms.json');
  }

  async all(): Promise<SavedRecord[]> {
    return [...(await this.#load()).values()];
  }

  async put(record: SavedRecord): Promise<void> {
    const records = await this.#load();
    records.set(record.name, record);
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(`${this.#file}.tmp`, JSON.stringify([...records.values()]), 'utf8');
    await rename(`${this.#file}.tmp`, this.#file);
  }

  async #load(): Promise<Map<string, SavedRecord>> {
    if (this.#cache !== undefined) { return this.#cache; }
    let text: string | undefined;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { throw error; }
    }
    const records = text === undefined ? [] : SavedRecord.array().parse(JSON.parse(text));
    this.#cache = new Map(records.map((record) => [record.name, record]));
    return this.#cache;
  }
}
