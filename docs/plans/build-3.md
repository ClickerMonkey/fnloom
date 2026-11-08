# Build 3

Build 3 of 7. The owner wants it done efficiently: in tokens and in time. This build is mostly UI and UX density,
plus a few hub features behind them.

## The request, verbatim

> Let's fix that in ayepi and update the code here as well. [the ayepi client auth-refresh hook, see Carry-overs]
>
> Build 3
> - Show exact cost instead of <$0.01
> - Move the suggested context/fns in chat below user message into icons only if there were any and maybe a count indicator. Keep track of what fns/context we're not used because of low score or decision model (keep reason)
> - stop/pause/resume in chat should let me select which fns or all
> - Admin option to take last few user messages and suggested fns and context and send through decision model to decide what should be suggested instead of just relying on score threshold
> - Expression editor/viewer should be visually organized more like code and be a bit denser and hide some things like documentation behind an icon you can hover over or in edit specify. The goal is for when people first look at it they can easily understand what the expr is if they are familiar with the basics of code. I see too many newlines and filler text and opportunities to put things on the same line to read more like code and only wrap if it would look nicer.
> - Make model calls more dense (in admin, uses three lines of text in one row)
> - global Fns catalogue and Fn page (should be done already, see stats and runs)
> - ( Bash {} ) pill in chat UI seems odd. Overall think about whitespace and how many little elements take up a whole horizontal space that's mostly empty. That's a good opportunity to rearrange things so you can fit more things on screen.
> - Resource explorer search inputs and empty space. Set visual standard for screens with search inputs. Search text filters pill thing like jira - there should be a component reused which is a text input that does plain matching but it can match a filterable value and the user can select it and it can add a pill like "Status: Running" or something. Also handle numbers and gt, lt, etc. in, not, empty, etc. there's a filter icon in the input box that you can click and it's a drop-down of all filterable things and you can click into each one of those to add a filter pill for that particular thing. Outside that component is a sort button for you to control how it's sorted and there's always a display for how it's sorted so you know. Sorting and filtering are done server side and should have consistent experience - should be a fn that the llm can also call...
> - Duplicate info in chat/fn UI... For the bash fn it display the command it ran like 3 times in the UI. Only once unless it was abbreviated in another spot. That's an example, look for similar instances of wasted space because of duplicate info.
> - during pairing hub user could decide to auto pair which hands system a secret unique to it and it can have an expiration so whenever something comes up again there would be a cached value stored with the system wherever it is that it can use - if this sort of functionality is not present yet. I want things to be secure.
> - the resource to context icon on mobile didn't know what it did - maybe have confirmation?
> - change remember on context page to just Context. If tying fns to context is supported or when it is then add inputs on that screen for that. Add a collapsed advanced section on that modal for that and all other context options

## Decided (by me, from the request; the owner can overrule)

- **Exact cost:** show the real figure with enough significant digits (e.g. `$0.00042`), everywhere a cost shows. One formatter.
- **Suggestions:** below a user message, a compact row of icons (context, fns) with a count badge, only when there were any.
  Opening it shows what was used and also what was **not** used, each with its reason (score under the threshold, the
  decision model declined it, token budget, rule). The hub records the not-used ones with their reason on the turn.
- **Stop / pause / resume:** one control that applies to all running fns of the turn by default, and lets you pick
  individual running fns. Hub support for pausing and resuming single runs where a kind supports it; stop always works.
- **Decision model for suggestions:** an admin setting (off by default): a model, how many recent user messages to
  include (default 3), and a cap. When on, the candidate fns and context (above a low floor score) and those messages go
  to that model, which picks what to suggest; its picks and refusals (with reasons) are recorded as above.
- **Query standard:** one shared filter and sort model in `@harness/core` (zod): fields with types (text, enum, number,
  date, boolean), operators (`is`, `is not`, `in`, `not in`, `>`, `>=`, `<`, `<=`, `between`, `empty`, `not empty`,
  `contains`), free text, sort keys with direction, paging. Each list (resources, fns, runs, model calls, sessions,
  systems, context, inbox where it applies) declares its fields once; the hub filters and sorts server side; the same
  query is a hub fn the chat LLM can call (`query` per list, or one `query` fn taking the list name).
  One web component: a search box with pills (`Status: Running`, `Cost > 0.01`), typing suggests matching field values,
  a filter icon inside the box opens a menu of all fields, each leading to its operator and value. A sort button beside
  it, and the current sort always shown. Every screen with search uses it, with one layout standard (no wasted space).
- **Expression editor and viewer:** reads like code: one line per statement where it fits, wrap only when it reads
  better, dense, monospace where it is code. Docs and descriptions move behind an info icon (hover/tap); in edit mode the
  icon edits them.
- **Density pass:** model calls table (three lines of text per row at most, in one row), the fn pill in chat
  (`( Bash {} )`), whitespace and half-empty rows across chat and admin, and duplicated info (the bash command shown
  three times; show it once unless another spot abbreviates it). Look for every similar case.
- **Fns catalogue and fn page:** check they exist and work (stats and runs); finish what's missing, with the query
  standard.
- **Auto pair:** check what pairing does now. If missing: at pairing, the admin can choose "auto pair". The hub gives
  the system a secret unique to that instance with an expiry (admin picks, a default of 90 days, or never). The system
  stores it in its state dir and uses it to re-pair without a new token after its key is lost or the hub forgot it,
  until it expires or is revoked. Secrets are stored hashed on the hub, can be listed and revoked by the admin, and
  rotate on use. Security first: no secret in logs, constant-time compare, rate limited.
- **Resource → context on mobile:** a clear label or tooltip, and a confirmation before it acts.
- **Context page:** rename "Remember" to "Context". The add/edit modal gets a collapsed **Advanced** section with
  every other context option, including the fns tied to the context if that's supported (add support if it's small).

## Carry-overs

- **ayepi client auth hook** (the owner asked): `client({ unauthorized: () => Promise<boolean> })`: on a 401 to a call
  made with credentials, await the hook once (shared by calls refused at the same moment), and on `true` retry the call
  once over its transport. A call that already streamed items up is not retried. `wsTransport` gets a `reconnect()` that
  drops the socket and reopens it at once (the URL function is read again). Tests in ayepi; docs in the package's md.
  Then harness `packages/web/src/api/client.ts` drops its frame-sniffing `watchRefusals`/`isRefusedFrame` wrapper and
  passes the hook; after a refresh the web app reconnects the socket. Keep the hub's close-at-once for expired tokens.
- **fs secrets:** the fs system indexes `.env`, keys and similar as resources. Exclude by default (`.env*` except
  `.env.example`, `*.pem`, `*.key`, `id_*`, `*.pfx`, `*.p12`, `.npmrc`, credentials files), configurable.
- **Screenshot gallery** (approved): a script that rebuilds the full ui-tests shot set into a staging folder and swaps it
  in only when complete, records per feature the commit and time, and writes an index page that flags shots older than
  the code of their feature. Not run in full in this build (expensive); only the changed screens.
- Library asks dropped: binary ws frames (not needed: no bytes ride the link).

## Rules for this build

- Lean. Browser tests only for what needs rendering; screenshots only of screens this build changed, at phone
  (390x844) and desktop (1440x900).
- One review round, a second only if the first finds critical or major problems.
