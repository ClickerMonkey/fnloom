/**
 * The schedule system's implementation, slice 1 (docs/plans/schedule-system.md, "Build slices"): every fn and the
 * kind are declared and typed by the contract, and each one refuses with "not built yet" and its name. The timer (on
 * `@ayepi/work` in the data folder), the kind's check, describe and run, the Firing records and the notices come with
 * slices 6 and 7, once the hub can start a kind's fns as their owners (slice 3).
 */
import type { UndoOutcome } from '@harness/core';
import type { SystemImpl } from '@harness/sdk';
import type { ScheduleContract } from '../shared/index.ts';
import type { ScheduleSettings } from './env.ts';

/** Everything the implementation is built from. */
export interface ScheduleDeps {
  readonly settings: ScheduleSettings;
}

/** The error code every part not built yet fails with. */
export const NOT_BUILT = 'not-built';

/** What a part not built yet says. */
export function notBuilt(name: string): string {
  return `${name} is not built yet.`;
}

/** What `ctx.fail` is given for a part not built yet. */
const failing = (name: string) => ['fatal', notBuilt(name), { code: NOT_BUILT }] as const;

/** An undo of a fn not built yet. */
function undoNotBuilt(name: string): Promise<UndoOutcome> {
  return Promise.resolve({ status: 'failed', error: { class: 'fatal', message: notBuilt(name), code: NOT_BUILT } });
}

/** Build the schedule system's implementation. */
export function createScheduleImpl(_deps: ScheduleDeps): SystemImpl<ScheduleContract['defs']> {
  return {
    kinds: {
      schedule: {
        check: () => Promise.resolve([notBuilt('schedule/schedule')]),
        describe: () => Promise.reject(new Error(notBuilt('schedule/schedule'))),
        run: (_payload, _args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/schedule'))),
      },
    },
    fns: {
      add: { run: (_args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/add'))), undo: () => undoNotBuilt('schedule/add') },
      change: { run: (_args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/change'))), undo: () => undoNotBuilt('schedule/change') },
      list: { run: (_args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/list'))) },
      pause: { run: (_args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/pause'))), undo: () => undoNotBuilt('schedule/pause') },
      resume: { run: (_args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/resume'))), undo: () => undoNotBuilt('schedule/resume') },
      skip: { run: (_args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/skip'))), undo: () => undoNotBuilt('schedule/skip') },
      remove: { run: (_args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/remove'))), undo: () => undoNotBuilt('schedule/remove') },
      history: { run: (_args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/history'))) },
      remind: { run: (_args, ctx) => Promise.resolve(ctx.fail(...failing('schedule/remind'))) },
    },
  };
}
