/**
 * The schedule system's contract (`shared/`), after docs/plans/schedule-system.md ("Types (final, for approval)"). A
 * schedule is a fn of the kind `schedule/schedule`: its payload names a fn to run, *when* as a dayspan schedule, a time
 * zone, and the args as a gin program worked out at each firing. The hub keeps, versions and shares it like any saved
 * fn; this system owns the timer that starts each firing as the schedule's owner, records it (`schedule/Firing`) and
 * notifies the owner how it went.
 *
 * - **The kind** `schedule/schedule`: running a schedule fn by name is "run now"; the timer passes the planned `at`.
 * - **The chat's fns** (group `schedules`): add, change, list, pause, resume, skip, remove, history, and `remind`, a fn
 *   that only notifies its own person, made to be scheduled.
 * - **The injected item** `schedule/basics` says, in every chat, that fns can run later by themselves and how.
 * - **The pages**: the calendar (`/s/schedule/calendar`), one schedule (`item`) and every schedule (`all`, admins).
 *
 * The shapes are zod in `types.ts`; everything here is gin made from them (`ginAs`), so each type has one source.
 */
import { agents, context, fn, g, ginAs, hub, json, kind, partialOf, system, type, type Infer } from '@harness/sdk';
import { ClockTime, FiringShape, FiringStatus, LocalDay, Missed, Notify, Overlap, SchedulePayload, ScheduleView, When, Zone } from './types.ts';

export * from './types.ts';
export { isIanaZone, localNow, localString, offsetAt, zonedTime } from './zoned.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The limits an admin leaves unset: 15 minutes, 50 schedules, 200 firings a day, 6 hours' grace, wait for approvals, keep 500 and 180 days. */
export const LIMIT_DEFAULTS = {
  minGap: 15 * MINUTE,
  perPerson: 50,
  firingsPerDay: 200,
  grace: 6 * HOUR,
  approvals: 'wait',
  keep: { perSchedule: 500, days: 180 },
} as const satisfies Limits;

/**
 * The system's config: the limits an admin sets. Every field may be left out, for its default (`LIMIT_DEFAULTS`);
 * `limitsOf` gives the value with the defaults filled in.
 */
export const Limits = g.obj({
  minGap: g.field(g.optional(g.duration()), { docs: 'The shortest gap between two firings of one schedule (default 15 minutes).' }),
  perPerson: g.field(g.optional(g.num({ min: 1, whole: true })), { docs: 'Schedules one person may have (default 50).' }),
  firingsPerDay: g.field(g.optional(g.num({ min: 1, whole: true })), { docs: 'Firings one person may have in a day (default 200).' }),
  grace: g.field(g.optional(g.duration()), { docs: 'How late a missed firing may still run (default 6 hours).' }),
  approvals: g.field(g.optional(g.enum(['wait', 'refuse'])), { docs: 'A firing that needs approval waits for its person (default), or is refused.' }),
  keep: g.field(g.optional(g.obj({ perSchedule: g.num({ min: 1, whole: true }), days: g.num({ min: 1, whole: true }) })), { docs: 'How many firings are kept per schedule, and for how many days (default 500 and 180).' }),
});
/** The limits, with every one filled in. */
export type Limits = Required<Infer<typeof Limits>>;

/** The config with its defaults filled in. */
export function limitsOf(config: Infer<typeof Limits>): Limits {
  return {
    minGap: config.minGap ?? LIMIT_DEFAULTS.minGap,
    perPerson: config.perPerson ?? LIMIT_DEFAULTS.perPerson,
    firingsPerDay: config.firingsPerDay ?? LIMIT_DEFAULTS.firingsPerDay,
    grace: config.grace ?? LIMIT_DEFAULTS.grace,
    approvals: config.approvals ?? LIMIT_DEFAULTS.approvals,
    keep: config.keep ?? LIMIT_DEFAULTS.keep,
  };
}

