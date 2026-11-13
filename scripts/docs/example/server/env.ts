/** The notes system's tunables, an `@ayepi/env` slice. Code reads them through `notesEnv.parse()` in `main.ts`. */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

// #region env
export const notesEnv = env({
  ...systemFields(),
  /** The most notes `find` returns when no limit is given. */
  NOTES_FIND_LIMIT: z.number().int().min(1).default(10),
  /** The most pinned titles the `pinned` hook adds to a message. */
  NOTES_HOOK_TITLES: z.number().int().min(1).default(5),
  /** How many notes `tidy` reads per page. */
  NOTES_TIDY_PAGE: z.number().int().min(1).max(200).default(50),
}).add(systemState('notes'));
// #endregion env

/** The notes system's settings, resolved. */
export type NotesSettings = ReturnType<typeof notesEnv.parse>;
