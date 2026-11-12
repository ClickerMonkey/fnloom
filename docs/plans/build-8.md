# Build 8

It starts only after build 7 is done and I've checked these four things against what the owner described:
- the harness itself
- the UX
- the code is written the way the owner expects
- the fs documentation, which must be solid: the context folder graph for authoring systems

The check is an audit against the Decided section, the build specs and the feedback files. Whatever it finds is fixed
first, or put on this list.

## The request, verbatim (2026-11-11)

> Build 8
> - widget system
> - data system
> - after bash collect which files were modified and for text based ones have tabs of diffs
> - maybe fs watched for file system changes where you start it and any that can reliably be tied to a bash call should be and display a tabbed view of the changes assuming they are in git
> - make sure fs system has safe guards against git ignored and sensitive looking files - maybe auto mode classifier does that

## Added by the owner (2026-11-12)

> Let's make it configurable so that you can feed in a custom harness name (right now it's just Harness) and have that be used visually everywhere in the app. Let's do next build

- **One setting:** the hub's display name is configurable. Today it is the fixed `name: 'Harness'` in
  packages/hub/src/boot/info.ts. The design step picks where it is set: an env var, an admin setting stored by the
  hub, or both, with the stored setting winning.
- **Used everywhere it shows:** the app brand (AppBrand), the sign-in and setup page, the browser tab title, the PWA
  manifest and install name, the version line, notification titles, and any user-visible text that says "Harness".
  Code names (packages, the `harness` CLI, env var prefixes, storage keys) stay as they are.
- **Live:** a change shows in open tabs without a rebuild of the web app.
- **Check:** a test that sets a custom name and finds it on the sign-in page, in the shell and in the tab title, and
  finds no "Harness" anywhere it would be shown to a person.

Also from the owner the same day, already done on top of build 7 (`9b49d1b`): the sign-in page has "Remember me"
(stays signed in and keeps the email; unticked, the session ends with the browser), a show/hide button on the password,
and the field names password managers need.

## Prior art to read

In product (`C:\Users\pdiff\Documents\GitHub\product\design`):
- widget-kind.md
- widget-actions.md
- widget-controls.md
- widget-authoring-fn.md
- widget-writes-and-routing.md
- query-visuals.md, which the widget system builds on, together with the visual registry from build 5

Take the intent, not the code. Product has no doc named for a "data system": the design step defines it with the
owner's notes, starting from product's data surfaces (`packages/app/src/next/surfaces/data`).

## Notes for the design step (my reading; the owner can overrule)

