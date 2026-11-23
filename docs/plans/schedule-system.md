# The schedule system (design, 2026-11-23)

Design for review. Nothing here is built. Phil's rule: the types below are for his approval first, then zod schemas,
then code. The open decisions are in hitloop set `schedule-system-2026-11-23`; where this doc says "recommended", that
is the answer it was written against.

## Phil's words (verbatim, docs/plans/todo-2026-11-23.md)

> Schedule system which uses dayspan-ts schedule format to schedule fns. It also adds a schedule page with a calendar
> that shows scheduled fns. The payload could contain gin program since some fns that are called has arguments.

## In one paragraph

A new bundled system, `schedule` (`systems/schedule`, `instances: "one"`), adds a fn kind, `schedule/schedule`. A fn
of that kind is a **schedule**: its payload names a fn to run, *when* as a dayspan schedule (the format Oryoli stores),
a time zone, and the args as a gin program evaluated at each firing. Like a code fn, a schedule is the person's own
saved fn: the hub keeps it, versions it, shares it and shows it on its fn page. The schedule system owns the timer:
it keeps each schedule's next firing on a durable `@ayepi/work` queue in its own data folder and, when one is due,
asks the hub to start a run of the schedule fn **as its owner**. That run works out the args and calls the target fn
as its child, so the run tree, policies, approvals, budgets, undo and the ledger all apply as they do in a chat. Each
firing is recorded (a `schedule/Firing` record of the owner's) and its result goes to the schedule's own chat and,
as the schedule says, a push notification. The chat gets fns to add, list, change, pause, resume, skip and remove
schedules, and an injected item that replaces the hub's "Nothing runs later by itself" while the system is on. The
Schedule page (`/s/schedule/calendar`) draws every schedule's past and coming firings on a month, week or agenda
calendar.

## What a schedule is

A schedule is a fn of kind `schedule/schedule`, named for what it does (`schedule/weekly_sales_summary`). Its payload:

- **The fn it runs** (`fn`): any fn the owner may call, an agent included (an `hub/llm` fn with a task, a Claude agent).
  The kind's `describe` gives it as the schedule's one dep, so the hub's existing rule ("a fn the parent's fn declares
  as a dep was reviewed with it") lets the firing call it, and the fn page shows what the schedule runs.
- **When** (`when`): a dayspan `ScheduleInput` exactly as Oryoli stores one (its strict subset in
  `packages/core/src/model/common.ts` there): `on` for a one-off, or day rules (`dayOfWeek`, `dayOfMonth`,
  `lastDayOfMonth`, `weekspanOfMonth`, `lastWeekspanOfMonth`, `month`, `year`, `weeksSinceEpoch: { every: 2 }`, …)
  with `start`, `end` or `maxOccurrences`, and `times` as `"HH:mm"` (each time is a firing; no times means one firing
  at the start of the day, 00:00). `start`, `end` and `on` are `YYYY-MM-DD` local days. A skipped or extra firing is
  dayspan's own `exclude` and `include` (`"2026-12-25"` for a day, `"2026-12-24T18:00"` for one time), so "skip next
  Monday" and "also run it Friday at 5" are edits of the same object dayspan already reads, and the calendar draws
  them with no code of ours.
- **Time zone** (`zone`, IANA): the wall clock `when` is read in. It defaults to the owner's zone when the schedule is
  made (`ctx.run.user.timeZone`) and is kept, so a person who travels does not move their 9:00 report. 9:00 stays
  9:00 across daylight saving; a time that doesn't happen (02:30 on the spring-forward night) fires at 03:30, and a
  time that happens twice fires once, at the first (the rule Oryoli's `zonedTime` already follows).
- **Args** (`args`): one gin program whose result is the target fn's args. Fixed args are a literal (a constant
  program), so there is one field, always checked against the target's args type when the schedule is saved and again
  when the target's signature changes. The program reads, by name:
  - `fire`: this firing: `at` (the instant it was planned for), `local` (that instant in the zone, with its offset),
    `day` (`YYYY-MM-DD`), `time` (`HH:mm`, absent for a whole-day firing), `zone`, `count` (how many firings came
    before), `late` (ms between `at` and the start), `manual` (true for "run now").
  - `previous`: the last firing that ran, when there was one: its `at`, status and result (typed as the target fn's
    result). This is what "what's new since last time" needs, and nothing older is offered.
  - Recommended: no fn calls in the args program. A firing that needs data from another fn is a schedule of a code fn
    that calls both. (Question `args-scope`.)
  - The words the args were written from are kept beside the program (`argsAsked`), so the fn page and the edit form
    can say "date: the firing's day minus 7 days" rather than show gin.
- **Where results go** (`deliver`): `chat: 'own'` (recommended default) puts every firing in the schedule's own chat,
  made at the first firing, titled after the schedule: each firing is an invocation turn there, so the person reads
  results like any run card, can ask a follow-up, and can undo the turn. `chat: 'none'` keeps firings to the run pages
  and the calendar. `notify: 'always' | 'failed' | 'never'` (default `always`) sends a push notification to the owner
  when a firing settles, linking to the chat (or the run). (Question `results`.)
- **Overlap** (`overlap`): what happens when a firing is due while the last one still runs: `skip` (recommended
  default: recorded as skipped, with the run it waited on), `queue` (at most one waits and starts when the running one
  settles), or `replace` (the running one is cancelled). (Question `overlap`.)
- **Missed firings** (`missed`): a firing that couldn't start on time (the hub or the system was down, the person's
  budget window was full): `latest` (recommended default: when it can start again, the most recent missed firing runs
  once, late, if it is within the grace window; the rest are recorded as missed) or `none` (all recorded as missed).
  (Question `missed`.)
