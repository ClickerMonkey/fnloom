/**
 * `harness start [--port <n>] [--data <dir>] [--root <dir>] [--systems <list>]`: start the hub and the default
 * systems on this machine (`scripts/start.ts`, the same supervisor as `npm run dev`), then keep running until Ctrl+C.
 */
import { z } from 'zod';
import { command } from '../command.ts';

export const startHarnessCommand = command({
  path: ['start'],
  summary: 'Start the hub and the default systems here (data in ~/.harness), printing where to open it and how to sign in.',
  usage: '[--port <n>] [--data <dir>] [--root <dir>] [--systems <list>]',
  args: z.object({
    positionals: z.tuple([]),
    values: z.object({
      port: z.string().regex(/^\d+$/, 'a port number').optional(),
      data: z.string().min(1).optional(),
      root: z.string().min(1).optional(),
      systems: z.string().regex(/^[a-z-]+(,[a-z-]+)*$/, 'a comma list such as hub,fs,input').optional(),
    }),
  }),
  run: ({ values }, io) => io.start({ cwd: io.cwd, out: io.out, ...values }),
});
