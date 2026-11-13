/**
 * The notes system's server: the implementation (`impl.ts`) and the process (`main.ts`). Its notes are records the hub
 * keeps (`ctx.data`), so it has no store of its own: its data folder holds nothing shared, and tests run it against
 * the fake hub's data system.
 */
import type { ConfigOf } from '@harness/sdk';
import type { notes } from '../shared/index.ts';

/** The notes system's config, as every context receives it (`ctx.config`). */
export type NotesConfig = ConfigOf<(typeof notes)['defs']>;

export { notes } from '../shared/index.ts';
export { cleanTags, createNotesImpl, entryOf, type NotesDeps } from './impl.ts';
