/**
 * The notes system's server: the implementation (`impl.ts`), its stores (`store.ts`) and the process (`main.ts`). The
 * one outside thing it talks to, where notes are kept, is an interface here, so tests use an in-memory store.
 */
import type { ConfigOf } from '@harness/sdk';
import type { NoteValue, notes } from '../shared/index.ts';

/** The notes system's config, as every context receives it (`ctx.config`). */
export type NotesConfig = ConfigOf<(typeof notes)['defs']>;

// #region store
/** Where one instance keeps its notes. */
export interface NoteStore {
  /** Every note, newest first. */
  all(): Promise<NoteValue[]>;
  get(id: string): Promise<NoteValue | undefined>;
  /** Add the note, or replace the one with its id. */
  put(note: NoteValue): Promise<void>;
  /** Whether there was a note to delete. */
  delete(id: string): Promise<boolean>;
}

/** Opens the store kept in an instance's data folder (`ctx.dataDir`). */
export type OpenStore = (dataDir: string) => NoteStore;
// #endregion store

export { notes } from '../shared/index.ts';
export { createNotesImpl, type NotesDeps } from './impl.ts';
export { JsonNoteStore, MemoryNoteStore, storesBy } from './store.ts';