/** What schedule/add is asked besides the fn; change takes the same, all optional (`partialOf`), plus `schedule`. */
const Settings = {
  when: g.field(ginAs(When), { docs: 'When it runs, in the dayspan form: `on` for once, or day rules with `times`.' }),
  args: g.field(g.optional(json()), { docs: 'Fixed args for the fn, checked against its args.' }),
  compute: g.field(g.optional(g.text({ minLength: 1 })), { docs: 'Args that change with each run, in plain words.' }),
  name: g.field(g.optional(g.text({ minLength: 1 })), { docs: 'What it does, for its fn name and title.' }),
  zone: g.field(g.optional(ginAs(Zone)), { docs: 'The time zone; the person\'s when left out.' }),
  notify: g.field(g.optional(ginAs(Notify)), { docs: 'When the person is notified of a run: always (default), failed, never.' }),
  overlap: g.field(g.optional(ginAs(Overlap)), { docs: 'A run due while the last still runs: skip (default), queue, replace.' }),
  missed: g.field(g.optional(ginAs(Missed)), { docs: 'Runs missed while the hub was down: latest (default), none.' }),
  maxSpend: g.field(g.optional(g.num({ min: 0 })), { docs: 'The most one run may spend, in USD.' }),
};
/** What schedule/add is asked. */
export const AddArgs = g.obj({ fn: g.field(g.fnName(), { docs: 'The fn to run, as your tools spell it.' }), ...Settings });
/** What schedule/change is asked: the schedule, and any of add's fields. */
export const ChangeArgs = g.obj({
  schedule: g.field(g.fnName(), { docs: 'The schedule to change, by its name.' }),
  fn: g.field(g.optional(g.fnName()), { docs: 'Another fn for it to run.' }),
  ...partialOf(Settings),
});
/** One schedule, by its name. */
export const ScheduleArg = g.obj({ schedule: g.field(g.fnName(), { docs: 'The schedule, by its name.' }) });
/** A schedule as the chat's results and the pages show it. */
export const View = ginAs(ScheduleView);
/** How a change of a schedule is undone: going back to the version it replaced. */
export const VersionBefore = g.obj({ schedule: g.fnName(), version: g.num({ min: 1, whole: true }) });

/** A firing record: one firing of a schedule that was due. */
export const Firing = type({
  description: 'One firing of a schedule that was due: when, its status, its summary and its run.',
  shape: ginAs(FiringShape),
  display: { label: 'Firing', plural: 'Firings', icon: 'clock', title: 'schedule', subtitle: 'summary' },
  records: { shape: 'table', owner: 'person', search: { text: ['schedule', 'summary'], embed: false } },
});

/** Words for a phase, the same for one run and for a group. */
const phases = (active: string, done: string, failed: string) => ({
  active: { one: active, many: active },
  retry: { one: active, many: active },
  done: { one: done, many: done },
  failed: { one: failed, many: failed },
});

/** A schedule that runs every Monday at 9:00, as the examples write it. */
const MONDAYS = { dayOfWeek: [1], times: ['09:00'] };

