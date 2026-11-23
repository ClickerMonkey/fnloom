A system that owns a kind can run its people's fns of that kind later by itself, outside any chat, and tell those
people how each run went. It declares the `runs` hub grant (`grants: { hub: ['runs', …] }`); the review page flags it
("Starts runs on its own, as the owners of its fns, and notifies them"), and nothing of it works before an admin goes
live with it.

### Listing, starting and telling: `ctx.runs`

`ctx.runs` is in every system context (events, lifecycle, hooks, timers), never in a run's. Each method takes only
refs of the system's own: `SystemImpl` types the context with the contract's kinds and pages (`OwnOf`), so another
system's kind, fn or page doesn't compile.

- `kindFns(contract.kinds.plan, { changedSince?, cursor? })`: the saved fns of the kind, a page at a time, each a
  `KindFn` with its `owner`, `title`, `version` (from 1) and `payload` parsed by the kind's payload type. With
  `changedSince` it gives only those saved since (and those removed since, `removed: true`). Only `kindFns` makes a
  `KindFn`, so a fn built by hand can't be started.
- `start(fn, { args, key, priority?, maxSpend? })`: a run of the fn as its owner, in a turn of theirs with no chat, at
  `background` priority by default and with its budget lowered to `maxSpend`. The system is its caller, so the owner's
  policies, approvals and budgets apply as at any call. `key` is required: the same key is the same run, so a retried
  or doubled start never runs twice. The hub refuses (with the reason) when the owner can no longer use the hub, the
  system isn't live, or the fn isn't of one of its kinds.
- `notify(fn, notice)`: an inbox item and a push to the fn's owner, and no one else.

### Notices

A `Notice` has a `title`, a `body` (clamped to `NOTIFICATION_BODY`, 160 characters, on a word boundary), a `tone`
(`ok`, `failed`, `info`: the inbox icon), a `link` and a second link with a label (`also`, a button in the inbox and an
action on the push). A link leads to a run of the person's (`{ run }`) or to one of the system's own pages by its ref
(`{ page: contract.page.item, path: ['weekly'], query: { tab: 'history' } }`), never a segment string. A `key` makes a
later notice of the same key replace the earlier one while it is still unread (and tags the push), so a fn that runs
often leaves one item, not forty.

Inside a run, `ctx.notify(notice)` tells the person the run is for, linking to the run when it names no link. The
settled `run` event then says `notified: true` for that run and every run above it, so a system that tells people how
its runs went doesn't tell them twice.

### Removing a saved fn

`hub/fns_remove({ fn })` removes a saved fn of one of the calling system's kinds, for its owner or an admin (declare it
as a dep, list it in `grants.calls`, and declare the `fns` `remove` effect for the kind). The hub keeps its versions;
undoing the run saves its last version again.
