/** The notes system's tunables, an `@ayepi/env` slice. Code reads them through `notesEnv.parse()` in `main.ts`. */
import { env } from '@ayepi/env';
import { systemFields } from '@harness/sdk/server';
import { z } from 'zod';

// #region env
export const notesEnv = env({
  ...systemFields('notes'),
  /** The most notes `find` returns when no limit is given. */
  NOTES_FIND_LIMIT: z.number().int().min(1).default(10),
  /** The most pinned titles the `pinned` hook adds to a message. */
  NOTES_HOOK_TITLES: z.number().int().min(0).default(5),
});
// #endregion env

/** The notes system's settings, resolved. */
export type NotesSettings = ReturnType<typeof notesEnv.parse>;
