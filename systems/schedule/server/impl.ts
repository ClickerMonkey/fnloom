/**
 * The schedule system's implementation (docs/plans/schedule-system.md): the `schedule/schedule` kind (check, describe,
 * and its run, which is the timer's `runFiring`), the timer itself (`timer.ts`: reconciled at start and on `fns`
 * events, told when runs settle, stopped with the system), and the chat's fns (`fns.ts`: add, change, list, pause,
 * resume, skip, remove, history and remind, over the timer's schedules and limits, the kind's `scheduleProblems` and
 * the hub's `fns_get`, `fns_save` and `fns_remove`).
 */
import type { SystemImpl } from '@harness/sdk';
import { SchedulePayload, ScheduleRunArgs, type ScheduleContract } from '../shared/index.ts';
import type { ScheduleSettings } from './env.ts';
import { scheduleFns } from './fns.ts';
import { describeSchedule, scheduleProblems } from './kind.ts';
import { systemClock, Timer, type Clock } from './timer.ts';

/** Everything the implementation is built from. */
export interface ScheduleDeps {
  readonly settings: ScheduleSettings;
  /** The clock the timer, the kind's runs and the chat fns read (a test's fake one); the wall clock by default. */
  readonly clock?: Clock;
  /** The timer, when the caller keeps one (a test that reads its store); made from the settings otherwise. */
  readonly timer?: Timer;
}


/** Build the schedule system's implementation. */
export function createScheduleImpl(deps: ScheduleDeps): SystemImpl<ScheduleContract['defs']> {
  const clock = deps.clock ?? systemClock;
  const timer = deps.timer ?? new Timer({ settings: deps.settings, clock });
  return {
    kinds: {
      schedule: {
        check: (payload, ctx) => {
          const parsed = SchedulePayload.safeParse(payload);
          return parsed.success ? scheduleProblems(parsed.data, ctx, timer.limits.minGap) : Promise.resolve(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`));
        },
        describe: (payload, ctx) => describeSchedule(SchedulePayload.parse(payload), ctx),
        run: (payload, args, ctx) => timer.runFiring(SchedulePayload.parse(payload), ScheduleRunArgs.parse(args).at, ctx),
      },
    },
    fns: scheduleFns({ timer, clock }),
    events: {
      fns: (event, ctx) => timer.fnsChanged(event, ctx),
      run: (event, ctx) => timer.settled(event, ctx),
    },
    lifecycle: {
      started: (ctx) => timer.start(ctx),
      configured: (ctx) => { timer.configure(ctx); return Promise.resolve(); },
      stopping: () => timer.stop(),
      exporting: () => { timer.checkpoint(); return Promise.resolve(); },
    },
  };
}
