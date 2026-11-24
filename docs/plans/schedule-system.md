# The schedule system (design, 2026-11-23)

Design for review. Nothing here is built. Phil's rule: the types below are for his approval first, then code. All ten
questions in hitloop set `schedule-system-2026-11-23` are answered (Decided, at the end, verbatim), and this design
matches every answer. Revised 2026-11-23 for the one answer that differed from the first draft: a firing's result
reaches the owner as a **notification linking to its run page** and is kept in the schedule's history; there is no
chat per schedule.

## Phil's words (verbatim, docs/plans/todo-2026-11-23.md)

> Schedule system which uses dayspan-ts schedule format to schedule fns. It also adds a schedule page with a calendar
> that shows scheduled fns. The payload could contain gin program since some fns that are called has arguments.

## In one paragraph

A new bundled system, `schedule` (`systems/schedule`, `instances: "one"`), adds a fn kind, `schedule/schedule`. A fn
of that kind is a **schedule**: its payload names a fn to run, *when* as a dayspan schedule (the format Oryoli stores),
a time zone, and the args as a gin program evaluated at each firing. Like a code fn, a schedule is the person's own
saved fn: the hub keeps it, versions it, shares it and shows it on its fn page. The schedule system owns the timer:
it keeps each schedule's next firing on a durable `@ayepi/work` queue in its own data folder and, when one is due,
asks the hub to start a run of the schedule fn **as its owner**, outside any chat. That run works out the args and
calls the target fn as its child, so the run tree, policies, approvals, budgets, undo and the ledger all apply as they
do in a chat. Each firing is recorded (a `schedule/Firing` record of the owner's). When it settles, the owner gets
one notification (as the schedule's `notify` says): whether it ran or failed, a one-line summary of the result worked
out without a model, a link to the run's page and a second link to the schedule's history. The chat gets fns to add,
list, change, pause, resume, skip and remove schedules, and an injected item that replaces the hub's "Nothing runs
later by itself" while the system is on. The Schedule page (`/s/schedule/calendar`) draws every schedule's past and
coming firings on a month, week or agenda calendar.

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
  when the target's signature changes. The program reads, by name (decided `args-scope`):
  - `fire`: this firing: `at` (the instant it was planned for), `local` (that instant in the zone, with its offset),
    `day` (`YYYY-MM-DD`), `time` (`HH:mm`, absent for a whole-day firing), `zone`, `count` (how many firings came
    before), `late` (ms between `at` and the start), `manual` (true for "run now").
  - `previous`: the last firing that ran, when there was one: its `at`, status and result (typed as the target fn's
    result). This is what "what's new since last time" needs, and nothing older is offered.
  - No fn calls in the args program. A firing that needs data from another fn is a schedule of a code fn that calls
    both.
  - The words the args were written from are kept beside the program (`argsAsked`), so the fn page and the edit form
    can say "date: the firing's day minus 7 days" rather than show gin.
- **Notify** (`notify`, decided `results`): `always` (default), `failed` (only firings that didn't run cleanly) or
  `never`. Whatever it says, every firing is on the run pages (when it became a run), in the schedule's history and on
  the calendar. What the notification holds is below ("What the owner is told").
- **Overlap** (`overlap`, decided `overlap`): what happens when a firing is due while the last one still runs: `skip`
  (default: recorded as skipped, with the run it waited on), `queue` (at most one waits and starts when the running
  one settles), or `replace` (the running one is cancelled).
- **Missed firings** (`missed`, decided `missed`): a firing that couldn't start on time (the hub or the system was
  down, the person's budget window was full): `latest` (default: when it can start again, the most recent missed
  firing runs once, late, if it is within the grace window; the rest are recorded as missed) or `none` (all recorded
  as missed).
- **Cost cap** (`maxSpend`, optional): the most one firing may spend; it lowers the firing turn's per-turn budget.
- **Paused** (`paused`, optional): who paused it, when, and optionally until which day. A pause is a change of the
  schedule like any other: a new version, in its history, undone by going back a version.

**Who it runs as** (decided `run-as`). Its owner, always: the person who made it. Sharing a schedule fn lets others see
it and copy it (the copy is theirs and runs as them); it never runs as anyone else. A schedule whose owner is turned
off, or who may no longer run the target fn, stops firing: each due firing is recorded as refused with the reason,
and the owner is notified once (or, if they are gone, the admins, with `notifyAdmins`).

**A kind, not records** (decided `shape`). Phil's word "payload" fits: a schedule is a fn like a code fn or a widget.
What that gives for free: the hub stores, versions, searches and shares it; its fn page shows its payload and
versions; an admin sees every schedule in Admin › Fns; the review page shows the kind; `describe` gives its dep, so
calling the target needs no new grant; calling the schedule fn by name ("run my weekly summary now") is a manual
firing with no extra fn. The firings themselves are records (`schedule/Firing`, owned by the schedule's owner): one
row per firing that was due, including those that never became a run (missed, skipped, refused), which a run table
can't hold.

**Operations on a schedule**:
- **Add** (`schedule/add`): saves a new schedule fn. A write: the person approves it once, on a card that says what it
  runs, as whom, when in plain words (dayspan's `en-plain` locale), the next three firings, the first firing's args,
  and when they will be notified.
- **Change** (`schedule/change`): any part; saves a new version. The next firing is planned again from the new
  version; a firing already running keeps the version it started with.
- **Pause / resume**, with an optional "until" day for a pause.
- **Skip** one firing (`exclude`), or add one (`include`).
- **Remove**: the fn is removed (the hub keeps its versions); its queued firing is cancelled; its firings stay.
- **Run now**: call the schedule fn. Recorded as a firing with `manual: true`; it does not move the next one.
- **History**: the `schedule/Firing` records (`schedule/history`, `hub/records_find`, or the schedule's page).
- **Undo**: every one of these is undoable as a run (add removes it, change and pause go back a version, remove brings
  it back, skip un-skips). What a firing did is undone the usual way, as a run: **Undo** on its run page.

**Limits** (the system's config, which an admin sets; defaults in brackets): the shortest gap between two firings of
one schedule [15 minutes: a `when` with times closer together is refused with the reason], schedules per person [50],
firings per person per day [200], how late a missed firing may still run [6 hours], how long firings are kept [500 per
schedule and 180 days]. dayspan has no "every N minutes" rule; sub-hour schedules are a list of times, which the
minimum gap keeps short. If Phil wants "every 15 minutes between 9 and 5" as one rule, that is a dayspan ask (below).

**Budgets and priority.** A firing's turn is resolved like any turn of its owner, asking for `background` priority (so
interactive chat goes first), lowered by `maxSpend`. It spends from the owner's budgets. A budget that says "wait"
delays the firing, and the overlap rule decides what happens if the next one comes due meanwhile; one that refuses
records the firing as refused; one that says "ask" is an approval wait (below).

**Approvals when nobody is watching** (decided `approvals`). A firing whose target asks for approval waits for its
owner: the hub already puts the approval in their inbox and sends the push; the approval card is also on the run's
page. The system follows the run and gives up waiting when the next firing is due, or after 24 hours, whichever is
first (the firing is recorded as `expired`, and notified as a failure). An admin can set the system's `approvals`
config to `refuse`: then a firing that needs approval is cancelled at once and recorded as refused, and the owner is
notified so they can allow it with a policy. Making the schedule is the moment the person is watching, so the add
card offers "Let its runs go ahead without asking" when the target would ask: that records an "always" approval
narrowed to runs made by this schedule (it needs policies to match a run's caller fn, a small hub change listed
below).

## What the owner is told

One notification per firing that settles, sent by the system with `ctx.runs.notify` (the hub sends nothing of its own
for a run started outside a chat, so there is never a second one). It goes to the schedule's owner and no one else,
as an inbox item and a push (skipped, as for every notification, while they are looking at the page it links to).

- **Which firings.** `notify: 'always'` tells every firing that ran, failed, was cancelled (by anything but the
  person), missed, refused or expired. `'failed'` tells all of those except `ran`. `'never'` tells none. A skipped
  firing (the overlap rule) is never told: it is in the history. A manual firing ("run now") is not told: the person
  started it and is looking at it. A refused firing is told once per reason, until a firing runs again, so a schedule
  whose owner lost access does not notify every hour. Missed firings found together (after the hub was down) are one
  notification: "Missed 3 times while the hub was down; the latest ran 2 h late".
- **No double notice.** If the firing's run already notified its person (`schedule/remind`, or any fn the target calls
  that notifies), the system sends no "ran" notice of its own; a failure is still told. The hub's settled-run event
  says whether the run tree sent a notice (`notified`).
- **Title**: the schedule's title and the outcome: "Weekly sales summary ran", "… failed", "… was cancelled",
  "… missed 3 times", "… was refused", "… gave up waiting for approval".
- **Body**: one line, at most 160 characters (the hub's notification body limit, moved into core so both use it),
  worked out from the result by rules, never by a model:
  1. Failed, cancelled, refused or expired: the run's error message or the firing's reason, clamped.
  2. Ran, and the result is text (an agent's answer): its first paragraph, markdown removed, clamped on a word boundary
     (core's `clamp`).
  3. Ran, and the result is a table or a list: "12 rows" or "3 items", then the first row's most telling value when
     there is one ("12 rows: Widgets $1,240, …").
  4. Ran, and the result is an object: its most telling text field (`summary`, `message`, `title`, `text`, `name`,
     the order core's `argSummary` already uses for args), clamped.
  5. Otherwise: the target's own `done` status line filled with its result (core's `resolveStatus` with `output`),
     such as "Found 12 orders" or the default "Ran sales_by_week".
  A firing that started late adds "(2 h late)". The same line is kept on the firing record (`summary`), so the
  history and the calendar say it too.
- **Links.** The notification's link is the firing's **run page** (`/run/<run>`, below), where the result is drawn by
  the target fn's renderer under a header naming the schedule, with Undo, the approval card while one waits, and the
  run tree. A firing that never became a run (missed, refused) links to the schedule's page at that firing instead.
  Its second link, **History**, opens the schedule's page on its history.
- **Repeats.** A new notification of the same schedule replaces its earlier one while that is still unread (in the
  inbox, and on the phone by the push's tag), so a schedule every 15 minutes leaves one item, not forty.

## The hub side

The system owns its kind and its timer (decided `timer-home`). The hub adds only what lets *any* system start its own
kind's fns later on behalf of their owners and tell them how it went, plus the injection change. Why the timer is the
system's:
- Harness systems own their kinds: the kind's payload, its checks and when it runs are the system's; the hub stays a
  small core that never needs dayspan, time zones or schedule rules.
- "Nothing runs later by itself" is then true of the hub alone and false only while a system that says otherwise is
  installed and live: switching the schedule system off stops every timer, and its review page says so.
- The capability is visible: a system that may start runs by itself declares the `runs` grant, and the review flags it
  ("Starts runs on its own, as the owners of its fns, and notifies them").
- The hub already has the hard parts: durable queues, sessionless turns for a person (the hub MCP's runner does exactly
  this, `mcp/calls.ts`), idempotent proposals by key, push notifications.

What the hub adds (all generic; none of it names schedules):

1. **Starting a kind's fn as its owner** (`ctx.runs.start`, link endpoint `start`, grant `runs`). Outside any run, a
   system may start a run of a fn of one of its own kinds, as that fn's owner. The hub refuses unless the fn is of a
   kind this system declares, its owner is a person who can still use the hub, the system is live, and the owner may
   run it (policies, as at any call). It makes a sessionless turn for the owner (limits resolved for `background`,
   lowered by the given cap) with the system's actor as the caller. A `key` makes it idempotent: the same key is the
   same run, so a retried or doubled start never fires twice.
2. **Listing a kind's fns** (`ctx.runs.kindFns`): every fn of one of this system's kinds with owner, title, version and
   its payload (parsed by the kind's payload type), a page at a time, optionally changed since a time: what the timer
   loads at start. The `fns` event gains `changed` (a new version of a fn), so an edit made anywhere (the fn page,
   `hub/fns_save`, an owner being turned off) re-plans.
3. **Notifying a kind fn's owner** (`ctx.runs.notify`, same grant): outside a run, an inbox item and push to the
   owner of one of this system's kind's fns, never anyone else. And **`ctx.notify` in a run**: the same to the person
   the run is for (what `schedule/remind` uses). Reason `system-message`.
4. **Notifications gain** a link to a system page (`{ page }`, beside today's session, run, approval, pairing and
   system links), a second link with a label (`also`, shown as a button in the inbox and as a push action), a `tone`
   (ok, failed, info: the inbox icon) and a `key` (a new one with the same key replaces the person's unread one, and
   is the push's tag).
5. **A person's run page** (`/run/:run`, web): today a run outside a chat opens only in Admin › Runs. This page shows
   one run to its own person (or an admin): its status, args, result (through the fn's renderer), changes, errors, its
   tree, the approval card while one waits, and Undo. A notification's `run` link opens it when the run is in no chat
   (for admins too). Every sessionless run gets it, the hub MCP's included.
6. **The settled-run event says `notified`**: whether the run or one of its children sent its person a notice.
7. **Page refs**: a contract gives a ref per declared page (`schedule.page.item`), so links to pages are refs, never
   segment strings.
8. **Policies by caller**: a policy may also match on the fn whose run made the call (`via`), so "always allow
   `fs/write` when `schedule/nightly_backup` calls it" is a policy, which the add card's "Let its runs go ahead" records.
9. **Removing a saved fn from a system** (`hub/fns_remove`, the owner's or an admin's, undoable by restoring the last
   version): the hub has `fns_save` but no remove a system can call; `schedule/remove` needs one.
10. **`InjectDecl.replaces`** (chat side, below), and the split of the hub's `limits` item.

**Durability across restarts.** The system keeps its timer in its data folder (`ctx.dataDir`): an `@ayepi/work` queue
on SQLite ports, one delayed item per schedule for its next firing (`runAt` the planned instant, id
`<fn>@<instant>`), and a small table per schedule (version, last planned instant, last firing, the run going now, the
last refusal told). On start it reconciles: it loads every schedule fn with `kindFns`, queues each one's next firing if
it isn't queued, and for each schedule works out the firings between its last planned instant and now; those are
missed, and the `missed` rule decides whether the latest runs late. When the hub is unreachable at fire time, the work
item waits and retries (`WorkDelayError`) until the grace window passes, then records the firing as missed once the
hub is back. Firing records are written to the hub (person-owned records), so they survive the system and are exported
with nothing extra; the local tables are rebuilt from the hub if the data folder is lost (only the not-yet-recorded
firings are lost then). A notification is sent after its firing record is written, keyed by the firing, so a restart
between the two sends it once.

**Multi-instance.** The system is `instances: "one"`: one timer per hub. If two copies ever run at once (an upgrade
overlapping the old one, a data folder restored on a second machine), nothing fires twice: the hub's `key` is the
firing (`schedule:<fn>@<instant>`), so the second start returns the first's run. If the system becomes `many` later,
`@ayepi/work`'s shared ports and its per-occurrence lease already handle a fleet.

## The chat side

**Fns for the model** (group `schedules`):
- `schedule/add({ fn, when, args?, compute?, name?, zone?, notify?, overlap?, missed?, maxSpend? })` → the schedule:
  its name, what it says in words, the next three firings in the person's zone, the first firing's args, and when the
  person is notified.
- `schedule/change({ schedule, …any of add's fields })` → the same.
- `schedule/list({ fn?, search?, paused? })` → the person's schedules with their next firing and the last firing's
  status and summary.
- `schedule/pause({ schedule, until? })`, `schedule/resume({ schedule })`, `schedule/remove({ schedule })`.
- `schedule/skip({ schedule, day, time? })`: skip one firing.
- `schedule/history({ schedule?, from?, to?, status? })` → a page of firings, each with its summary and run.
- `schedule/remind({ text })`: a fn that only notifies its own person, so "remind me" is a schedule of it rather than a
  sentence about what the app can't do.

**How the model writes the args** (decided `args-authoring`): fixed values in `args` (JSON, checked against the
target's args), and the ones that depend on the firing in `compute`, in plain words ("`from`: the firing's day minus
7 days; `to`: the firing's day"). When `compute` is given, a small authoring step (the code system's program tools, on
`ctx.ai()`, with `fire` and `previous` typed in its scope) writes the gin program, checks it against the target's args
type, runs it for the next three firings and saves it with the words. The model never writes gin, and a person editing
on the page sees the words and the three previews.

**The injected item** (`schedule/basics`, into `hub/chat*`, order 30, `replaces: [hub/later]`). General purpose,
written for any request:

```md
---
title: Scheduled runs
summary: "schedule/add runs a fn of the person's later, once or repeating, as them; only at times, never on events.
  Results come as a notification, not into this chat. Never say something is scheduled unless the result says so."
---

A fn can run later by itself on a schedule. schedule/add saves a schedule of the person's: which fn, its args, and
when (once on a day, or repeating by days of the week or month with times of day) in their time zone. It runs as
the person, at background priority, with the same approvals and budgets as their chat.

- Settle the fn, its args and the times first. Args that change with each run (the day it runs, the week before it)
  go in `compute`, in plain words; fixed ones in `args`.
- The result says when it runs in words and lists the next times: read those back to the person, and never say
  something is scheduled unless the result says so.
- Each run's result does not come back into this chat. The person gets a notification with a short summary and a
  link to the run (`notify` says when: always, only when it fails, or never), and the Schedule page keeps every run.
  Don't promise to tell them here.
- To remind the person of something, schedule schedule/remind with the text.
- Change, pause, resume, skip or remove one with schedule/change, schedule/pause, schedule/resume, schedule/skip and
  schedule/remove; schedule/list shows theirs, and schedule/history what past runs gave.

What still can't happen: nothing starts because something else happened (a new file, an email, a change somewhere):
only at times. A scheduled run can notify the person it is for, and no one else unless a fn it calls does. A run
that needs approval waits for the person, who is notified.
```

(In the contract the fn names in this text are refs, `${fns.add}`, so a rename doesn't compile.)

**How `hub/limits` changes** (decided `limits-text`: what makes sense from the other answers, which is the recommended
`replaces`). Today one hub item, `packages/hub/context/limits.md`, says three things. It becomes two: `hub/limits`
(you can't connect accounts or set up services; never invent setup steps) and `hub/later` ("Nothing runs later by
itself", "No messages to anyone later", and the closest-real-thing advice for "every month" and "remind me"). No hub
text names the schedule system. Instead a context item may declare `replaces`: while it is in an agent's section, each
item it replaces is left out with the reason `replaced` (and by what), shown on the agent's Injected tab like every
other reason. The schedule system's `basics` replaces `hub/later` and restates what is still true. With the system
off, out of the chat, or its item switched off, `hub/later` is back. A declaration that replaces another system's item
raises the `injects` review flag ("Takes hub/later out of hub/chat and hub/chat_small").

## The schedule page

- **`/s/schedule/calendar`** (nav `main`, title "Schedule", icon `calendar`). The person's schedules on a calendar.
  `?view=month|week|agenda&day=2026-11-23&schedule=…` is in the URL. Coming firings are worked out in the browser from
  each schedule's payload by the same shared code the server uses (`shared/when.ts`, over dayspan's `Calendar` and
  `Schedule`), so the calendar needs no server round trip to page forward. Past firings are the `schedule/Firing`
  records, coloured by status (ran, failed, missed, skipped, refused, waiting). Each entry shows the schedule's name and
  the target fn as a `FnPill`; it opens a panel with the firing's summary, args and status, and links to the schedule,
  the target fn's page and the run page. A filter picks schedules; a "Paused" badge marks paused ones, whose coming
  firings are drawn faded.
- **`/s/schedule/item/<schedule>`** (hidden): one schedule. What it runs and when in words, its zone ("New York time"
  when it isn't the viewer's), when it notifies, the next firings, its history (paged, `?tab=history`, each row with
  its summary and a link to its run; `?firing=<key>` opens one), and Pause, Resume, Run now, Skip (from a coming
  firing's menu) and Remove. **Edit** opens the form: the fn (search), when (presets built from dayspan's patterns:
  once, every day, weekdays, every week on…, every other week, the Nth weekday of the month, the last day of the
  month; or custom rules; a list of times; the zone), the args (the target's args type in the app's `ValueEditor` for
  fixed values, the `compute` words with three previews for computed ones), "Notify me" (every run, only when it
  fails, never), and overlap and missed firings under "More". Saving runs `schedule/change` as the person through
  `host.runs`, so approvals and undo are the same as in a chat.
- **`/s/schedule/all`** (access `admin`): every schedule on the hub, by owner, with pause, so an admin can see and stop
  anything that runs by itself.
- **The run page** of a firing is the hub's (`/run/<run>`); the schedule kind's result renderer adds a header there
  (the schedule's name, "planned for Mon 9:00, ran 2 min late", a link to its history) above the target's own result.
- **Mobile.** Agenda is the default under 640 px. The month grid shows a dot per firing and opens that day's agenda
  on tap; the week view scrolls one day at a time. The edit form is one column. Everything is drawn with the app's
  shared components (`Frame`, `Button`, `Select`, `Dialog`, `Badge`, `FnPill`, `ValueEditor`, `Markdown`, `Empty`,
  `LoadState`, `Skeleton`); only the calendar grid is the system's own component. If a second system wants a calendar
  (google-calendar), the grid moves into the app's shared components.
- **Result renderer.** `schedule/add`, `change` and `list` results are drawn by the system's renderer (the schedule in
  words, the next firings, when it notifies, a link to its page), in the chat and on any page that shows the run.

## Types (final, for approval)

One source for each type. The schedule's own shapes are zod in `systems/schedule/shared/types.ts` (the hub never needs
them, so they stay out of core); the contract makes them gin with `ginAs`, and TypeScript types are `z.infer`, never
written twice. Everything that points at something the code declares (a fn, a kind, a page, a context item) is a ref.
The hub's generic additions go in `packages/core` (records, notifications, inject, grants) and `packages/sdk/src/ctx.ts`.

### Core shapes (systems/schedule/shared/types.ts)

```ts
import { z } from 'zod';
import { ActorId, GinExprDef, Json, QualifiedName, RunId, Timestamp, Usd } from '@harness/core';

/** A local day, `YYYY-MM-DD`, read in the schedule's zone. */
export const LocalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).brand<'LocalDay'>();
/** A time of day, `HH:mm` (24-hour). */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).brand<'ClockTime'>();
/** One firing: a whole day (`2026-12-25`) or one time of a timed schedule (`2026-12-24T18:00`), as dayspan's exclude/include take it. */
export const OccurrenceKey = z.string().regex(/^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/).brand<'OccurrenceKey'>();
/** An IANA time zone (`America/New_York`), checked with Intl. */
export const Zone = z.string().refine(isIanaZone, 'an IANA time zone, such as America/New_York').brand<'Zone'>();
export const Every = z.object({ every: z.number().int().min(1), offset: z.number().int().min(0).optional() }).strict();

const days = (min: number, max: number) => z.array(z.number().int().min(min).max(max)).min(1).optional();

/**
 * When: dayspan's ScheduleInput as stored (Oryoli's strict subset), read in the schedule's zone. Checked: `on` or day
 * rules, not both; `maxOccurrences` needs `start`; `start` ≤ `end`; times unique and at least `minGap` apart (config).
 */
export const When = z.object({
  on: LocalDay.optional(),                         // a one-off
  start: LocalDay.optional(),
  end: LocalDay.optional(),
  maxOccurrences: z.number().int().min(1).optional(),
  dayOfWeek: days(0, 6),                           // 0 = Sunday … 6 = Saturday
  dayOfMonth: days(1, 31),
  lastDayOfMonth: days(1, 31),                     // 1 = the last day
  weekspanOfMonth: days(0, 4),                     // 0 = days 1–7 ("the 1st Tuesday")
  lastWeekspanOfMonth: days(0, 4),                 // 0 = the last 7 days ("the last Friday")
  weekOfMonth: days(0, 5),
  weekOfYear: days(1, 53),
  month: days(0, 11),                              // 0 = January
  year: z.union([z.array(z.number().int()).min(1), Every]).optional(),
  daysSinceEpoch: Every.optional(),                // every N days from start
  weeksSinceEpoch: Every.optional(),
  monthsSinceEpoch: Every.optional(),
  times: z.array(ClockTime).optional(),            // each is a firing; none = one at 00:00
  exclude: z.array(OccurrenceKey).optional(),      // skipped firings
  include: z.array(OccurrenceKey).optional(),      // extra firings
}).strict().superRefine(whenProblems);
export type When = z.infer<typeof When>;

/** Which settled firings the owner is told about. */
export const Notify = z.enum(['always', 'failed', 'never']);
/** A firing due while the last one still runs. */
export const Overlap = z.enum(['skip', 'queue', 'replace']);
/** Firings that couldn't start on time. */
export const Missed = z.enum(['latest', 'none']);

/** A schedule: the payload of a `schedule/schedule` fn. */
export const SchedulePayload = z.object({
  /** The fn it runs (stored data, so a name; the kind's `describe` turns it into the schedule's one dep). */
  fn: QualifiedName,
  when: When,
  zone: Zone,
  /** A gin program over `fire` and `previous` whose result is `fn`'s args (a literal for fixed args). Checked against `fn`'s args type. */
  args: GinExprDef,
  /** The words `args` was written from, when it computes anything. */
  argsAsked: z.string().min(1).optional(),
  notify: Notify.default('always'),
  overlap: Overlap.default('skip'),
  missed: Missed.default('latest'),
  maxSpend: Usd.positive().optional(),
  paused: z.object({ at: Timestamp, by: ActorId, until: LocalDay.optional() }).strict().optional(),
}).strict();
export type SchedulePayload = z.infer<typeof SchedulePayload>;

/** What the args program reads as `fire`. */
export const Fire = z.object({
  at: Timestamp,                                   // the instant it was planned for
  local: z.string(),                               // that instant in the zone, with its offset: 2026-11-30T09:00:00-05:00
  day: LocalDay,
  time: ClockTime.optional(),
  zone: Zone,
  count: z.number().int().min(0),                  // firings before this one
  late: z.number().int().min(0),                   // ms after `at` that it started
  manual: z.boolean(),                             // run now
});
export type Fire = z.infer<typeof Fire>;

/** What it reads as `previous`. `result` is Json here; the authoring step's scope types it as the target fn's result. */
export const PreviousFiring = z.object({ at: Timestamp, status: z.enum(['ran', 'failed']), result: Json.optional() });
export type PreviousFiring = z.infer<typeof PreviousFiring>;

export const FiringStatus = z.enum([
  'running', 'waiting',                            // started; waiting = for approval or a budget window
  'ran', 'failed', 'cancelled',                    // its run settled
  'skipped',                                       // overlap: the last one was still running
  'missed',                                        // couldn't start in time
  'refused',                                       // the hub refused, or approval was needed and the admin says refuse
  'expired',                                       // waited for approval past the next firing
]);
export type FiringStatus = z.infer<typeof FiringStatus>;

/** A `schedule/Firing` record (owned by the schedule's owner): one firing that was due. */
export const FiringShape = z.object({
  schedule: QualifiedName,
  version: z.string(),
  at: Timestamp,                                   // planned
  key: OccurrenceKey,                              // the firing within the schedule: its day, or day and time
  manual: z.boolean(),
  status: FiringStatus,
  run: RunId.optional(),                           // absent for skipped, missed, refused before a run
  args: Json.optional(),
  startedAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
  cost: Usd.optional(),
  /** The one line the owner was (or would have been) told: the result's summary, or the reason in words. */
  summary: z.string().max(160).optional(),
  /** Whether the owner was notified of this firing. */
  notified: z.boolean(),
}).strict();
export type FiringShape = z.infer<typeof FiringShape>;

/** A schedule as the chat's results and the page show it. */
export const ScheduleView = z.object({
  schedule: QualifiedName,
  fn: QualifiedName,
  says: z.string(),                                // "Every Monday at 9:00 am, New York time"
  zone: Zone,
  notify: Notify,
  next: z.array(z.object({ at: Timestamp, local: z.string() })),
  firstArgs: Json.optional(),                      // the next firing's args
  paused: z.object({ until: LocalDay.optional() }).optional(),
  last: FiringShape.pick({ at: true, status: true, run: true, summary: true }).optional(),
});
export type ScheduleView = z.infer<typeof ScheduleView>;
```

`day` and `time` are gone from the record: `key` holds both (`2026-11-30T09:00`), and `fire` gives them to the program.

### The contract (systems/schedule/shared/index.ts)

```ts
import { agents, context, fn, g, ginAs, hub, json, kind, system, type } from '@harness/sdk';
import { FiringShape, FiringStatus, Missed, Notify, Overlap, SchedulePayload, ScheduleView, When, Zone, LocalDay, ClockTime } from './types.ts';

export const Limits = g.obj({
  minGap: g.field(g.duration(), { docs: 'The shortest gap between two firings of one schedule.' }),       // 15 min
  perPerson: g.field(g.num(), { docs: 'Schedules one person may have.' }),                                 // 50
  firingsPerDay: g.field(g.num(), { docs: 'Firings one person may have in a day.' }),                     // 200
  grace: g.field(g.duration(), { docs: 'How late a missed firing may still run.' }),                       // 6 h
  approvals: g.field(g.enum(['wait', 'refuse']), { docs: 'A firing that needs approval waits for its person, or is refused.' }),
  keep: g.obj({ perSchedule: g.num(), days: g.num() }),                                                    // 500, 180
});

/** What schedule/add is asked; change takes the same, all optional, plus `schedule`. */
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
export const AddArgs = g.obj({ fn: g.field(g.fnName(), { docs: 'The fn to run, as your tools spell it.' }), ...Settings });
export const ChangeArgs = g.obj({ schedule: g.fnName(), fn: g.optional(g.fnName()), ...partialOf(Settings) });
export const ScheduleArg = g.obj({ schedule: g.fnName() });
export const View = ginAs(ScheduleView);

export const Firing = type({
  description: 'One firing of a schedule that was due: when, its status, its summary and its run.',
  shape: ginAs(FiringShape),
  display: { label: 'Firing', plural: 'Firings', icon: 'clock', title: 'schedule', subtitle: 'summary' },
  records: { shape: 'table', owner: 'person', search: { text: ['schedule', 'summary'], embed: false } },
});

export const schedule = system('schedule', {
  description: 'Runs fns later by themselves, once or repeating, as the person who scheduled them, and notifies them how each run went.',
  about: '…',                                       // what it is for, its kind, its fns, when to reach for it
  groups: [{ name: 'schedules', title: 'Schedules', description: 'Add, change, pause and remove scheduled runs of fns.' }],
  // it starts its own kind's fns as their owners and notifies them, keeps firings as records, writes computed args
  grants: { hub: ['runs', 'data', 'fns', 'search', 'ai'], calls: [hub.fns.fns_get.name, hub.fns.fns_save.name, hub.fns.fns_remove.name] },
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
        description: 'A schedule: runs one fn later by itself, at the times its dayspan schedule gives, as its owner, who is notified how it went. Calling it by name runs it now.',
        applicability: 'Something the person wants done at a time or on a repeating schedule, made by schedule/add.',
        payload: ginAs(SchedulePayload),
        approveChanges: false,
        status: status('Running {fn}…', 'Ran {fn}', '{fn} failed'),
      }),
    },
    fns: {
      add: fn({
        group: 'schedules',
        description: 'Schedule a fn to run later by itself, once or repeating, as the person; gives the schedule, when it runs in words, its next times and when the person is notified.',
        args: AddArgs,
        returns: View,
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        undo: ScheduleArg,
        effects: { mode: 'write', registry: [{ thing: 'fns', action: 'create', kind: SCHEDULE_KIND }] },
        examples: [
          { args: { fn: 'database/main.sales_by_week', when: { dayOfWeek: [1], times: ['09:00'] }, compute: 'week_start: the firing\'s day minus 7 days' }, note: 'Every Monday at 9:00, the week before.' },
          { args: { fn: 'schedule/remind', when: { on: '2026-12-01', times: ['08:30'] }, args: { text: 'Renew the car registration.' } }, note: 'A one-off reminder.' },
          { args: { fn: 'fs/nightly_backup', when: { dayOfWeek: [0, 1, 2, 3, 4, 5, 6], times: ['02:00'] }, notify: 'failed' }, note: 'Every night; tell me only when it fails.' },
        ],
      }),
      change: fn({ group: 'schedules', args: ChangeArgs, returns: View, deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save }, undo: /* the version before */ … }),
      list:   fn({ group: 'schedules', args: g.obj({ fn: g.optional(g.fnName()), search: g.optional(g.text()), paused: g.optional(g.bool()) }), returns: g.obj({ items: g.list(View), cursor: g.optional(g.text()) }), effects: { mode: 'read', free: true } }),
      pause:  fn({ group: 'schedules', args: g.obj({ schedule: g.fnName(), until: g.optional(ginAs(LocalDay)) }), returns: View, /* undo */ }),
      resume: fn({ group: 'schedules', args: ScheduleArg, returns: View, /* undo */ }),
      skip:   fn({ group: 'schedules', args: g.obj({ schedule: g.fnName(), day: ginAs(LocalDay), time: g.optional(ginAs(ClockTime)) }), returns: View, /* undo */ }),
      remove: fn({ group: 'schedules', args: ScheduleArg, returns: g.obj({ removed: g.fnName() }), deps: { removeFn: hub.fns.fns_remove }, /* undo: restore the last version */ }),
      history: fn({ group: 'schedules', args: g.obj({ schedule: g.optional(g.fnName()), from: g.optional(g.timestamp()), to: g.optional(g.timestamp()), status: g.optional(ginAs(FiringStatus)) }), returns: g.obj({ items: g.list(Firing), cursor: g.optional(g.text()) }), effects: { mode: 'read', free: true } }),
      remind: fn({
        description: 'Notify the person with a short text (their phone and inbox). Made to be scheduled.',
        args: g.obj({ text: g.text({ minLength: 1, maxLength: 160 }) }),
        returns: g.obj({ sent: g.bool() }),
        effects: { mode: 'read', free: true },
        examples: [{ args: { text: 'Take the bins out.' } }],
      }),
    },
  })
  .with(({ fns }) => ({
    context: {
      guide: context({ description: 'How to schedule fns: when, args that change per run, notifications.', content: '…', fns: [fns.add, fns.list] }),
      basics: context({
        title: 'Scheduled runs',
        description: 'That fns can run later by themselves, how to schedule one, and that results come as notifications.',
        summary: '…',                      // as above, with ${fns.add} refs
        content: '…',                      // the item above
        fns: [fns.add, fns.list],
        requires: [fns.change, fns.pause, fns.resume, fns.skip, fns.remove, fns.history, fns.remind],
        inject: { into: [agents.startingWith(hub.fns.chat)], order: 30, replaces: [hub.context.later] },
      }),
    },
  }));

// refs this exports, used below: schedule.kinds.schedule, schedule.fns.*, schedule.types.Firing,
// schedule.page.calendar, schedule.page.item, schedule.page.all, schedule.context.basics
```

### The server (shape only)

```ts
// systems/schedule/server/impl.ts
export function createScheduleImpl(deps: { timer: Timer }): SystemImpl<ScheduleContract['defs']> {
  return {
    kinds: {
      schedule: {
        check: (payload, ctx) => payloadProblems(payload, ctx),     // payload arrives parsed (SchedulePayload); gaps ≥ minGap, args checks against fn's args
        describe: (payload, ctx) => describeSchedule(payload, ctx), // args: { at?: Timestamp }, returns: fn's result, deps: [fn]
        async run(payload, args, ctx) {
          const fire = fireOf(payload, args.at ?? ctx.run.time.now, { manual: args.at === undefined, started: ctx.run.time.now });
          const input = await runArgsProgram(payload, { fire, previous: await deps.timer.previous(ctx.run.fn) }, ctx);
          const settled = await ctx.call(payload.fn, input);           // the target, as the owner's child run
          return settled.status === 'done' ? ctx.done(settled.result) : ctx.fail('caller', failedText(payload.fn, settled));
        },
      },
    },
    fns: { add, change, list, pause, resume, skip, remove, history, remind: { run: async (args, ctx) => { await ctx.notify({ title: 'Reminder', body: args.text }); return ctx.done({ sent: true }); } } },
    events: { fns: (event, ctx) => deps.timer.replan(event, ctx), run: (event, ctx) => deps.timer.settled(event, ctx) },
    lifecycle: { started: (ctx) => deps.timer.reconcile(ctx), stopping: (ctx) => deps.timer.stop(ctx) },
  };
}

// a due firing, on the timer's @ayepi/work queue (`due.schedule` is a KindFn from ctx.runs.kindFns(schedule.kinds.schedule)):
const started = await ctx.runs.start(due.schedule, {
  args: { at: due.at },
  key: `schedule:${due.schedule.fn}@${due.at}`,
  priority: 'background',
  maxSpend: due.schedule.payload.maxSpend,
});

// when it settles (events.run, `notified` from the hub) or never became a run (missed, refused):
const firing = await deps.timer.record(due, settled);              // the schedule/Firing record, with its summary line
if (tells(due.schedule.payload.notify, firing, settled?.notified)) {
  await ctx.runs.notify(due.schedule, {
    title: titleOf(due.schedule, firing),                            // "Weekly sales summary ran"
    body: firing.summary,                                            // summaryLine(): the rules above, no model
    tone: firing.status === 'ran' ? 'ok' : 'failed',
    link: firing.run !== undefined ? { run: firing.run } : { page: schedule.page.item, path: [localOf(due.schedule.fn)], query: { firing: firing.key } },
    also: { label: 'History', link: { page: schedule.page.item, path: [localOf(due.schedule.fn)], query: { tab: 'history' } } },
    key: `schedule:${due.schedule.fn}`,
  });
}
```

### The hub's generic additions

```ts
// packages/sdk/src/refs.ts
/** A typed handle to one of a system's pages (`schedule.page.item`): links to pages are refs, never segment strings. */
export interface PageRef<N extends QualifiedName> {
  readonly ref: 'page';
  readonly name: N;                               // `schedule/item`: the system and the page's segment
}
export type AnyPageRef = PageRef<QualifiedName>;
// a contract gains `page`: one PageRef per declared page, keyed by segment (`schedule.page.calendar`, `.item`, `.all`)

// packages/sdk/src/ctx.ts
/** What a ctx knows of its own contract: refs of another system's kinds and pages don't fit where only its own do. */
export interface Own<K extends AnyKindRef = AnyKindRef, P extends AnyPageRef = AnyPageRef> {
  readonly kinds: K;
  readonly pages: P;
}
// SystemImpl<Defs> types every ctx it hands out with Own<its kind refs, its page refs>.

export interface SystemCtx<Cfg = unknown, O extends Own = Own> {
  /** Needs the `runs` grant. */
  readonly runs: KindRuns<O>;
}

/** Runs of this system's own kinds' fns, started by the system itself as each fn's owner, and notices to those owners. */
export interface KindRuns<O extends Own> {
  /** The fns of one of this system's kinds, with owner, title, version and parsed payload, a page at a time. */
  kindFns<K extends O['kinds']>(kind: K, query?: { changedSince?: Timestamp; cursor?: string }): Promise<{ items: KindFn<K>[]; cursor?: string }>;
  /**
   * Start a run of the fn, as its owner, outside any run and any chat (a sessionless turn). Refused (with the reason)
   * unless the owner can still use the hub, the system is live and the owner may run it. The same `key` is the same run.
   */
  start(fn: KindFn<O['kinds']>, options: StartAsOwner): Promise<StartedRun>;
  /** Notify the fn's owner (inbox and push), never anyone else. */
  notify(fn: KindFn<O['kinds']>, notice: Notice<O>): Promise<void>;
}

/** A fn of one of this system's kinds, as the hub lists it. Only `kindFns` makes one (branded), so it can't be built by hand. */
export interface KindFn<K extends AnyKindRef> {
  readonly [kindFnBrand]: K['name'];
  readonly fn: QualifiedName;
  readonly kind: K['name'];
  readonly owner: ActorId;
  readonly title: string;
  readonly version: string;
  readonly payload: PayloadOf<K>;                 // parsed by the kind's payload type
  readonly removed: boolean;
  readonly updatedAt: Timestamp;
}

export interface StartAsOwner {
  /** Checked by the hub against the args the kind's `describe` gives the fn. */
  args: Json;
  /** Required: the same key is the same run. */
  key: string;
  priority?: 'background' | 'interactive';       // default background
  /** Lowers the turn's per-turn budget. */
  maxSpend?: Usd;
}
export interface StartedRun { readonly run: RunId; readonly turn: TurnId; readonly status: RunStatus }

/** A notice to one person: the owner of a kind fn (`runs.notify`) or the person a run is for (`ctx.notify`). */
export interface Notice<O extends Own = Own> {
  title: string;
  /** At most NOTIFICATION_BODY (160) characters; longer is clamped on a word boundary. */
  body: string;
  tone?: 'ok' | 'failed' | 'info';                // default info
  /** Where it leads. Absent: from a run, that run; from `runs.notify`, the system's main page. */
  link?: NoticeLink<O>;
  /** A second link, shown as a button and a push action. */
  also?: { label: string; link: NoticeLink<O> };
  /** A later notice with the same key replaces this one while it is unread (and is its push tag). */
  key?: string;
}
export type NoticeLink<O extends Own = Own> =
  | { run: RunId }
  | { page: O['pages']; path?: readonly string[]; query?: Readonly<Record<string, string>> };

// in a run's ctx (FnCtx<T, Cfg, O>):
/** Notify the person this run is for (inbox and push), never anyone else. */
notify(notice: Notice<O>): Promise<void>;

// packages/core/src/records/content.ts
export const NOTIFICATION_BODY = 160;            // moved from hub/src/chat/turns.ts
export const NotificationReason = z.enum([/* today's */, 'system-message']);
export const NotificationLink = z.union([
  /* today's: session, approval, pairing, run, system */
  z.object({ page: z.object({ system: SystemName, segment: z.string(), path: z.array(z.string()).optional(), query: z.record(z.string(), z.string()).optional() }) }),
]);
export const Notification = z.object({
  /* today's fields, and: */
  tone: z.enum(['ok', 'failed', 'info']).optional(),
  also: z.object({ label: z.string().min(1).max(24), link: NotificationLink }).optional(),
  key: z.string().max(200).optional(),
});

// packages/core/src/system-events.ts
// the `fns` event gains `changed` (a new version of a fn); the settled `run` event gains
// `notified: boolean` (the run or a child sent its person a notice)

// packages/core/src/grants.ts: HUB_CAPABILITIES gains 'runs' (review flag: "Starts runs on its own, as the owners of its fns, and notifies them")
// policies: a match gains `via?: QualifiedName` (the fn whose run made the call)
// hub fns: `hub/fns_remove({ fn })`, the owner's or an admin's, undo restores the last version

// packages/core/src/inject.ts
export const InjectDecl = z.object({
  into: z.array(AgentTargetDecl).min(1),
  order: z.number().int().min(0).max(1000).default(100),
  requires: z.array(QualifiedName).default([]),
  mode: z.enum(['tools', 'static']).optional(),
  /** Context items this one takes the place of: while it is in an agent's section, each is left out (`replaced`). */
  replaces: z.array(QualifiedName).default([]),
});
// the SDK's inject input takes refs (`replaces: [hub.context.later]`) and writes their names here

// packages/web: route `/run/:run` (`links.run(run)`): one run for its own person or an admin;
// notificationTarget sends a run outside any chat there instead of Admin › Runs
```

What doesn't compile (added to `types/examples.ts` with the build): `runs.start`, `runs.notify` or `kindFns` with a fn
or kind of another system's, or with a fn not listed by `kindFns` (a hand-built object); `runs.start` without a `key`;
`runs.notify` to anyone but the fn's owner (there is no `to`); `ctx.notify` outside a run (a `SystemCtx` has none); a
notice linking to another system's page, or to a page by segment string; a `replaces` naming anything but a context
ref; an `exclude` like `"2026-12-24 18:00"` (OccurrenceKey is branded: values come from `When.parse` or the shared
helpers); the old `deliver` field or a `chat` option anywhere. What the hub still checks at run time, because it is
data: a schedule's `args` program against its own `fn`'s args (when saved and when the target changes), and a page
link's segment against the system's declared pages.

## Library asks

- **dayspan: instants in a zone.** Oryoli and this system both turn a schedule's local days and times into instants
  in an IANA zone across daylight saving (`zonedTime`, `localNow` in Oryoli's `server/src/reminders.ts`). Recommended:
  move them into dayspan (`Schedule.instants(from, to, zone, limit)` and `nextInstant(after, zone)`), published by its
  release workflow, and have Oryoli use them too. Without it the schedule system copies Oryoli's functions.
  **Postponed (2026-11-23):** slice 2 waits; until then the rule lives in `systems/schedule/shared/zoned.ts`
  (`zonedTime`, `localNow`, plus `offsetAt` and `localString` for `fire.local`), copied from Oryoli with its tests.
- **dayspan, later and only if wanted: "every N minutes between two times"** as one rule, instead of a list of times.

## Build slices (after the types are approved)

| # | Slice | Where | Estimate |
|---|---|---|---|
| 1 | Zod for the schedule's shapes, the contract with stub fns, `types/examples.ts` refusals | systems/schedule/shared | 0.5 day |
| 2 | dayspan zoned instants (library ask), release, Oryoli switched to it | dayspan, oryoli | 0.5 day |
| 3 | Hub: `runs.start`, `kindFns`, `runs.notify`, `ctx.notify`, the notification additions (`page` link, `also`, `tone`, `key` replacing unread, push tag and action), `NOTIFICATION_BODY` in core, the run event's `notified`, `fns.changed`, page refs, `hub/fns_remove`, grant `runs` with its review flag, policy `via` | hub, sdk, core | 2 days |
| 4 | Hub: `InjectDecl.replaces`, the `replaced` reason in planner and Injected tab, split `limits.md` into `limits` and `later` | hub, core, web | 0.5 day |
| 5 | Web: the person's run page `/run/:run` (result, tree, approval card, Undo), notification targets, the inbox's `also` button and tone | web | 1 day |
| 6 | System server: the kind (check, describe, run, the args program over `fire`/`previous`), the timer on `@ayepi/work` + SQLite, reconcile, missed, overlap, approvals wait/refuse, Firing records and their pruning, the summary line and the notice rules | systems/schedule/server | 2 days |
| 7 | Chat fns, the `compute` authoring step on the program tools, `remind`, the guide and `basics` items, the result renderers (add/change/list, and the run-page header) | systems/schedule | 1.5 days |
| 8 | Pages: calendar (month, week, agenda, mobile), one schedule with its history and edit form, the admin list | systems/schedule/client | 2.5 days |
| 9 | Tests: zones and daylight saving, missed and overlap, doubled starts, the start gate, the summary rules and which firings notify (no double notice with remind, refused once, unread replaced); a live run of each described flow once (GPT-6 Luna); ui-tests for the pages and the run page | all | 1.5 days |

About 12 days of work; 3, 4 and 5 can run beside 6 and 7 once slice 1 is in, and 8 needs only slice 1's shared code.

**Slice 1 built (2026-11-23, local).** `systems/schedule`: `shared/types.ts` (the zod shapes), `shared/zoned.ts`,
`shared/index.ts` (the contract), server stubs that fail `not-built` with the fn's name, `typetests/contract.ts`, and
unit and link tests; `partialOf` added to the SDK's gin helpers. Listed in the dev stack, off unless named in
`HARNESS_DEV_ONLY`. Where the build differs from the types above:
- `FiringShape.version` is a number (the hub's fn version is a whole number from 1), not a string.
- The config's limits are optional fields with the defaults in `LIMIT_DEFAULTS` (`limitsOf` fills them in), so an
  admin installs it without filling a form; the defaults are the ones above.
- `When`'s schema checks `on` against day rules, start, end and count, `maxOccurrences` needing `start`, `start` ≤
  `end` and unique times. The gap between times is the config's, so it is `gapProblems(when, minGap)`, which the
  kind's check calls (slice 6); a gap across midnight is checked when firings are planned.
- The contract is three `.with`s (kinds and the Firing type first), so `effects.registry` names the kind by its ref
  and `history` returns the Firing type's ref; `requires` sits in `inject`, where the SDK has it. The kind's status is
  the plain status object (there is no `status()` helper).
- `basics`' title is "Schedules" and its summary one line ("schedule/add runs fns later."): every chat item's title and
  summary share the small chat agent's 600-token cap (scripts/chat-prompt.test.ts), which this item filled; the rest
  of the summary's sentences are in its content. A wider cap is Phil's call.
- Waiting on slice 3 or 4, marked `TODO(slice 3)` / `TODO(slice 4)` where they go: the `runs` grant, `hub/fns_remove`
  (remove's dep and the grant's calls), `inject.replaces: [hub.context.later]`, page refs, and the hub-side refusals in
  "What doesn't compile". No client yet (slice 8), so the declared pages have no components to draw them.

**Slice 4 built (2026-11-23, local).** `InjectDecl.replaces` (core, optional on the wire, so manifests without it hash as
before), the SDK's `InjectInput.replaces` taking context refs, and refs to the hub's own context items
(`hub.context.<key>`, `HUB_CONTEXT_KEYS`, kept equal to the hub's `context/` folder by a test). The planner leaves a
replaced item out with `replaced` ("replaced by Schedules (schedule/basics), which says what is true instead"); the
Injected tab shows it ("Replaced", neutral), the review card and the `injects` line say what an item takes out
("takes hub/later out"), and the context-folder check follows `inject.replaces`. `hub/limits` is split into `limits`
(accounts, setup steps) and `later` (nothing runs later by itself, no messages to anyone later, the closest real
thing), neither naming a system. `basics` declares `replaces: [hub.context.later]`. Where the build differs:
- Replacing is decided when the section is gathered, before it is fitted: a replacing item that then falls to a
  `<more_ctx>` line or `no-fit` still keeps what it replaces out. It is one pass, so an item replaced by another still
  replaces what it names.
- **The small agent's cap is the planner's to keep, not a sum the tests cap** (decided 2026-11-23). The old check that
  every chat item's title and summary together stay under hub/chat_small's 600 tokens failed with each new system (this
  one's summary was cut to fit). The runtime already holds the cap: the section falls back, highest order first, from
  summary to a `<more_ctx>` line, then out. `scripts/chat-prompt.test.ts` now checks what matters: the hub's own items
  fit the cap by themselves, every chat item has its own summary of at most 220 characters (an eighth of the cap), and
  with thirty more systems' items the fitted section stays within the cap with every hub item still in it (at least
  as a line). With room again, `basics`' summary can be the design's two sentences (slice 7).

**Slice 3 built (2026-11-23, local).** The hub's generic additions: core `owner-runs.ts` (`KindFnsQuery`, `KindFnWire`,
`StartAsOwner`, `StartedRun`, `SystemNotice`) and the link endpoints `kindFns`, `startRun`, `notifyOwner` (grant
`runs`) and `notify` (base: a run's own person); the hub's `link/owner-runs.ts`; `NOTIFICATION_BODY` and the
notification additions in core (`PageLink`, `NotificationTone`, `NotificationAlso`, `key`, reason `system-message`);
the inbox replacing an unread notification of the same key in place, and the push carrying `also`, `key` and `tone`;
the `fns` event's `changed` and the settled run event's `notified`; page refs (`contract.page.<segment>`); `Own`,
`OwnOf`, `KindRuns`, `KindFn`, `Notice` and `ctx.notify` in the SDK, every impl ctx typed with its own refs;
`hub/fns_remove` with undo (hub fns can now register an undo); the `runs` review flag; policy `via`. The `TODO(slice
3)` stopgaps in `shared/index.ts` are gone (`runs` grant, `fns_remove` in the calls and remove's deps); the hub-side
refusals are `typetests/runs.ts`. Where the build differs from the types above:
- `KindFn.version` is a number (as `FiringShape.version`); `title` is the fn's name in words ("Weekly sales summary"):
  saved fns have no title of their own.
- `kindFns` lists only saved fns (they have an owner to run as); a contract's own fns of the kind are left out.
- `PageRef` also carries `system` and `segment` (what a link is written from). `system()` keeps its pages' segments in
  the contract's type, so `ContractShape` gains `system` and `pages` (by segment) beside the sections.
- The settled run event's `notified` is optional on the `run` event: set on the update that settles the run, absent on
  the others. The `fns` event's `changed` defaults to `[]`.
- A notice's body may be sent up to 2000 characters; the hub clamps what it keeps to `NOTIFICATION_BODY`. A notice's
  key is kept per system (`<system>:<key>`), so two systems never replace each other's. `also`'s label is at most 24
  characters. A notice from `runs.notify` with no link leads to the system's own page (`{ system }`).
- `ctx.notify` in a run needs no grant (it reaches only the run's own person); `runs` covers `kindFns`, `startRun` and
  `notifyOwner`.
- A policy's `via` matches the fn of any run above the call, not only its direct parent, so "let its runs go ahead"
  also covers the calls an agent the schedule runs makes.
- `hub/fns_remove` returns `{ fn, version }` (the version it had), which is also its undo payload.

**Slice 8 built (2026-11-23, local).** `systems/schedule/client` (the three pages, the calendar grid, the agenda, the
edit form, `logic.ts` and `state.ts`) and the system's `client` entry; `shared/when.ts`, the dayspan code the server and
the browser share: a `when`'s firings in its zone (`firingsOnDays`, `firingsBetween`, `nextFirings`, `firingOf`), its
words (`describeWhen`, dayspan's `en-plain`), and the presets from dayspan's patterns (`presetsFor`, `presetOf`).
`dayspan` 1.2 is a dependency of the system, which is now a workspace. Where the build differs from the design:
- dayspan is asked only which local days the rules give (each built at noon); times, skips, extras, `maxOccurrences`
  and instants are `when.ts`'s own, so the host's zone never moves a firing (dayspan reads days in the host's zone).
- The calendar reads the person's schedules with the hub's fn search (kind `schedule/schedule`, `mine`) and each one's
  payload with `hub/fns_get` as a quiet read (`readFn`), since `ScheduleView` has no `when`; firings are the
  `schedule/Firing` records in the range (at most 200 a range, the records page's limit). It draws on the viewer's
  own days; a schedule in another zone says so in its words.
- The page host gains `runHref(run)` / `goRun(run)` (SDK and web), so a firing links to its run page without reloading.
- The edit form's days are the browser's date and time inputs (the app has no date picker); custom rules the form edits
  are days of the week, days of the month and every N weeks; any other rules are kept as they are. An unchanged
  `when` is never sent, so opening and saving the form changes only what was changed.
- `/s/schedule/all` lists the hub's `fns` list (admins) filtered to the kind, with owners' names from `actors`; Pause
  and Resume there run `schedule/pause`/`resume` as the admin, so the server decides whether an admin may.
- Run now on a schedule's page runs the schedule fn itself (a manual firing); Skip on a coming run runs
  `schedule/skip`, and a skipped run is brought back with `schedule/change` (its `exclude` less that key).

**Slice 6 built (2026-11-23, local).** `systems/schedule/server`: `kind.ts` (check: `gapProblems` with the config's
`minGap`, the target, the args program; describe: `{ at? }`, the target's result and mode, deps), `args.ts` (the args
program over `fire` and `previous` on the shared program runtime, no fn calls, checked again at each run),
`timer.ts` (the timer, the kind's run, reconcile, catching up, overlap, approvals, limits, records, notices, pruning),
`store.ts` (its SQLite rows), `summary.ts` (the summary line and the notice rules) and `env.ts` (`SCHEDULE_DB`, `_POLL`,
`_ON_TIME`, `_APPROVAL_WAIT`, `_RETRY`, `_START_TIMEOUT`, `_LOST_AFTER`); tests with a fake clock and the fake hub
(`timer.test.ts`, `summary.test.ts`). The chat fns still refuse (slice 7); their seams are `ScheduleDeps.timer`
(`known`, `limits`, `store`), `scheduleProblems` and `shared/when.ts`. Where the build differs from the design:
- **A hub addition:** a firing that never became a run (missed, skipped, refused) is recorded outside any run, where
  the hub made a person-owned record the system actor's. `RecordSave` gains `owner` (`ctx.data.save(type, value,
  { owner })`), which the hub accepts only from a person-owned type's own system outside a run (403
  `RECORD_OWNER_REFUSED` otherwise; the fake hub does the same). A firing that ran is recorded in its run, as its
  person.
- The schedule fn's deps are the target **and `hub/fns_get`**: the run reads the target's signature again, so an args
  program that no longer fits a changed target fails with the reason instead of sending wrong args.
- The run event carries no result, so the summary is worked out in the schedule fn's own run (in this process: the
  timer and the kind share it), from the target's result and the done status line its child updates carry; the run
  event only says `notified` and settles the notice.
- The planned firing's record is written by its run, so a firing started but not yet run by the hub has a timer row
  and no record yet.
- Missed firings: when the latest runs late, its notice body begins "Missed 3 runs before this one." and ends with its
  summary and "(1 h late)"; when none runs, one notice: "… missed 3 runs", "It couldn't start in time for 3 runs, the
  last on Thu, Dec 3 9:00 am." A firing up to `SCHEDULE_ON_TIME` (1 min) late is on time even with `missed: 'none'`.
- A paused schedule queues nothing (or its first firing from its `until` day); its firings while paused are not
  recorded. A live change (a new version) plans from now, so times its edit put in the past are not "missed"; a
  version found changed at start (changed while the system was down) keeps the missed firings.
- "Cancelled by anything but the person": a child cancelled while the schedule run itself was not cancelled is told;
  the person cancelling the run (its signal) is not. "Replaced" (overlap) is told as cancelled.
- A refusal is told once per reason (the reason is the summary), reset when a firing runs. A refused start whose
  hub code is `OWNER_GONE` also tells the admins once (`notifyAdmins`, which has no fn link).
- Schedules per person: the newest beyond the limit (by last change) are refused at firing time; refusing them when
  saved is `schedule/add`'s (slice 7). "Run now" is not held to the limits or the overlap rule.
- A firing waiting for approval whose run is no longer in this process (a restart) is recorded as expired at its time
  but its run can't be cancelled from here (no hub endpoint cancels a run of a kind's fn); a firing marked running with
  no run here for `SCHEDULE_LOST_AFTER` (26 h) is recorded as failed.
- A gap across midnight (`23:55` and `00:05`) is not refused by the check (it depends on the days); the timer fires both.
- The work items are not given ids `<fn>@<instant>` (the work queue mints its own); each `due` item carries the fn and
  instant, and one that no longer matches the schedule's planned instant does nothing.

**Slice 7 built (2026-11-23, local).** `systems/schedule/server/fns.ts` (the chat fns), `server/authoring.ts` (the
`compute` step, `schedule_args_author` on the SDK's `authoringAgent` and the program tools' `examples`), the `guide`
and `basics` items' full text (`basics` back to the design's title "Scheduled runs" and its summary sentences, 210
characters), the code system's `about`, guide and basics saying a code fn "runs only when something calls it" (true
with or without schedules, naming none), and the result renderers in `systems/schedule/client` (`results.ts`,
`ScheduleCard`, `ScheduleResult`/`ChangeResult` for add and change, `ScheduleListResult`, `FiringResult` for the kind);
tests `fns.test.ts` (fake hub, fake clock, scripted model) and `client/results.test.ts`. Where the build differs:
- **A hub addition: `hub/fns_save` has an undo** (`SavedFn`: the fn, the version the save made, whether it made it).
  An undo has no fn calls of its own, so a schedule fn can't save the version before when it is undone; instead the
  turn's undo undoes its child save: the version before is put back (or a fn the save made is removed), unless the
  fn's newest version is no longer the one that save made (saved again or removed since). Undone newest first, a
  turn's saves step back one version each. `hub/fns_remove`'s undo brings a removed schedule back. Each schedule fn
  still leaves its own undo payload (`ScheduleArg`, `VersionBefore`), whose undo says the step in words, so the
  turn's note doesn't list it as "no undo".
- **`fire.date`**: the args program's `fire` also has `date`, the local day as a gin `date` (`addDays`, `addMonths`,
  `dayOfWeek`, `toText`): gin has no way to read a date out of text, so "the run's day minus 7 days" had no program.
  The `Fire` shape is unchanged; `fireType()`/`fireValue()` add it in the program's scope.
- Fixed `args` are one `new` of the target's args type with the JSON as its value. The type check reads a literal's
  slots loosely, so `add` and a change of args or fn also work out the first run's args and refuse them (at `args`)
  when they don't fit; a pause, resume or skip goes through whatever the args do.
- The compute step is handed the target, so it skips `find`; the model writes the whole args object (fixed values
  given as their literals, and checked to come out unchanged), sees each of the next three runs' args after a clean
  `set`, and `return` keeps the program for `add`/`change`, which save it. A step that gives up is `invalid` at
  `compute` with its last problems.
- `add` refuses a schedule past the per-person limit when it is saved (the timer's count of the person's schedules),
  a `when` that never runs, a target that is itself a schedule, and a taken `name` (a name worked out from the words
  takes the next free one, `orders_report_2`). With no `name`, a reminder is named from its first words.
- `list` reads the timer's schedules (what `kindFns` last listed) rather than a fn search: they carry their owner and
  payload, so a just-saved schedule shows once the hub's `fns` event has come. Its views have no `firstArgs` (one
  signature read per schedule); `history` takes no cursor, so it gives the newest 50.
- `ScheduleView.next[].local` is the run in words in the schedule's zone ("Mon, Nov 30 9:00 am"); `says` adds the zone
  when it isn't the person's.
- The add card's "Let its runs go ahead without asking" and a preview on the approval are not built: `add` is a write
  as declared, approved as the person's policies say.
- The run page header doesn't say how late a firing started (the renderer has only the run's args and result).

**Slice 9 built (2026-11-23, local).** The piece slice 7 left out, the tests the slices didn't cover, a live run of each
flow, and the pages' shots.
- **Allow at creation** (decided `approvals`). `schedule/add` asks on a card (`approval: { preview: true, remember:
  true }`): its preview (`addPreview`) says what it runs, as whom, when in words, the next three runs, its fixed args or
  the words they are worked out from, and when the person is notified, and offers "Let its runs go ahead without
  asking". The hub additions are generic: a preview may offer a choice on the card (`PreviewAnswer.ask`, with a
  `label`, `ProposalAsk.label`), which the hub keeps on the approval as its `ask` and fills into `args[into]` when
  answered (such a card is answered once); a **yielding** policy (`Policy.yields`), which decides only when no other
  policy matches, so an admin's deny or ask always wins; and `hub/fns_allow_runs({ fn, allow })` (tag `own`, grant
  `calls`), with which the kind's system records, for the fn's owner only, a yielding allow `{ via: fn }` of theirs, or
  removes it; its undo puts the choice back. The schedule keeps the choice (`runsAllowed: { at, by }`, `ScheduleView.
  runsAllowed`), its page shows it with "Ask me again" / "Let its runs go ahead without asking"
  (`schedule/allow_runs`, `visibility: 'user'`, refused unless the person runs it themselves), and `remove` takes the
  allowance away first, so a later schedule of the same name never inherits it. Where the build differs:
  - "An admin's refuse still wins": admin policies (a deny or an ask that matches) always beat the yielding allow,
    and while the config's `approvals` is `refuse` the card doesn't offer it and it can't be turned on. An allowance
    made before an admin switches to `refuse` stays until the person (or an admin policy) takes it back.
  - The offer is on every add card, not only "when the target would ask": whether a run would ask is decided by the
    hub's policies at run time (an agent's tool calls one by one), which the card can't know. A card with the offer
    is answered once (no "always" for add then); `add` without a card (a policy allows it) never sets it.
  - The choice is the person's: the preview refuses args that set `allowRuns`, and the run takes it only when it went
    ahead on an approval (`ctx.approved`) or the person ran `add` themselves.
- **Tests.** `fns.test.ts` (the add card, the choice recorded and refused, `allow_runs` by the person only, refused
  while the admin refuses, remove taking it away); `timer.test.ts` (zones and daylight saving end to end: 02:30 across
  spring-forward fires at 03:30 then 02:30 again with the offset in `fire.local`, 01:30 on the fall-back night once at
  the first, a schedule in Tokyo's zone; across a restart: a firing due while the run before it still goes is skipped
  and the replayed run recorded once, `missed: 'none'` records every missed firing and runs none late; the start gate:
  a refused start recorded with the hub's reason and told once per reason, the admins once when the owner is gone, and
  a start the hub couldn't answer tried again with the same key, one run); hub `policies.test.ts` (yielding),
  `approvals.test.ts` (a preview's choice on the card), `hub-fns.test.ts` (`fns_allow_runs` and its undo). The SDK's
  fake hub gains `onStartRun` (refuse a start as the hub's gate does). Already covered and not repeated: the summary
  rules and `tells` (`summary.test.ts`), no second "ran" after a reminder and a refusal told once (`timer.test.ts`),
  the inbox replacing an unread notice of the same key (`notifications.test.ts`), `hub/fns_save`'s undo stepping back
  a fn's versions newest first (`hub-fns.test.ts`) and a turn's undo undoing its runs newest first (`undo.test.ts`).
- **A bug the tests found**: a refused start whose owner was gone told the owner and the admins on every firing,
  since the admins' "told once" key shared the owner's field; it is its own (`ScheduleRow.adminsTold`).
- **The live run** is `scripts/schedule-live.ts` (port 4360, GPT-6 Luna, each flow once in its own chat, approvals
  answered with Approve alone; `--only=…` reruns some, `--seed` adds schedules by hand, `--fire-by-hand` a firing
  with no model, `--reuse` restarts on the same data, `--keep` leaves the stack up for the shots); the firing flow
  waits on the real clock (the test stack can't move the timer's clock). The shots are the `schedule-pages` ui-test
  (`ui-tests/shots/schedule-pages/`). Bugs it found, each fixed with a regression test:
  - Fixed `args` never arrived as an object: on a strict tool schema (OpenAI's) a free-form JSON arg is sent as a list
    of `{ key, value }` pairs, which `add` refused as "not an object" every time (the weekday and the firing flows
    failed; a reminder got through only by the model moving its text into `compute`). `fromPairs` reads such a list
    back as the object it spells, at any depth (`add`, `change`, the card).
  - Every timed firing was refused by the hub: the timer sent `at` as milliseconds, but the schedule fn's `at` is a
    gin timestamp, which travels as ISO text. It sends ISO text now, and `ScheduleRunArgs` (shared, one shape for the
    kind's run and the run page's header) reads both. And a run the hub ended inside the start itself (its settled
    event came before the firing knew its run) was never recorded or told: it is settled from the start's status.
  - A firing of a read target (a reminder) was never recorded: the schedule fn's mode is its target's, and the hub
    refuses a record saved in a `read` run. Firing records are saved by the system outside the run, naming the owner
    (one record, updated in order). A firing whose run told its person itself is recorded as `notified`.
  - The schedule system's process served no client build, so its pages ("schedule isn't installed") and result
    renderers never loaded on a stack; `main.ts` builds and serves it now (`scripts/system-bundles.test.ts` checks every
    system whose `system.json` names a client; claude and random don't yet, listed there).
  - The shots: calendar chips overflowed their day in the month view (border-box now); the admin list's columns
    didn't line up with its head (a fixed last column), and a one-off with no runs left said "Running" ("Ended"); a
    phone's week opened on Sunday instead of today; the run page's header said "Run by hand" for a planned firing.
  - Still open: each `add` the model got wrong waited on an approval card before failing (a card's preview can't read
    the target's signature, so it can't refuse wrong args first).

## Judgement calls (not asked)

- The calendar grid is the system's own component on dayspan's `Calendar`; dayspan-vuetify is Vue 2 and Vuetify, so
  it is a reference for behaviour, not a dependency.
- A schedule's zone is stored, not followed: a person who changes zone keeps their schedules' times where they were.
- `schedule/remind` is part of the system, so "remind me" has a real answer once it is installed.
- Firing records are pruned by the system (500 per schedule, 180 days); runs stay as the hub keeps them.
- The schedule fn's own args are `{ at?: Timestamp }`: a person or model calling it gets "run now"; only the timer
  passes `at`.
- The notification summary is worked out by rules from the result (text, table, object, the target's status line),
  never by a model: free, instant, and it can't say something the result doesn't. A schedule can't yet say in words
  what its notice should say ("tell me the total"); if wanted, that is a second program in the payload, written by the
  same authoring step.
- `notify` stays a per-schedule choice (always, failed, never), default always, with every firing still on the run
  page and in the history. Skipped and manual firings are never told; refusals are told once per reason; missed ones
  found together are one notice; a run that already notified (remind) gets no second "ran" notice.
- A new notice of a schedule replaces its unread earlier one (`key`), so frequent schedules don't flood the inbox.
- Non-admins had no page for a run outside a chat (Admin › Runs is admin-only), so the hub gains `/run/:run` for the
  run's own person. It is generic: hub MCP runs use it too.
- A notification gets one extra link (`also`) rather than a list, which is enough for "the run" and "the history".
- The schedule's shapes live in the system's `shared/`, not core, because the hub never reads them; the hub's
  additions are the only core changes.
- Page refs are `schedule.page.<segment>` (singular `page`), since the contract's `pages` is already the declared
  list.
- `runs.start` takes args as JSON checked by the hub, since a kind fn's args come from its kind's `describe`, not from
  a static declaration; the schedule kind's are always `{ at?: Timestamp }`.
- Following up on a scheduled result in a chat is not part of this design (there is no chat per schedule). If wanted
  later, the run page could gain an "Ask about this" button that starts a chat with the run attached.
- `partialOf` (all of an object's gin fields made optional) is a small `g` helper `ChangeArgs` needs; if gin already
  has one, that is used instead.

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