- **Cost cap** (`maxSpend`, optional): the most one firing may spend; it lowers the firing turn's per-turn budget.
- **Paused** (`paused`, optional): who paused it, when, and optionally until which day. A pause is a change of the
  schedule like any other: a new version, in its history, undone by going back a version.

**Who it runs as.** Its owner, always: the person who made it (recommended; question `run-as`). Sharing a schedule fn
lets others see it and copy it (the copy is theirs and runs as them); it never runs as anyone else. A schedule whose
owner is turned off, or who may no longer run the target fn, stops firing: each due firing is recorded as refused with
the reason, and the owner (or, if they are gone, the admins) is told once.

**A kind, not records** (question `shape`, recommended). Phil's word "payload" fits: a schedule is a fn like a code fn
or a widget. What that gives for free: the hub stores, versions, searches and shares it; its fn page shows its payload
and versions; an admin sees every schedule in Admin › Fns; the review page shows the kind; `describe` gives its dep,
so calling the target needs no new grant; calling the schedule fn by name ("run my weekly summary now") is a manual
firing with no extra fn. The firings themselves are records (`schedule/Firing`, owned by the schedule's owner): one
row per firing that was due, including those that never became a run (missed, skipped, refused), which a run table
can't hold.

**Operations on a schedule**:
- **Add** (`schedule/add`): saves a new schedule fn. A write: the person approves it once, on a card that says what it
  runs, as whom, when in plain words (dayspan's `en-plain` locale), the next three firings and the first firing's args.
- **Change** (`schedule/change`): any part; saves a new version. The next firing is planned again from the new
  version; a firing already running keeps the version it started with.
- **Pause / resume**, with an optional "until" day for a pause.
- **Skip** one firing (`exclude`), or add one (`include`).
- **Remove**: the fn is removed (the hub keeps its versions); its queued firing is cancelled; its firings stay.
- **Run now**: call the schedule fn. Recorded as a firing with `manual: true`; it does not move the next one.
- **History**: the `schedule/Firing` records (`schedule/history`, or `hub/records_find`).
- **Undo**: every one of these is undoable as a run (add removes it, change and pause go back a version, remove brings
  it back, skip un-skips). What a firing did is undone the usual way: its turn's undo, in the schedule's chat.

**Limits** (the system's config, which an admin sets; defaults in brackets): the shortest gap between two firings of
one schedule [15 minutes: a `when` with times closer together is refused with the reason], schedules per person [50],
firings per person per day [200], how late a missed firing may still run [6 hours], how long firings are kept [500 per
schedule and 180 days]. dayspan has no "every N minutes" rule; sub-hour schedules are a list of times, which the
minimum gap keeps short. If Phil wants "every 15 minutes between 9 and 5" as one rule, that is a dayspan ask (below).

**Budgets and priority.** A firing's turn is resolved like any turn of its owner, asking for `background` priority (so
interactive chat goes first), lowered by `maxSpend`. It spends from the owner's budgets. A budget that says "wait"
delays the firing, and the overlap rule decides what happens if the next one comes due meanwhile; one that refuses
records the firing as refused; one that says "ask" is an approval wait (below).

**Approvals when nobody is watching** (question `approvals`). A firing whose target asks for approval waits for its
owner: the hub already puts the approval in their inbox and sends the push. The system follows the run and gives up
waiting when the next firing is due, or after 24 hours, whichever is first (the firing is recorded as `expired`). An
admin can set the system's `approvals` config to `refuse`: then a firing that needs approval is cancelled at once and
recorded as refused, and the owner is told so they can allow it with a policy. Making the schedule is the moment the
person is watching, so the add card offers "Let its runs go ahead without asking" when the target would ask: that
records an "always" approval narrowed to runs made by this schedule (recommended; it needs policies to match a run's
caller fn, a small hub change listed below).

## The hub side

The system owns its kind and its timer. The hub adds only what lets *any* system start its own kind's fns later on
behalf of their owners, plus the injection change. Why the timer is the system's (question `timer-home`, recommended):
- Harness systems own their kinds: the kind's payload, its checks and when it runs are the system's; the hub stays a
  small core that never needs dayspan, time zones or schedule rules.
- "Nothing runs later by itself" is then true of the hub alone and false only while a system that says otherwise is
  installed and live: switching the schedule system off stops every timer, and its review page says so.
- The capability is visible: a system that may start runs by itself declares the `runs` grant, and the review flags it
  ("Starts runs on its own, as the owners of its fns").
- The hub already has the hard parts: durable queues, sessionless turns for a person (the hub MCP's runner does exactly
  this, `mcp/calls.ts`), idempotent proposals by key, push notifications.

What the hub adds:

1. **Starting a kind's fn as its owner** (`runs.start`, link endpoint `start`, grant `runs`). Outside any run, a system
   may start a run of a fn of one of its own kinds, as that fn's owner. The hub refuses unless the fn is of a kind this
   system declares, its owner is a person who can still use the hub, the system is live, and the owner may run it
   (policies, as at any call). It makes a turn for the owner (limits resolved for `background`, lowered by the given
   cap), sessionless or as an invocation turn in a chat the system opened for that owner, with the system's actor as
   the caller. A `key` makes it idempotent: the same key is the same run, so a retried or doubled start never fires
   twice.
2. **Listing a kind's fns** (`runs.kindFns`): every fn of this system's kinds with owner, version and payload, a page
   at a time, optionally changed since a time: what the timer loads at start. The `fns` event gains `changed` (a new
   version of a fn), so an edit made anywhere (the fn page, `hub/fns_save`, an owner being turned off) re-plans.
3. **A chat for the owner** (`chats.open`): outside a run, open (or find, by key) a chat of one person's for one of the
   system's fns, with a title; the person sees it in their chat list. Gated like `runs.start`.
4. **Notifying the run's own person** (`ctx.notify` in a run): a push and inbox item to the person the run is for,
   never anyone else, with a link to a chat, a run or a page of the system. Reason `system-message`.
5. **Policies by caller**: a policy may also match on the fn whose run made the call (`via`), so "always allow
   `fs/write` when `schedule/nightly_backup` calls it" is a policy, which the add card's "Let its runs go ahead" records.
6. **Removing a saved fn from a system** (`hub/fns_remove`, the owner's or an admin's, undoable by restoring the last version): the hub has `fns_save` but no remove a system can call; `schedule/remove` needs one.
7. **`InjectDecl.replaces`** (chat side, below), and the split of the hub's `limits` item.

**Durability across restarts.** The system keeps its timer in its data folder (`ctx.dataDir`): an `@ayepi/work` queue
on SQLite ports, one delayed item per schedule for its next firing (`runAt` the planned instant, id
`<fn>@<instant>`), and a small table per schedule (version, last planned instant, last firing, the run going now). On
start it reconciles: it loads every schedule fn with `kindFns`, queues each one's next firing if it isn't queued, and
for each schedule works out the firings between its last planned instant and now; those are missed, and the `missed`
rule decides whether the latest runs late. When the hub is unreachable at fire time, the work item waits and retries
(`WorkDelayError`) until the grace window passes, then records the firing as missed once the hub is back. Firing
records are written to the hub (person-owned records), so they survive the system and are exported with nothing
extra; the local tables are rebuilt from the hub if the data folder is lost (only the not-yet-recorded firings are
lost then).

**Multi-instance.** The system is `instances: "one"`: one timer per hub. If two copies ever run at once (an upgrade
overlapping the old one, a data folder restored on a second machine), nothing fires twice: the hub's `key` is the
firing (`schedule:<fn>@<instant>`), so the second start returns the first's run. If the system becomes `many` later,
`@ayepi/work`'s shared ports and its per-occurrence lease already handle a fleet.

## The chat side

**Fns for the model** (group `schedules`):
- `schedule/add({ fn, when, args?, compute?, name?, zone?, deliver?, overlap?, missed?, maxSpend? })` → the schedule:
  its name, what it says in words, the next three firings in the person's zone, and the first firing's args.
- `schedule/change({ schedule, …any of add's fields })` → the same.
- `schedule/list({ fn?, search?, paused? })` → the person's schedules with their next firing and the last firing's
  status.
- `schedule/pause({ schedule, until? })`, `schedule/resume({ schedule })`, `schedule/remove({ schedule })`.
- `schedule/skip({ schedule, day, time? })`: skip one firing.
- `schedule/history({ schedule?, from?, to?, status? })` → a page of firings.
- `schedule/remind({ text })`: a fn that only notifies its own person, so "remind me" is a schedule of it rather than a
  sentence about what the app can't do.

**How the model writes the args** (question `args-authoring`, recommended): fixed values in `args` (JSON, checked
against the target's args), and the ones that depend on the firing in `compute`, in plain words ("`from`: the firing's
day minus 7 days; `to`: the firing's day"). When `compute` is given, a small authoring step (the code system's program
tools, on `ctx.ai()`, with `fire` and `previous` typed in its scope) writes the gin program, checks it against the
target's args type, runs it for the next three firings and saves it with the words. The model never writes gin, and a
person editing on the page sees the words and the three previews.

**The injected item** (`schedule/basics`, into `hub/chat*`, order 30, `replaces: [hub/later]`). General purpose, written
for any request:

```md
---
title: Scheduled runs
summary: "schedule/add runs a fn of the person's later, once or repeating, as them; only at times, never on events.
  Read back what it says and the next times; never say something is scheduled unless the result says so."
---

A fn can run later by itself on a schedule. schedule/add saves a schedule of the person's: which fn, its args, and
when (once on a day, or repeating by days of the week or month with times of day) in their time zone. It runs as
the person, at background priority, with the same approvals and budgets as their chat. Each run goes in the
schedule's own chat and the person is notified when it finishes.

- Settle the fn, its args and the times first. Args that change with each run (the day it runs, the week before it)
  go in `compute`, in plain words; fixed ones in `args`.
- The result says when it runs in words and lists the next times: read those back to the person, and never say
  something is scheduled unless the result says so.
- To remind the person of something, schedule schedule/remind with the text.
- Change, pause, resume, skip or remove one with schedule/change, schedule/pause, schedule/resume, schedule/skip and
  schedule/remove; schedule/list shows theirs. The Schedule page shows them all on a calendar.

What still can't happen: nothing starts because something else happened (a new file, an email, a change somewhere):
only at times. A scheduled run can notify the person it is for, and no one else unless a fn it calls does. A run
that needs approval waits for the person, who is notified.
```

**How `hub/limits` changes.** Today one hub item, `packages/hub/context/limits.md`, says three things. It becomes two:
`hub/limits` (you can't connect accounts or set up services; never invent setup steps) and `hub/later` ("Nothing runs
later by itself", "No messages to anyone later", and the closest-real-thing advice for "every month" and "remind
me"). No hub text names the schedule system. Instead a context item may declare `replaces` (question `limits-text`,
recommended): while it is in an agent's section, each item it replaces is left out with the reason `replaced` (and by
what), shown on the agent's Injected tab like every other reason. The schedule system's `basics` replaces `hub/later`
and restates what is still true. With the system off, out of the chat, or its item switched off, `hub/later` is back.
A declaration that replaces another system's item raises the `injects` review flag ("Takes hub/later out of hub/chat
and hub/chat_small").

## The schedule page

- **`/s/schedule/calendar`** (nav `main`, title "Schedule", icon `calendar`). The person's schedules on a calendar.
  `?view=month|week|agenda&day=2026-11-23&schedule=…` is in the URL. Coming firings are worked out in the browser from
  each schedule's payload by the same shared code the server uses (`shared/when.ts`, over dayspan's `Calendar` and
  `Schedule`), so the calendar needs no server round trip to page forward. Past firings are the `schedule/Firing`
  records, coloured by status (ran, failed, missed, skipped, refused, waiting). Each entry shows the schedule's name and
  the target fn as a `FnPill`; it opens a panel with the firing's args, its status, and links to the schedule, the
  target fn's page, the run and the chat turn. A filter picks schedules; a "Paused" badge marks paused ones, whose
  coming firings are drawn faded.