- **Changes made by bash:**
  - fs records which files each bash call changed.
  - Inside git, it uses `git status` and diffs taken before and after the call. Outside git, it uses a file watcher
    started with the call.
  - Changes that can be tied to the call reliably (the watcher saw them during the call, in the call's working tree)
    are attached to the run.
  - The run view shows a tab per changed text file, with its diff. Binary and large files are listed but not diffed.
- **Safeguards:** fs refuses or asks before reading or writing:
  - gitignored files
  - files that look sensitive: `.env*`, keys, credentials, tokens, and secrets found by content patterns
  - In `auto` chat mode the classifier model sees these flags. Writes to them always need approval.

  The rules come from one list, are configurable per fs instance, and are tested.

## From the audit gate (2026-11-12)

Findings left for build 8 or the owner:

- **[major, harness] Hub and system API not grouped or indexed** (packages/hub, hub fns and context; build-6-design.md
  Status 'Not finished' item 1): Build 6 and Decided 'Context folders' ask for an API that is grouped, indexed and
  searchable, with an index context item per group. Only the fs authoring guide is grouped; the hub's and systems' fn
  API has no group index items. Not on the build 8 list yet.
- **[major, harness] Version history only for fns and types** (packages/hub/src/store/schema.ts:86, catalog.ts:484):
  Decided says every runtime-added item keeps its version history. Context, kinds, commands, components, examples and
  providers keep none. Fix: a uniform versions table (or one per kind) that RunningSystem.patch writes to.
- **[major, code] Whole shared tables cached in process memory** (packages/hub/src/access/service.ts:136-138;
  catalog.ts:766-772, 362, 390, 601): AccessService and Catalog load whole tables into memory for the process life,
  and #referencing, kind-fn listing and work.others run allRows('fns') then filter in JS. Stale with a second hub
  process or a direct store write. Fix: query by key or filter in the store.
- **[major, fsdocs] The worked example teaches a local store, load-all and in-memory search**
  (scripts/docs/example/server/impl.ts:28-33, 121-127; start.md): notes live in a file store under ctx.dataDir and find
  loads all and substring-filters. Fix: rebuild on hub types, records and hub search; add a 'where data lives' rule to
  start.md and mistakes.md.
- **[minor, fsdocs] Very large parts weaken progressive disclosure** (parts/core-types.md 104 KB, examples.md 77 KB,
  hub.md, testing.reference.md, internals.md): one lookup costs 20-26k tokens. Fix: split core-types by source module
  and examples per file, each with a choices list.

Deferred by the fixers:

- **Catalog load-all** (packages/hub/src/catalog/catalog.ts): #redescribeKindsOf, #referencing and #others need fns
  by kind and by signature types; no indexed table holds that (fnTypes holds fact types, not signature mentions). Fix:
  a new (fn, kind, type) index table written in the fn's transaction, also replacing #describedTypes. #load keeps
  types and manifests in memory because gin's TypeLookup is synchronous. A few hours and a design change.
- **Resource browse is still load-all** (packages/hub resources): facets and substring search need store group-by
  counts, prefix filter or LIKE, plus family/source columns with a migration and date/folder buckets.
- **Notice not shown on approval and running cards** (packages/web): the hub already sends FnFacts.notice via the
  facts endpoint and on the model's fn line.
- **System fns changing the hub without declaring it**: wrong on inspection, no change (runs.ts #checkDep; deps'
  declared effects count as the caller's).
- **Ollama context sizes** (packages/hub, OLLAMA_CTX, OLLAMA_LEGACY_CTX): left; they are Ollama's own defaults and
  HARNESS_OLLAMA_DEFAULT_CTX is the setting.
- **Owner call: METRIC_DEFAULTS** (6 metrics x 3 numbers): overridable per contextor today; moving it into env (18
  settings or one JSON setting) is the owner's call.
- **Deliveries BATCH (50)** (packages/hub/src/chat/deliveries.ts): kept; a per-pass page size, not a cap.
- **Old `{ input: ... }` wording** (docs/reference/hub-surface.md lines 264, 275, 283, 292, 606): configure_provider,
  remove_rule, set_model_role and resource_import take plain args now.
- **Owner call: esbuild devDependency** (package.json): `npm run live` imports esbuild, present only through Vite.
  Run `npm i -D esbuild` once to add it and update the lockfile.
- **Second paging helper** (packages/hub/src/api/paging.ts): its own `collect` and `first` (PAGE 100) could move into
  store/rows.ts.
- **Old helper files deleted** (packages/hub/src/catalog/rows.ts, packages/hub/src/execution/pages.ts): removed with
  `git rm`; committed in the audit gate commit.
- **Owner call: @-mention 'recent pages' kept in memory** (systems/web/server/mentions.ts): needs a hub link endpoint
  that searches resources as the person mentioning (ctx.resources.search is a declared gap). The owner decides how the
  hub trusts which person a system answers for (for example, tied to the mention request the hub sent). Then
  RecentPages and WEB_RECENT_PAGES can go.
- **No test for the rename retry** (EPERM/EBUSY/EACCES): it would need a fake file system or a held Windows handle.
  The temp-name and one-at-a-time writes are tested.
- **Inbox 'needs config' notices on a fresh hub** (packages/hub/src/chat/notifications.ts #system): hold the
  'config-needed' notice for a short grace period from an @ayepi/env slice, and drop it if the system connects first.
- **Graph overlap on a real stack** (packages/web graph view): only checked against the mock's sample graph. The real
  fs cluster (many authoring.* items) still needs a look; fit-all on first load hides labels until zoom-in.
- **Duplicate 'New chat' button** (packages/web chat list): on desktop it shows beside the panel's own 'New chat'.

## Owner answers to the audit's calls (2026-11-12, verbatim)

> 1. Move into settings
> 2. Yes
> 3. Do suggested
>
> Do next build

- **METRIC_DEFAULTS:** move the 6 metrics x 3 numbers into @ayepi/env settings (per-contextor overrides stay).
- **esbuild:** added as a root devDependency before build 8 starts.
- **@-mention recent pages:** a new hub link endpoint searches resources as the person mentioning; the hub ties the
  search to the mention request it sent the system, so a system can only search for the person it was asked about.
  Then systems/web drops RecentPages and WEB_RECENT_PAGES.
