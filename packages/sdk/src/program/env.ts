/**
 * The gin program runtime's tunables, an `@ayepi/env` slice: how far a program may go when it runs (a code fn, an api
 * fn's request and output programs, an authoring agent's test run) and how much an authoring agent is shown at once.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

export const programEnv = env({
  /** The longest one program run may take, in milliseconds (fn calls included). */
  HARNESS_PROGRAM_TIMEOUT: z.coerce.number().int().min(100).default(30_000),
  /**
   * The longest stretch, in milliseconds, one program run holds the thread before it lets other work on the system in
   * (and a deadline or cancel land).
   */
  HARNESS_PROGRAM_SLICE: z.coerce.number().int().min(1).max(1_000).default(10),
  /** The most fn calls one program run may make. */
  HARNESS_PROGRAM_MAX_CALLS: z.coerce.number().int().min(0).default(50),
  /** The most complex program accepted (gin's `complexity()`: loops and lambdas cost more). */
  HARNESS_PROGRAM_MAX_COMPLEXITY: z.coerce.number().int().min(10).default(600),
  /** The fns one authoring search lists. */
  HARNESS_PROGRAM_SEARCH_LIMIT: z.coerce.number().int().min(1).max(50).default(8),
  /** The characters of type definitions one load prints before it lists the rest by name. */
  HARNESS_PROGRAM_TYPE_CHARS: z.coerce.number().int().min(500).default(4_000),
  /** The characters of a result an authoring agent is shown. */
  HARNESS_PROGRAM_PREVIEW_CHARS: z.coerce.number().int().min(200).default(2_000),
});

/** The program runtime's settings, resolved. */
export type ProgramSettings = ReturnType<typeof programEnv.parse>;