- **`/s/schedule/item/<schedule>`** (hidden): one schedule. What it runs and when in words, its zone ("New York time"
  when it isn't the viewer's), the next firings, its history (paged), and Pause, Resume, Run now, Skip (from a coming
  firing's menu) and Remove. **Edit** opens the form: the fn (search), when (presets built from dayspan's patterns:
  once, every day, weekdays, every week on…, every other week, the Nth weekday of the month, the last day of the
  month; or custom rules; a list of times; the zone), the args (the target's args type in the app's `ValueEditor` for
  fixed values, the `compute` words with three previews for computed ones), where results go, overlap and missed
  firings under "More". Saving runs `schedule/change` as the person through `host.runs`, so approvals and undo are the
  same as in a chat.
- **`/s/schedule/all`** (access `admin`): every schedule on the hub, by owner, with pause, so an admin can see and stop
  anything that runs by itself.
- **Mobile.** Agenda is the default under 640 px. The month grid shows a dot per firing and opens that day's agenda
  on tap; the week view scrolls one day at a time. The edit form is one column. Everything is drawn with the app's
  shared components (`Frame`, `Button`, `Select`, `Dialog`, `Badge`, `FnPill`, `ValueEditor`, `Markdown`, `Empty`,
  `LoadState`, `Skeleton`); only the calendar grid is the system's own component. If a second system wants a calendar
  (google-calendar), the grid moves into the app's shared components.