/** The schedule system's contract. */
export const schedule = system('schedule', {
  description: 'Runs fns later by themselves, once or repeating, as the person who scheduled them, and notifies them how each run went.',
  about: [
    'Scheduled runs: a fn of the person\'s runs later by itself, once on a day or repeating by days of the week or month at times of day, in their time zone, as them.',
    'schedule/add saves a schedule, a fn of the kind schedule/schedule named for what it does; its args can be fixed, or worked out for each run from words such as "the day it runs, minus 7 days".',
    'Each run\'s result reaches the person as a notification with a one-line summary and a link to the run, never in a chat; the Schedule page shows every schedule\'s past and coming runs.',
    'Reach for it when the person wants something done at a time or on a repeat, or to be reminded (schedule/remind). It runs only at times, never because something else happened. Load schedule/guide before the first one.',
  ].join(' '),
  groups: [{ name: 'schedules', title: 'Schedules', description: 'Add, change, pause and remove scheduled runs of fns.' }],
  // it keeps firings as records, saves schedules as hub fns, finds the fns they run, and writes computed args on a model.
  // TODO(slice 3): add the `runs` capability (start its own kind's fns as their owners and notify them) and
  // `hub.fns.fns_remove.name` to the calls, once the hub has them.
  grants: { hub: ['data', 'fns', 'search', 'ai'], calls: [hub.fns.fns_get.name, hub.fns.fns_save.name] },
  pages: [
    { segment: 'calendar', title: 'Schedule', description: 'Your scheduled runs on a calendar.', icon: 'calendar', nav: 'main', component: 'CalendarPage' },
    { segment: 'item', title: 'Schedule', description: 'One schedule: when it runs, its history, and its controls.', nav: 'hidden', component: 'SchedulePage' },
    { segment: 'all', title: 'All schedules', description: 'Every schedule on the hub, by owner, with pause.', nav: 'hidden', access: 'admin', component: 'AllSchedulesPage' },
  ],
})
  .with({
    config: Limits,
    types: { Firing },
    kinds: {
      schedule: kind({
        description: 'A schedule: runs one fn later by itself, at the times its dayspan schedule gives, as its owner, who is notified how it went. Calling it by name runs it now.',
        applicability: 'Something the person wants done at a time or on a repeating schedule, made by schedule/add.',
        payload: ginAs(SchedulePayload),
        // saving one is schedule/add's write, which the person approves; the hub does not ask again
        approveChanges: false,
        status: phases('Running {fn}…', 'Ran {fn}', '{fn} failed'),
      }),
    },
  })
  .with(({ kinds, types }) => ({
    fns: {
      add: fn({
        group: 'schedules',
        description: 'Schedule a fn to run later by itself, once or repeating, as the person; gives the schedule, when it runs in words, its next times and when the person is notified.',
        args: AddArgs,
        returns: View,
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        undo: ScheduleArg,
        effects: { mode: 'write', registry: [{ thing: 'fns', action: 'create', kind: kinds.schedule.name }] },
        status: phases('Scheduling {args.fn}…', 'Scheduled {output.schedule}', 'Scheduling {args.fn} failed'),
        examples: [
          { args: { fn: 'database/main.orders_by_week', when: MONDAYS, compute: 'week_start: the firing\'s day minus 7 days' }, note: 'Every Monday at 9:00, the week before.' },
          { args: { fn: 'schedule/remind', when: { on: '2026-12-01', times: ['08:30'] }, args: { text: 'Renew the domain name.' } }, note: 'A one-off reminder.' },
          { args: { fn: 'fs/nightly_backup', when: { dayOfWeek: [0, 1, 2, 3, 4, 5, 6], times: ['02:00'] }, notify: 'failed' }, note: 'Every night; tell me only when it fails.' },
        ],
      }),
      change: fn({
        group: 'schedules',
        description: 'Change a schedule: what it runs, when, its args, its zone, or when the person is notified; saves a new version and plans its next run again.',
        args: ChangeArgs,
        returns: View,
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        undo: VersionBefore,
        effects: { mode: 'write', registry: [{ thing: 'fns', action: 'update', kind: kinds.schedule.name }] },
        status: phases('Changing {args.schedule}…', 'Changed {args.schedule}', 'Changing {args.schedule} failed'),
        examples: [
          { args: { schedule: 'schedule/weekly_orders_summary', when: { dayOfWeek: [1, 4], times: ['09:00'] } }, note: 'Mondays and Thursdays instead.' },
          { args: { schedule: 'schedule/nightly_backup', notify: 'always' }, note: 'Tell me after every run, not only failures.' },
        ],
      }),
      list: fn({
        group: 'schedules',
        description: 'The person\'s schedules, each with when it runs in words, its next run and how the last one went.',
        args: g.obj({
          fn: g.field(g.optional(g.fnName()), { docs: 'Only schedules that run this fn.' }),
          search: g.field(g.optional(g.text()), { docs: 'Words in a schedule\'s name or title.' }),
          paused: g.field(g.optional(g.bool()), { docs: 'Only paused (true) or running (false) schedules.' }),
        }),
        returns: g.obj({ items: g.list(View), cursor: g.optional(g.text()) }),
        effects: { mode: 'read', free: true },
        status: phases('Listing schedules…', 'Listed schedules', 'Listing schedules failed'),
        examples: [
          { args: {}, note: 'All of them.' },
          { args: { fn: 'schedule/remind' }, note: 'The person\'s scheduled reminders.' },
        ],
      }),
      pause: fn({
        group: 'schedules',
        description: 'Pause a schedule, until a day or until it is resumed; nothing runs while it is paused.',
        args: g.obj({
          schedule: g.field(g.fnName(), { docs: 'The schedule, by its name.' }),
          until: g.field(g.optional(ginAs(LocalDay)), { docs: 'The day it starts running again (YYYY-MM-DD); absent, until it is resumed.' }),
        }),
        returns: View,
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        undo: VersionBefore,
        effects: { mode: 'write', registry: [{ thing: 'fns', action: 'update', kind: kinds.schedule.name }] },
        status: phases('Pausing {args.schedule}…', 'Paused {args.schedule}', 'Pausing {args.schedule} failed'),
        examples: [
          { args: { schedule: 'schedule/weekly_orders_summary' }, note: 'Until it is resumed.' },
          { args: { schedule: 'schedule/weekly_orders_summary', until: '2027-01-04' }, note: 'Runs again from 4 January.' },
        ],
      }),
      resume: fn({
        group: 'schedules',
        description: 'Resume a paused schedule: its next run is planned again from now.',
        args: ScheduleArg,
        returns: View,
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        undo: VersionBefore,
        effects: { mode: 'write', registry: [{ thing: 'fns', action: 'update', kind: kinds.schedule.name }] },
        status: phases('Resuming {args.schedule}…', 'Resumed {args.schedule}', 'Resuming {args.schedule} failed'),
        examples: [{ args: { schedule: 'schedule/weekly_orders_summary' } }],
      }),
      skip: fn({
        group: 'schedules',
        description: 'Skip one run of a schedule: the run on a day, or at one time of that day; the rest go on.',
        args: g.obj({
          schedule: g.field(g.fnName(), { docs: 'The schedule, by its name.' }),
          day: g.field(ginAs(LocalDay), { docs: 'The day of the run to skip (YYYY-MM-DD), in the schedule\'s zone.' }),
          time: g.field(g.optional(ginAs(ClockTime)), { docs: 'The time of the run to skip (HH:mm), when it runs more than once that day.' }),
        }),
        returns: View,
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        undo: VersionBefore,
        effects: { mode: 'write', registry: [{ thing: 'fns', action: 'update', kind: kinds.schedule.name }] },
        status: phases('Skipping a run of {args.schedule}…', 'Skipped a run of {args.schedule}', 'Skipping a run of {args.schedule} failed'),
        examples: [
          { args: { schedule: 'schedule/weekly_orders_summary', day: '2026-12-28' }, note: 'No run that Monday.' },
          { args: { schedule: 'schedule/hourly_ticket_check', day: '2026-12-24', time: '18:00' }, note: 'Only the 18:00 run of that day.' },
        ],
      }),
      remove: fn({
        group: 'schedules',
        description: 'Remove a schedule: it never runs again; its past runs stay in its history.',
        args: ScheduleArg,
        returns: g.obj({ removed: g.fnName() }),
        // TODO(slice 3): `removeFn: hub.fns.fns_remove`, once the hub has it
        deps: { getFn: hub.fns.fns_get },
        // undo restores its last version
        undo: VersionBefore,
        effects: { mode: 'delete', registry: [{ thing: 'fns', action: 'remove', kind: kinds.schedule.name }] },
        status: phases('Removing {args.schedule}…', 'Removed {args.schedule}', 'Removing {args.schedule} failed'),
        examples: [{ args: { schedule: 'schedule/weekly_orders_summary' }, result: { removed: 'schedule/weekly_orders_summary' } }],
      }),
      history: fn({
        group: 'schedules',
        description: 'Past runs of the person\'s schedules, newest first, each with its status, its one-line summary and its run.',
        args: g.obj({
          schedule: g.field(g.optional(g.fnName()), { docs: 'Only this schedule\'s runs.' }),
          from: g.field(g.optional(g.timestamp()), { docs: 'Runs planned at or after this.' }),
          to: g.field(g.optional(g.timestamp()), { docs: 'Runs planned before this.' }),
          status: g.field(g.optional(ginAs(FiringStatus)), { docs: 'Only runs with this status.' }),
        }),
        returns: g.obj({ items: g.list(types.Firing), cursor: g.optional(g.text()) }),
        effects: { mode: 'read', free: true },
        status: phases('Reading scheduled runs…', 'Read scheduled runs', 'Reading scheduled runs failed'),
        examples: [
          { args: { schedule: 'schedule/weekly_orders_summary' }, note: 'What its runs gave.' },
          { args: { status: 'failed' }, note: 'Every run that failed.' },
        ],
      }),
      remind: fn({
        group: 'schedules',
        description: 'Notify the person with a short text (their phone and inbox). Made to be scheduled.',
        args: g.obj({ text: g.field(g.text({ minLength: 1, maxLength: 160 }), { docs: 'What to tell them, at most 160 characters.' }) }),
        returns: g.obj({ sent: g.bool() }),
        effects: { mode: 'read', free: true },
        status: phases('Sending a reminder…', 'Sent a reminder', 'Sending a reminder failed'),
        examples: [{ args: { text: 'Take the bins out.' } }],
      }),
    },
  }))
  .with(({ fns }) => ({
    context: {
      guide: context({
        description: 'How to schedule fns: when they run, args that change per run, and notifications.',
        content: [
          '# Scheduled runs',
          '',
          `A schedule runs one fn of the person's later by itself, as them, at background priority, with the same approvals and budgets as their chat. ${fns.add.toString()} saves one; it is a fn of its own, named for what it does, that the person can also run now by name.`,
          '',
          '## When',
          '',
          '`when` is a dayspan schedule, read in the schedule\'s time zone (the person\'s, unless `zone` says otherwise):',
          '- once: `{ "on": "2026-12-01", "times": ["08:30"] }`',
          '- every Monday at 9:00: `{ "dayOfWeek": [1], "times": ["09:00"] }` (0 is Sunday)',
          '- every other week: add `"weeksSinceEpoch": { "every": 2 }` and a `start` day',
          '- the 1st and 15th of each month: `{ "dayOfMonth": [1, 15], "times": ["07:00"] }`; the last day: `{ "lastDayOfMonth": [1] }`',
          '- the first Tuesday: `{ "dayOfWeek": [2], "weekspanOfMonth": [0] }`; the last Friday: `{ "dayOfWeek": [5], "lastWeekspanOfMonth": [0] }`',
          '- `start`, `end` (days) and `maxOccurrences` bound it. Each of `times` is a run; with none it runs once at 00:00.',
          '',
          '## Args',
          '',
          'Fixed values go in `args`, as JSON checked against the fn\'s args. Values that change with each run go in `compute`, in plain words ("from: the run\'s day minus 7 days; to: the run\'s day"), and are worked out for each run from its day and time and the last run\'s result. Never write a program yourself.',
          '',
          '## Afterwards',
          '',
          `The result says when it runs in words and lists the next times: read those back. Each run's result reaches the person as a notification (\`notify\`: always, failed or never), never this chat. ${fns.list.toString()} lists the person's schedules, ${fns.history.toString()} what past runs gave; ${fns.change.toString()}, ${fns.pause.toString()}, ${fns.resume.toString()}, ${fns.skip.toString()} and ${fns.remove.toString()} change them. To remind the person of something, schedule ${fns.remind.toString()}.`,
        ].join('\n'),
        fns: [fns.add, fns.list, fns.history],
        tags: ['schedules'],
      }),
      basics: context({
        title: 'Schedules',
        description: 'That fns can run later by themselves, how to schedule one, and that results come as notifications.',
        // short: every chat item's summary shares the small chat agent's 600-token cap (scripts/chat-prompt.test.ts)
        summary: `${fns.add.toString()} runs fns later.`,
        content: [
          `A fn can run later by itself on a schedule. ${fns.add.toString()} saves a schedule of the person's: which fn, its args, and when (once on a day, or repeating by days of the week or month with times of day) in their time zone. It runs as the person, at background priority, with the same approvals and budgets as their chat.`,
          '',
          '- Settle the fn, its args and the times first. Args that change with each run (the day it runs, the week before it) go in `compute`, in plain words; fixed ones in `args`.',
          '- The result says when it runs in words and lists the next times: read those back to the person, and never say something is scheduled unless the result says so.',
          '- Each run\'s result does not come back into this chat. The person gets a notification with a short summary and a link to the run (`notify` says when: always, only when it fails, or never), and the Schedule page keeps every run. Don\'t promise to tell them here.',
          `- To remind the person of something, schedule ${fns.remind.toString()} with the text.`,
          `- Change, pause, resume, skip or remove one with ${fns.change.toString()}, ${fns.pause.toString()}, ${fns.resume.toString()}, ${fns.skip.toString()} and ${fns.remove.toString()}; ${fns.list.toString()} shows theirs, and ${fns.history.toString()} what past runs gave.`,
          '',
          'What still can\'t happen: nothing starts because something else happened (a new file, an email, a change somewhere): only at times. A scheduled run can notify the person it is for, and no one else unless a fn it calls does. A run that needs approval waits for the person, who is notified.',
        ].join('\n'),
        fns: [fns.add, fns.list],
        tags: ['schedules'],
        inject: {
          into: [agents.startingWith(hub.fns.chat)],
          order: 30,
          // the fns its text names without bringing them
          requires: [fns.change, fns.pause, fns.resume, fns.skip, fns.remove, fns.history, fns.remind],
          // TODO(slice 4): `replaces: [hub.context.later]` once `InjectDecl.replaces` and the hub's `later` item exist,
          // so this item takes the place of "Nothing runs later by itself" while the system is on
        },
      }),
    },
  }));

/** The schedule contract's type. */
export type ScheduleContract = typeof schedule;
/** What the config takes (every limit optional). */
export type ScheduleConfigInput = Infer<typeof Limits>;
/** A schedule as the chat and the pages show it. */
export type ScheduleViewValue = Infer<typeof View>;
