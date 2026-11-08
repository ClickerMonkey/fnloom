/**
 * Note stores: a JSON file in the instance's data folder for the real process, and memory for tests. Notes are written
 * with the contract's own gin type (`encodeValue`) and read back with it (`parseValue`), so a file that doesn't fit
 * the type is refused instead of read wrongly.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeValue, g, parseValue } from '@harness/sdk';
import { Note, type NoteValue } from '../shared/index.ts';
import type { NoteStore, OpenStore } from './index.ts';

const NoteList = g.list(Note.shape);

/** Newest first. */
function newestFirst(list: readonly NoteValue[]): NoteValue[] {
  return [...list].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** Notes in memory. */
export class MemoryNoteStore implements NoteStore {
  readonly #notes = new Map<string, NoteValue>();

  all(): Promise<NoteValue[]> { return Promise.resolve(newestFirst([...this.#notes.values()])); }
  get(id: string): Promise<NoteValue | undefined> { return Promise.resolve(this.#notes.get(id)); }
  put(note: NoteValue): Promise<void> { this.#notes.set(note.id, note); return Promise.resolve(); }
  delete(id: string): Promise<boolean> { return Promise.resolve(this.#notes.delete(id)); }
}

/** Notes in `notes.json` in a folder, written whole through a temp file so a crash never leaves half a file. */
export class JsonNoteStore implements NoteStore {
  readonly #file: string;
  readonly #folder: string;

  constructor(folder: string) {
    this.#folder = folder;
    this.#file = join(folder, 'notes.json');
  }

  async all(): Promise<NoteValue[]> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return []; }
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    return newestFirst(parseValue(NoteList, parsed));
  }

  async get(id: string): Promise<NoteValue | undefined> {
    return (await this.all()).find((note) => note.id === id);
  }

  async put(note: NoteValue): Promise<void> {
    await this.#write([note, ...(await this.all()).filter((n) => n.id !== note.id)]);
  }

  async delete(id: string): Promise<boolean> {
    const list = await this.all();
    const kept = list.filter((n) => n.id !== id);
    if (kept.length === list.length) { return false; }
    await this.#write(kept);
    return true;
  }

  async #write(list: NoteValue[]): Promise<void> {
    await mkdir(this.#folder, { recursive: true });
    const temp = `${this.#file}.tmp`;
    await writeFile(temp, JSON.stringify(encodeValue(NoteList, list)));
    await rename(temp, this.#file);
  }
}

/** One store per data folder, made on first use by `make`. */
export function storesBy(make: (dataDir: string) => NoteStore): OpenStore {
  const open = new Map<string, NoteStore>();
  return (dataDir) => {
    const found = open.get(dataDir);
    if (found !== undefined) { return found; }
    const store = make(dataDir);
    open.set(dataDir, store);
    return store;
  };
}