- **Result renderer.** `schedule/add`, `change` and `list` results are drawn by the system's renderer (the schedule in
  words, the next firings, a link to its page), in the chat and on any page that shows the run.

## Types first

What follows is for Phil's approval. The core shapes go to `packages/core/src/schedules.ts` as zod after approval; the
contract is `systems/schedule/shared/index.ts`; the hub additions are in `packages/sdk/src/ctx.ts` and `core/inject.ts`.

### Core shapes

```ts
/** A local day, `YYYY-MM-DD`, read in the schedule's zone. */
export type LocalDay = string;
/** A time of day, `HH:mm` (24-hour). */
export type ClockTime = string;
/** One firing of a timed schedule (`2026-12-24T18:00`) or a whole day (`2026-12-25`), as dayspan's exclude/include take it. */
export type OccurrenceKey = string;

/** When: dayspan's ScheduleInput as stored (Oryoli's strict subset), read in the schedule's zone. */
export interface When {
  on?: LocalDay;                      // a one-off
  start?: LocalDay;
  end?: LocalDay;
  maxOccurrences?: number;            // needs start
  dayOfWeek?: number[];               // 0 = Sunday … 6 = Saturday
  dayOfMonth?: number[];
  lastDayOfMonth?: number[];          // 1 = the last day
  weekspanOfMonth?: number[];         // 0 = days 1–7 ("the 1st Tuesday")
  lastWeekspanOfMonth?: number[];     // 0 = the last 7 days ("the last Friday")
  weekOfMonth?: number[];
  weekOfYear?: number[];
  month?: number[];                   // 0 = January
  year?: number[] | Every;
  daysSinceEpoch?: Every;             // every N days from start
  weeksSinceEpoch?: Every;
  monthsSinceEpoch?: Every;
  times?: ClockTime[];                // each is a firing; none = one at 00:00
  exclude?: OccurrenceKey[];          // skipped firings
  include?: OccurrenceKey[];          // extra firings
}
export interface Every { every: number; offset?: number }

/** Where a firing's result goes. */
export interface Delivery {
  chat: 'own' | 'none';
  notify: 'always' | 'failed' | 'never';
}

/** A schedule: the payload of a `schedule/schedule` fn. */
export interface SchedulePayload {
  fn: QualifiedName;
  when: When;
  zone: string;                       // IANA
  /** A gin program over `fire` and `previous` whose result is `fn`'s args (a literal for fixed args). */
  args: GinExprDef;
  /** The words `args` was written from, when it computes anything. */
  argsAsked?: string;
  deliver: Delivery;
  overlap: 'skip' | 'queue' | 'replace';
  missed: 'latest' | 'none';
  maxSpend?: Usd;
  paused?: { at: Timestamp; by: ActorId; until?: LocalDay };
}

/** What the args program reads as `fire`. */
export interface Fire {
  at: Timestamp;                      // the instant it was planned for
  local: string;                      // that instant in the zone, with its offset: 2026-11-30T09:00:00-05:00
  day: LocalDay;
  time?: ClockTime;
  zone: string;
  count: number;                      // firings before this one
  late: number;                       // ms after `at` that it started
  manual: boolean;                    // run now
}

/** What it reads as `previous` (R: the target fn's result). */
export interface PreviousFiring<R> { at: Timestamp; status: 'ran' | 'failed'; result?: R }

export type FiringStatus =
  | 'running' | 'waiting'             // started; waiting = for approval or a budget window
  | 'ran' | 'failed' | 'cancelled'    // its run settled
  | 'skipped'                         // overlap: the last one was still running
  | 'missed'                          // couldn't start in time
  | 'refused'                         // the hub refused, or approval was needed and the admin says refuse
  | 'expired';                        // waited for approval past the next firing

/** A `schedule/Firing` record (owned by the schedule's owner): one firing that was due. */
export interface Firing {
  schedule: QualifiedName;
  version: string;
  at: Timestamp;                      // planned
  day: LocalDay;
  time?: ClockTime;
  manual: boolean;
  status: FiringStatus;
  run?: RunId;
  turn?: TurnId;
  chat?: SessionId;
  args?: Json;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  cost?: Usd;
  /** In words, for skipped, missed, refused and expired ("the 9:00 run was still going"). */
  reason?: string;
}

/** A schedule as the chat's results and the page show it. */
export interface ScheduleView {
  schedule: QualifiedName;
  fn: QualifiedName;
  says: string;                       // "Every Monday at 9:00 am, New York time"
  zone: string;
  next: { at: Timestamp; local: string }[];
  firstArgs?: Json;                   // the next firing's args
  paused?: { until?: LocalDay };
  last?: Pick<Firing, 'at' | 'status' | 'run'>;
}
```

### The contract

```ts
// systems/schedule/shared/index.ts
export const Limits = g.obj({
  minGap: g.field(g.duration(), { docs: 'The shortest gap between two firings of one schedule.' }),       // 15 min
  perPerson: g.field(g.num(), { docs: 'Schedules one person may have.' }),                                 // 50
  firingsPerDay: g.field(g.num(), { docs: 'Firings one person may have in a day.' }),                     // 200
  grace: g.field(g.duration(), { docs: 'How late a missed firing may still run.' }),                       // 6 h
  approvals: g.field(g.enum(['wait', 'refuse']), { docs: 'A firing that needs approval waits for its person, or is refused.' }),
  keep: g.obj({ perSchedule: g.num(), days: g.num() }),                                                    // 500, 180
});

export const Firing = type({
  description: 'One firing of a schedule that was due: when, its status, its run and chat.',
  shape: ginAs(FiringShape),
  display: { label: 'Firing', plural: 'Firings', icon: 'clock', title: 'schedule', subtitle: 'status' },
  records: { shape: 'table', owner: 'person', search: { text: ['schedule', 'reason'], embed: false } },
});

export const schedule = system('schedule', {
  description: 'Runs fns later by themselves, once or repeating, as the person who scheduled them.',
  about: '…',                                       // what it is for, its kind, its fns, when to reach for it
  groups: [{ name: 'schedules', title: 'Schedules', description: 'Add, change, pause and remove scheduled runs of fns.' }],
  // it starts its own kind's fns as their owners, opens their chats, keeps firings as records, writes computed args
  grants: { hub: ['runs', 'chats', 'data', 'fns', 'search', 'ai'], calls: [hub.fns.fns_get.name, hub.fns.fns_save.name, 'hub/fns_remove'] },   // fns_remove is new (hub side, 6)
  pages: [
    { segment: 'calendar', title: 'Schedule', description: 'Your scheduled runs on a calendar.', icon: 'calendar', nav: 'main', component: 'CalendarPage' },
    { segment: 'item', title: 'Schedule', nav: 'hidden', component: 'SchedulePage' },
    { segment: 'all', title: 'All schedules', nav: 'hidden', access: 'admin', component: 'AllSchedulesPage' },
  ],
})
  .with({
    config: Limits,
    types: { Firing },
    kinds: {
      schedule: kind({
        description: 'A schedule: runs one fn later by itself, at the times its dayspan schedule gives, as its owner. Calling it by name runs it now.',
        applicability: 'Something the person wants done at a time or on a repeating schedule, made by schedule/add.',
        payload: ginAs(SchedulePayload),
        approveChanges: false,
        status: status('Running {fn}…', 'Ran {fn}', '{fn} failed'),
      }),
    },
    fns: {
      add: fn({
        group: 'schedules',
        description: 'Schedule a fn to run later by itself, once or repeating, as the person; gives the schedule, when it runs in words and its next times.',
        args: AddArgs,                        // { fn, when, args?, compute?, name?, zone?, deliver?, overlap?, missed?, maxSpend? }
        returns: View,                        // ScheduleView
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        undo: g.obj({ schedule: g.fnName() }),
        effects: { mode: 'write', registry: [{ thing: 'fns', action: 'create', kind: SCHEDULE_KIND }] },
        examples: [
          { args: { fn: 'database/main.sales_by_week', when: { dayOfWeek: [1], times: ['09:00'] }, compute: 'week_start: the firing\'s day minus 7 days' }, note: 'Every Monday at 9:00, the week before.' },
          { args: { fn: 'schedule/remind', when: { on: '2026-12-01', times: ['08:30'] }, args: { text: 'Renew the car registration.' } }, note: 'A one-off reminder.' },
        ],
      }),
      change: fn({ group: 'schedules', /* { schedule: g.fnName(), …add's fields, all optional } → View; undo: the version before */ }),
      list:   fn({ group: 'schedules', /* { fn?, search?, paused? } → { items: View[], cursor? }; read, free */ }),
      pause:  fn({ group: 'schedules', /* { schedule, until? } → View; undo */ }),
      resume: fn({ group: 'schedules', /* { schedule } → View; undo */ }),
      skip:   fn({ group: 'schedules', /* { schedule, day, time? } → View; undo */ }),
      remove: fn({ group: 'schedules', /* { schedule } → { removed: g.fnName() }; undo: restore the last version */ }),
      history: fn({ group: 'schedules', /* { schedule?, from?, to?, status? } → { items: FiringShape[], cursor? }; read, free */ }),
      remind: fn({
        description: 'Notify the person with a short text (their phone and inbox). Made to be scheduled.',
        args: g.obj({ text: g.text({ minLength: 1 }) }),
        returns: g.obj({ sent: g.bool() }),
        effects: { mode: 'read', free: true },
        examples: [{ args: { text: 'Take the bins out.' } }],
      }),
    },
  })
  .with(({ fns }) => ({
    context: {
      guide: context({ description: 'How to schedule fns: when, args that change per run, where results go.', content: '…', fns: [fns.add, fns.list] }),
      basics: context({
        title: 'Scheduled runs',
        description: 'That fns can run later by themselves, and how to schedule one.',
        summary: '…',                      // as above
        content: '…',                      // the item above
        fns: [fns.add, fns.list],
        requires: [fns.change, fns.pause, fns.resume, fns.skip, fns.remove, fns.remind],
        inject: { into: [agents.startingWith(hub.fns.chat)], order: 30, replaces: [hub.context.later] },
      }),
    },
  }));
```

### The server

```ts
// systems/schedule/server/impl.ts (shape only)
export function createScheduleImpl(deps: { timer: Timer }): SystemImpl<ScheduleContract['defs']> {
  return {
    kinds: {
      schedule: {
        check: (payload, ctx) => payloadProblems(SchedulePayload.parse(payload), ctx),   // when parses, gaps ≥ minGap, args checks against fn's args
        describe: (payload, ctx) => describeSchedule(SchedulePayload.parse(payload), ctx), // args: { at?: Timestamp }, returns: fn's result, deps: [fn]
        async run(payload, args, ctx) {
          const spec = SchedulePayload.parse(payload);
          const fire = fireOf(spec, args.at ?? ctx.run.time.now, { manual: args.at === undefined, started: ctx.run.time.now });
          const input = await runArgsProgram(spec, { fire, previous: await deps.timer.previous(ctx.run.fn) }, ctx);
          const settled = await ctx.call(spec.fn, input);           // the target, as the owner's child run
          await deliver(spec.deliver, settled, ctx);                // ctx.notify when it says so
          return settled.status === 'done' ? ctx.done(settled.result) : ctx.fail('caller', failedText(spec.fn, settled));
        },
      },
    },
    fns: { add, change, list, pause, resume, skip, remove, history, remind: { run: async (args, ctx) => { await ctx.notify({ title: 'Reminder', body: args.text }); return ctx.done({ sent: true }); } } },
    events: { fns: (event, ctx) => deps.timer.replan(event, ctx), run: (event, ctx) => deps.timer.follow(event, ctx) },
    lifecycle: { started: (ctx) => deps.timer.reconcile(ctx), stopping: (ctx) => deps.timer.stop(ctx) },
  };
}

// a due firing, on the timer's @ayepi/work queue:
await ctx.runs.start(schedule.fn, {
  args: { at: due.at },
  key: `schedule:${schedule.fn}@${due.at}`,
  chat: spec.deliver.chat === 'own' ? await ctx.chats.open({ for: schedule.owner, key: schedule.fn, title: schedule.title, about: schedule.fn }) : undefined,
  priority: 'background',
  maxSpend: spec.maxSpend,
});
```

### The hub additions to the SDK

```ts
// packages/sdk/src/ctx.ts
export interface SystemCtx<Cfg> {
  /** Needs the `runs` grant. */
  readonly runs: KindRuns;
  /** Needs the `chats` grant. */
  readonly chats: OwnerChats;
}

/** Runs of this system's own kinds' fns, started by the system itself as each fn's owner (a firing). */
export interface KindRuns {
  /**
   * Start a run of a fn of one of this system's kinds, as its owner, outside any run. Refused (with the reason) unless
   * the owner can still use the hub, the system is live and the owner may run it. The same `key` is the same run.
   */
  start(fn: QualifiedName, options: StartAsOwner): Promise<StartedRun>;
  /** The fns of this system's kinds, with owner, version and payload, a page at a time. */
  kindFns(query: { kind: KindRef; changedSince?: Timestamp; cursor?: string }): Promise<{ items: KindFn[]; cursor?: string }>;
}
export interface StartAsOwner {
  args: Json;
  key: string;
  /** A chat of the owner's (`chats.open`): the run is an invocation turn there. Absent: a turn outside any chat. */
  chat?: SessionId;
  priority?: 'background' | 'interactive';   // default background
  /** Lowers the turn's per-turn budget. */
  maxSpend?: Usd;
}
export interface StartedRun { run: RunId; turn: TurnId; status: RunStatus }
export interface KindFn { fn: QualifiedName; kind: FnKindName; owner: ActorId; version: string; payload: Json; removed?: boolean; updatedAt: Timestamp }

/** A chat of one person's that this system keeps for one of its fns. */
export interface OwnerChats {
  /** Open (or find, by `key`) the chat; the person sees it in their list. Refused unless `about` is this system's kind's fn owned by `for`. */
  open(options: { for: ActorId; key: string; title: string; about: QualifiedName }): Promise<SessionId>;
}

// in a run's ctx (FnCtx):
/** Notify the person this run is for (push and inbox), never anyone else. */
notify(notice: { title: string; body: string; link?: { session: SessionId } | { run: RunId } | { page: PageLocation } }): Promise<void>;

// packages/core/src/inject.ts
export const InjectDecl = z.object({
  into: z.array(AgentTargetDecl).min(1),
  order: z.number().int().min(0).max(1000).default(100),
  requires: z.array(QualifiedName).default([]),
  mode: z.enum(['tools', 'static']).optional(),
  /** Context items this one takes the place of: while it is in an agent's section, each is left out (`replaced`). */
  replaces: z.array(QualifiedName).default([]),
});

// HubCapability gains 'runs' and 'chats'; NotificationReason gains 'system-message';
// SystemEvent 'fns' gains `changed`; a policy gains `via` (the fn whose run made the call).
```

What the types refuse (added to `types/examples.ts` with the build): `runs.start` of a fn of another system's kind, or
without a key; `ctx.notify` outside a run (a `SystemCtx` has none); `chats.open` without `about`; a schedule `kind`
whose payload's `args` is checked against a different fn's args than its `fn`; a `replaces` naming something that is
not a context item (a build warning, as `fn:` refs that name nothing).

## Library asks

- **dayspan: instants in a zone.** Oryoli and this system both turn a schedule's local days and times into instants
  in an IANA zone across daylight saving (`zonedTime`, `localNow` in Oryoli's `server/src/reminders.ts`). Recommended:
  move them into dayspan (`Schedule.instants(from, to, zone, limit)` and `nextInstant(after, zone)`), published by its
  release workflow, and have Oryoli use them too. Without it the schedule system copies Oryoli's functions.
- **dayspan, later and only if wanted: "every N minutes between two times"** as one rule, instead of a list of times.

## Build slices (after the types are approved)

| # | Slice | Where | Estimate |
|---|---|---|---|
| 1 | Zod for the core shapes, the contract with stub fns, `types/examples.ts` refusals | core, systems/schedule/shared | 0.5 day |
| 2 | dayspan zoned instants (library ask), release, Oryoli switched to it | dayspan, oryoli | 0.5 day |
| 3 | Hub: `runs.start`, `kindFns`, `chats.open`, `ctx.notify`, `fns.changed`, `hub/fns_remove`, grants `runs`/`chats` with their review flag, policy `via` | hub, sdk, core | 2 days |
| 4 | Hub: `InjectDecl.replaces`, the `replaced` reason in planner and Injected tab, split `limits.md` into `limits` and `later` | hub, core, web | 0.5 day |
| 5 | System server: the kind (check, describe, run, the args program over `fire`/`previous`), the timer on `@ayepi/work` + SQLite, reconcile, missed, overlap, approvals wait/refuse, Firing records and their pruning | systems/schedule/server | 2 days |
| 6 | Chat fns, the `compute` authoring step on the program tools, `remind`, the guide and `basics` items, the result renderer | systems/schedule | 1.5 days |
| 7 | Pages: calendar (month, week, agenda, mobile), one schedule with its edit form, the admin list | systems/schedule/client | 2.5 days |
| 8 | Tests: zones and daylight saving, missed and overlap, doubled starts, the start gate; a live run of each described flow once (GPT-6 Luna); ui-tests for the pages | all | 1.5 days |

About 11 days of work; 3 and 4 can run beside 5 and 6 once slice 1 is in, and 7 needs only slice 1's shared code.

## Judgement calls (not asked)

- The calendar grid is the system's own component on dayspan's `Calendar`; dayspan-vuetify is Vue 2 and Vuetify, so
  it is a reference for behaviour, not a dependency.
- A schedule's zone is stored, not followed: a person who changes zone keeps their schedules' times where they were.
- `schedule/remind` is part of the system, so "remind me" has a real answer once it is installed.
- Firing records are pruned by the system (500 per schedule, 180 days); runs stay as the hub keeps them.
- The schedule fn's own args are `{ at?: Timestamp }`: a person or model calling it gets "run now"; only the timer
  passes `at`.

## Decided (Phil, hitloop set schedule-system-2026-11-23, 2026-11-23, verbatim)


### shape: Is a schedule a fn of a kind (`schedule/schedule`, a saved fn like a code fn or a widget), or a record the schedule system keeps?

A fn kind

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### timer-home: Who owns the timer: the schedule system, or a firing service in the hub?

The system owns it

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### run-as: Who does a scheduled run run as?

Its owner only

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

## The args program

### args-scope: Besides `fire`, what can the args program read?

`fire` and the previous firing's result

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### args-authoring: How does the chat model write args that change with each firing?

In plain words, written by an authoring step

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

## When a firing happens

### results: Where does a firing's result go?

Notification and run page only

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### approvals: A firing's target asks for approval and nobody is watching. What happens?

Wait and notify; allow at creation; admin can refuse

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### missed: Firings were missed (the hub or system was down). What happens when it's back?

Run the latest once, if within a grace window

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### overlap: A firing is due while the last one still runs (a long agent, a wait for approval). Default?

Skip it

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

## What the chat is told

### limits-text: The hub's injected `limits` item says 'Nothing runs later by itself'. How does that change when the schedule system is installed, without hub text naming the system?

Other: What makes sense based on previous selections

(So: a context item can replace another, `InjectDecl.replaces`, as recommended. Phil changed his answer to this on 2026-11-23.)
