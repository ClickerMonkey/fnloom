# Installing a system from chat

Status: plan (2026-11-10), not built. Owner's notes it answers: "A context brings the fns its work needs" and "A system
the chat writes is installed from the chat, not the console" (Decided, `docs/harness.md`; `build-5-feedback.md`).

Evidence comes from the owner's hub database (`.harness/hub.sqlite`, read from a copy): the `sessions`, `turns`,
`messages` (with `suggestions`), `runs`, `approvals` and `llmInteractions` (`request.tools`, `selection`) rows of the
session below. Times are the owner's (UTC-5).

## Owner decisions (2026-11-10)

> For system install: use tsx. Execute this bulk of work after the current workflow finishes

- **Runtime:** systems and the `harness` CLI run under tsx. The plain-Node import problem in aeye (`export * from './types'`) is not worked around, and not fixed in aeye for this. The CLI bin starts through tsx. fs's install supervisor starts the system with tsx: the source entry when developing, and the bundled self-contained JS for the scanned artifact.
- **When:** build 6, straight after build 5 finishes, together with whatever build 5 leaves open (its audit items included).

## What happened in the chat

Session `ses_gpf1m7rf7lhseyqcfqry` ("Can you make a "random" system…"), agent `hub/chat`, model
`openrouter nvidia/nemotron-3.5-super-vl:free`, contextor `plain`, chat mode `tools` (from `llmInteractions.selection`).
The system prompt is one line: "You are a helpful assistant inside harness. Use tools when they help…".

1. **09:34, "Can you make a "random" system that has a fn that produces a random number between two numbers."**
   (`trn_i2nttne7xifl22ypp540`, 14 model calls.)
   - Suggestions: context `web/guide`, `fs/authoring-fns`, `fs/authoring-calling`; fns `web/search`, `web/read`,
     `web/crawl`. `fs/system-authoring` and `fs/authoring-folder` were scored but left out as `top-n`. No fs fn was
     suggested.
   - Tools in every one of the 14 calls: the eight hub tools only (`hub__search_fns`, `hub__load_fns`,
     `hub__search_context`, `hub__load_context`, `hub__search_resources`, `hub__run_status`, `hub__run_wait`,
     `hub__ask_user`).
   - `hub/load_context` with `"fs/authoring-fns: Writing a harness system, part 6 of 29: Fns"` (the suggestion line
     copied whole) returned `{"loaded":[]}` with no reason, twice.
   - `hub/search_fns("create system function random number")` returned `fs/write` and `fs/restart`, both
     `available: true`. The model never loaded them.
   - `hub/load_context(["fs/system-authoring","fs/authoring-folder"])` loaded both. From call 3 on, the system prompt
     held them in full (6,319 tokens). The start item's text names the fns: "copy the folder with fs/bash … write the
     contract … with fs/write and fs/edit … run `npm run typecheck` … with fs/bash". It also says to load parts "with
     `hub/context_get`", which isn't a tool in the turn. `fs/system-authoring` declares `fns: [write, edit, bash, read]`
     (committed since build 3), yet the tool list stayed the same eight.
   - With no fs/read, it made 20 `hub/search_resources` calls to read example files through index snippets.
   - Answer: "I don't have direct file write access, so let me provide you with all the files you need to create",
     then the eleven files as code blocks.
2. **09:36, "You have bash and write don't you?"** Suggested fns now include `fs/bash` (0.97). The model's reasoning:
   "The suggested_fns mention `fn fs/bash` but that's not in my actual tool list … My actual tools are only the hub__
   functions." It made no call and said no.
3. **09:36, "The fs system provides that for you".** `fs/cd` was suggested. Reasoning: "These are suggested in the
   context but not actually available to me." It said no again.
4. **09:37, "Then load those fns"** (`trn_otee2n6o6eups3vxhkjp`).
   - `hub/load_fns(["fs/bash","fs/write","fs/cd"])` loaded all three; from the next call on, `fs__bash`, `fs__write`
     and `fs__cd` are tools.
   - Twelve `fs/write` runs and eight `fs/bash` runs followed, each approved by the owner (`approvals`: writes
     `remember: once`, then `session`; every bash `once`).
   - `mkdir -p C:\Users\…\systems\random\server …` through Git Bash lost its backslashes, so it made two junk folders
     at the repository root (`C:UserspdiffDocumentsGitHubharnesssystemsrandom{client,server}`). They are still
     there.
   - `npm run typecheck` passed, but `systems/random` isn't in the root `tsconfig.json` references, so nothing checked
     it (it still isn't). vitest caught the real errors: a missing `fn` import and `g.number` (gin has `g.num`).
   - "I don't have fs__edit", so it rewrote the whole file with write. edit was never loaded.
   - Answer: done, "install with `harness system build / pack / install`".
5. **09:46, "Okay let's install it"** (`trn_xariz7rwexynk8q2head`).
   - Suggested: `fs/authoring-packaging`, `fs/restart`, `fs/write` (`fs/bash` cut as `top-n`).
   - `load_context` with a "name: description" line again loaded nothing.
   - `fs/bash` `harness system build systems/random` failed: `ERR_MODULE_NOT_FOUND …\aits\packages\ai\dist\types`.
   - It then probed the CLI and wanted to add `systems/random` to the root workspaces. The owner declined a bash call
     and cancelled the turn.
6. **11:28, "I just need it in a state where I can import it - stay out of other projects".** No runs. It answered
   that the system was done and the CLI was broken.
7. **12:30, "Look into the dependency issue without running anything".** Ten `fs/bash` runs (`ls`, `cat`), and the
   turn failed at its 600 s budget.
8. **12:58, "How's it going?"** A status summary. It wrongly concluded that `aits` doesn't exist (it had listed the
   GitHub folder with `head -20`).

**Why the CLI failed:** `node_modules/.bin/harness` runs `@harness/cli/src/main.ts` on plain Node. aeye's
`aits/packages/ai/dist/index.js` has `export * from './types'` with no extension, and Node's ESM resolver refuses that.
The hub works because it runs under tsx. This is a library gap for the owner to decide (aeye's dist isn't loadable by
plain Node, or the CLI's bin should run under tsx); no workaround here. The system was never installed. The only way
offered was the console, and the console was broken.

The same pattern shows in the earlier session `ses_hz4tekxrgfp08r5joz0n`: "Call bash with that command" was needed
before it used `fs/bash`.

## Root causes

1. **Tied fns only work in the graph contextor.** `ContextDecl.fns` ("brings") is honoured by
   `GraphContextorImpl` (`hardClosure`, `contextor/contextors.ts`), by `links.ts` (a `brings` edge) and by MCP scopes.
   `PlainContextorImpl.select` (plain and suggest) shows only the asked, agent and session fns, so a loaded
   `fs/system-authoring` brought nothing. `hub/load_context` (`boot/hub-fns.ts`) adds to `session.context` and never
   to `session.tools`.
2. **The authoring parts bring nothing.** `authoringContext()` (`fs/shared/authoring.gen.ts`) gives the 29 parts a
   parent and a `next`, but no `fns`. At chat time `fs/guide` brought only read, edit, grep and glob. Build 5's work
   in progress widens `fs/guide` to nine fns, but only the graph contextor will use that.
3. **The text names fns without saying they are callable.** The start item tells the model to use `fs/bash`,
   `fs/write` and `fs/edit` and to load parts with `hub/context_get`, none of which were tools. The model compared
   those names with its tool list and decided it had no file access. Other gaps:
   - The `<suggested_fns>` block gives no instruction. The graph's `<more_fns>` block says "Load any of these with
     hub/load_fns".
   - The system prompt says nothing about loading.
   - The `hub/load_fns` description was "Add fns to your toolset for this session." (build 5 adds instructions to
     `search_fns`).
4. **`load_context` fails silently.** Unknown names are dropped with no `refused` list, unlike `load_fns`. Suggestion
   lines read `context <name>: <description>`, and the model passed the whole line as the name.
5. **Suggestions don't follow `brings`.** A suggested context doesn't pull up its fns. fs fns lost to web fns on score
   and were cut as `top-n` (turns 5 and 6).
6. **Installing needs the console.** The authoring text and `fs/authoring-packaging` point at
   `harness system build/pack/install`. The hub's own install (`link/supervisor.ts`, `link/packages.ts`) has no fn
   the chat can call, and the CLI didn't run. A weak model made all of this worse, but the design shouldn't depend on
   the model working around missing tools.
7. **Checks can lie.** The root typecheck doesn't cover a new system folder, so "typecheck passes" meant nothing.
   Installing must typecheck the folder itself.

## Part 1: context brings its fns (what's missing)

What exists: `ContextOptions.fns` / `ContextDecl.fns` (build 3, with a tied-fns picker in the context editor),
`suggestFns`, `brings` and `suggests` link edges, the graph's hard closure, and MCP scopes that warn about hidden brought
fns. Build 5 widens the `fs/guide` declaration and adds instructions to `hub/search_fns`.

Missing, all in one place: **the hub resolves a context's tied fns wherever the context is shown or loaded.**

- **Plain and suggest contextors:** for each chosen context, add its `decl.fns` (and those of the context it imports)
  to the turn's fns at `signature`, after the asked fns and before the session's. The usual checks apply: session
  systems, `usable`, chat mode, budget order. A cut brought fn is reported like any other. Write one helper,
  `broughtFns(records)`, and use it in all three contextors (graph keeps `hardClosure`, which can call it).
- **`hub/load_context`** also loads the tied fns it may use into `session.tools`. It returns
  `{ loaded, fns, refused: [{ context, reason }] }`. An unknown name is refused with the closest names (also accept
  `name: description` by taking the text before `:`). Unloading a context leaves fns the person loaded themselves.
- **Rendering:** `contextBlock` ends each context that brings fns with a line the hub generates, so the text always
  names them correctly: `Fns for this, already in your tools: fs/write (fs__write), fs/edit (fs__edit), …`. In static
  mode the line reads "run with `run`". If a fn was cut or isn't allowed, the line says so ("fs/bash: not allowed in
  read mode") so the model doesn't guess.
- **Suggestions:** a suggested context suggests its brought fns at the context's score (marked
  `reason: 'brought'` in `suggestions`), and its line reads `context fs/system-authoring (brings fs/write, fs/edit,
  fs/bash, fs/read): …`. The `<suggested_fns>` block starts with "Load any of these with hub/load_fns to use them."
- **Base prompt:** one sentence in `hub/chat`'s instructions: "Fns named in suggestions or search results can be
  loaded with hub/load_fns; context you load brings the fns it names."
- **fs declarations and text:**
  - `authoringContext(parent, fns)` gives every non-reference part the start item's fns.
  - The start item's text (generated in `fs/server/authoring.ts`) says "This brings fs/read, fs/write, fs/edit and
    fs/bash", replaces `hub/context_get` with `hub/load_context`, says fs/write makes parent folders (no `mkdir`) and
    that paths in bash use forward slashes, and ends with the new install step (below).
  - `fs/authoring-packaging` brings `fs/install_system` and describes it before the CLI.
- **Test:** a replay of turn 1 against the plain contextor. With `fs/system-authoring` loaded, the next model call's
  tools include `fs__write`, `fs__edit`, `fs__bash` and `fs__read`, and the system prompt has the generated fns line.

## Part 2: installing from the chat

### Options

| | A. Start with bash, pair by card | B. Pack and install on the hub | C. fs hosts it, hub grants pairing (recommended) |
|---|---|---|---|
| How | Model runs `node server/main.ts` with `fs/bash`. The waiting pairing shows as a chat card | fs builds and packs a zip, uploads it, calls `hub/install_package` with approval. The hub supervisor runs it | `fs/install_system` builds and scans on fs's machine. The admin approves a card that shows exactly what will run. The hub grants a one-time pairing bound to that build. fs starts and supervises the process |
| Runs where | fs's machine, as a child of a bash run | the hub's machine | fs's machine, where the code is |
| What is approved | a pairing code, not code | a zip hash | the bundle hash and contract digest, checked again at hello |
| Supervision and restart | none (dies with the run) | the hub's (backoff, rollback) | the same policy, shared code |
| Feedback to the model | bash output only | upload and install errors | build, type and scan errors before the card; crash output after |
| Reuse | pairing, QR | `packages.ts`, `supervisor.ts`, zip checks | build (from the CLI), supervision (from the hub), approvals and preview (build 5), pairing tokens |
| Size | small | medium | medium-large |

A is rejected. Nothing ties what runs to what the admin approved, the process isn't supervised, and in chat the code
check is meaningless (the model would relay the code). B is a good later path for promoting a finished system into
the hub's installed set. But it moves the system off the machine it was written on, and every edit becomes an upgrade.
C fits the owner's idea and keeps one approval point.

### Recommended design (C)

**Flow:**

1. The model writes the folder with fs fns (brought by the authoring context), then calls
   `fs/install_system({ path })`.
2. The hub sees `approval: { preview: true }` and asks fs for a preview. fs:
   - reads `system.json`
   - typechecks the folder with its own `tsconfig.json`
   - bundles a self-contained `dist/` (the CLI's builder, shared)
   - checks that the contract name equals `system.json`'s name
   - scans the bundle
   - works out the contract summary and its diff from the version running now.

   A failed build answers `refused` with the diagnostics, so the run is `invalid-input`. The model sees
   `file:line:col message` lines (up to about 40, then "and N more") and fixes them, with no approval asked.
3. A good build becomes the approval card. Approvers are admins: the person if they are one, otherwise every admin
   (notified), with the card in their chat. Chat mode must be `write` or higher. `auto` never decides an `approval`
   fn. Declining settles the run as "declined by <name>: <reason>".
4. Approved, the run starts on fs.
   - fs hashes the folder again. A change since the preview is `invalid-input` ("the folder changed after approval;
     call again").
   - fs calls `HubLink.grantPairing` with its run and the approved digest. The hub checks that the run is this
     approved run and that the digest matches the stored preview's `subject`, then returns a one-time token (60 s)
     bound to the system, instance, manifest hash and host.
   - A system this fs already hosts gets no token: it restarts with its key from its state folder, and the hub imports
     the changed manifest at hello.
5. fs starts `node dist/server/main.js` under the shared supervisor, with its own folders and a scrubbed environment
   (below), and waits up to `FS_HOSTED_CONNECT_TIMEOUT` (30 s) for the hub to report it connected.
6. The result: `{ system, instance, version, status: 'connected' | 'needs-config', fns, configType? }` as a card linking
   the system's page. If the system needs config, the model can ask for it in chat as it does today.
   - An exit before connecting is `invalid-input` with the exit code and the last 4 KB of output, so the model fixes
     the crash.
   - An fs or hub problem (grant refused, hub unreachable) is `failed`.

**Fns (fs contract):**

- **`install_system({ path, instance?, replace? })`**
  - Mode `write`, tags `admin`, `approval: { preview: true, remember: false, approver: 'admins' }`.
  - Instructions: "After writing or changing a system folder: builds, checks and starts it on this machine and connects
    it to the hub. Call it again after each change; it restarts the system with the new code."
  - `replace: true` is needed when the name is already paired somewhere else. The card then says what it replaces.
  - Reserved names (`hub`, and any name of a system already connected and not hosted here, unless `replace`) are
    refused as invalid input.
- **`system_status({ system? })`** (read): hosted systems with status, version, pid, restarts in the last hour and the
  output tail, so the model can read a crash after the fact.
- **`restart_system({ system, reason })`** (write, normal policy): restarts the approved bundle as it is. No new code,
  so no admin card.
- **`stop_system({ system, remove? })`** (write; `remove` asks): stops it, and `remove` deletes its hosted folders.

Install, status, restart and stop are visible to the model and the hub. The hub's admin Systems page calls restart and
stop for a hosted instance.

**Contracts (core):**

- `FnApproval.approver?: 'person' | 'admins'` (default `person`). With `admins`, only an admin's decision counts.
- `ApprovalPreview.subject?: { kind: 'system-install'; system; instance; version; manifestHash; bundleHash; sourceHash;
  host: { system, instance }; replaces? }`. The hub reads it for the grant. The parts are only for display.
- Run ctx: `ctx.approved?: { by: ActorId; preview: ApprovalPreview }`, so fs checks it is running what was approved.
- `HubLink.grantPairing({ run, subject }) → { token, expiresAt }`. It is refused unless `run` is a running, approved run
  of a fn with `approval.approver = 'admins'` on the calling system and instance, with an equal `subject`.
- `pairingTokens` gains `boundTo: { manifestHash, host }`. `pairing.ts` accepts such a token only from a hello with
  that name, instance and manifest hash, and grants auto pair.
- `InstalledInfo.host?: { system, instance; path; bundleHash; approval }` on the instance record, so the hub knows who
  runs it.

**The approval card** uses the existing `ApprovalPreview` view, in this order:

- title: "Install random 0.1.0 on fs/main", or "Update random 0.1.0 → 0.2.0".
- text: what it adds (fns with mode and tags, kinds, hooks, mentions, providers, config type, client renderers).
- the diff from the running version: fns added or removed, modes widened.
- the scan report.
- the source folder and bundle hash.
- `code` parts for the scan's lines of concern.

**Security:**

- **Who:** only admins approve. The fn is tagged `admin`, so hub MCPs never expose it. A member's call becomes a
  proposal to the admins.
- **What runs:** exactly the approved bundle, one self-contained file (build 5). `server.external` is refused unless
  it is a native addon with `binding.gyp`, and those are listed on the card.
- **Scan:** a report, not a guarantee. It lists:
  - Node built-ins imported (`child_process`, `net`, `http(s)`, `dgram`, `worker_threads`, `vm`, `fs`)
  - non-literal `require` or `import()`
  - `eval` and `new Function`
  - literal URLs and hosts
  - bundle size.

  Optionally, later: a `review` model role summarises the risky parts in three lines.
- **Binding:** the token is one-time, short-lived, and bound to the name, instance and manifest hash. The process that
  connects must declare the approved contract, or pairing fails.
- **Sandbox:**
  - The process gets only `PATH`, the OS basics (`SystemRoot`, `TEMP`) and the SDK tunables by name (`SHARED_ENV`, never a `HARNESS_` prefix, so no hub secret reaches it). It never gets fs's
    environment or its keys. Today the hub's `NodeLauncher` passes the hub's whole environment, and the shared
    launcher should take an allowlist too.
  - cwd is its data folder.
  - It runs with Node's permission model (stable since Node 22.13; the stack runs 22.22): read access to its bundle
    and folders, write access to its folders, and no child processes or workers unless `system.json`'s new
    `permissions` declares them, which the card shows. The SDK's own needs under `--permission` must be checked first.
  - Network isn't limited by Node. The card shows the network use the scan found. An OS sandbox or container is
    later work.
- **Where:** on the fs instance's machine, under `ctx.dataDir/hosted/<system>/<instance>/{state,data,cache}`, with
  bundles in `hosted/<system>/versions/<bundleHash>/`. These are the same folders the hub's supervisor uses, so a
  later "promote to hub-installed" (option B) can move them.
- **Audit:** the approval record, `system.installed` hub log entries, and the run.

**Restart on code change:** this is explicit. Calling `install_system` again rebuilds and shows a card with the diff.
`restart_system` restarts the same bundle with no card. No file watching, since every code change needs an admin's
look. fs's `stopping` lifecycle stops its hosted systems. At start, fs kills any stale pid it recorded and starts the
ones marked to start. Crashes follow the shared policy (backoff doubling, a cap per hour, then disabled with a hub
notification to admins).

**What changes where:**

| Module | Change |
|---|---|
| `packages/cli` → new `packages/build` (`@harness/build`) | builder, folder checks, pack and the new scan move here. The CLI and fs both use it. A packed fs without it refuses installs with "this fs can't build systems", or takes a prebuilt `dist/` and still scans it |
| `packages/sdk/server` | `supervise.ts`: launcher with an env allowlist and permission flags, plus crash and backoff policy, taken out of `hub/link/supervisor.ts` and `process.ts`. The hub supervisor uses it too. `ctx.approved` |
| `packages/core` | `FnApproval.approver`, `ApprovalPreview.subject`, `grantPairing`, `pairingTokens.boundTo`, `InstalledInfo.host`, `SystemPackageManifest.permissions`, `LoadContextResult.fns/refused` |
| `packages/hub/execution` | admin approvers and notifying them; `ctx.approved` on the run; `auto` skips approval fns |
| `packages/hub/link` | `grantPairing`; bound tokens in `pairing.ts`; instance `host`; admin start/stop/restart for hosted instances go to the host's fns |
| `packages/hub/contextor`, `boot/hub-fns.ts`, `chat/enrich.ts`, `chat/suggestions.ts` | Part 1 |
| `systems/fs` | the four fns, the hosted folders, start and stop with fs, context text and fns (Part 1) |
| `packages/web` | install result renderer; Systems page shows "hosted by fs/main at systems/random" with restart and stop; the approval card shows the subject's hashes |
| docs | `harness.md` ("Installing from chat" under Systems), AUTHORING packaging prose (regenerate), this plan |

The CLI later gets `harness system install --host fs/main <dir>` over the same hub path.

## Task list (one build, in order)

1. **Part 1, hub:** `broughtFns` in plain, suggest and graph; `load_context` loads fns and refuses unknown names with
   suggestions; generated fns line in `contextBlock`; suggestions bring fns; `<suggested_fns>` instruction; base prompt
   sentence. Replay test of turn 1.
2. **Part 1, fs:** authoring parts inherit the start item's fns; start text fixed (`hub/load_context`, no mkdir,
   forward slashes, install step); `npm run docs:authoring`.
3. **`@harness/build`:** move the builder and checks out of `packages/cli`, add the scan, keep the CLI commands green.
   Report the CLI's plain-Node loading failure on aeye's dist as a library gap; don't work around it.
4. **Shared supervision** in `sdk/server`: env allowlist, permission flags, backoff policy. The hub supervisor uses it,
   with no change in behaviour.
5. **Core contracts:** `approver`, `subject`, `grantPairing`, `boundTo`, `host`, `permissions`, `ctx.approved`.
6. **Hub:** admin approvers, `ctx.approved`, `grantPairing`, bound tokens in pairing, instance `host`, admin ops for
   hosted instances.
7. **fs:** `install_system` (preview and run), `system_status`, `restart_system`, `stop_system`; hosted folders;
   lifecycle start and stop.
8. **Web:** install result card, approval card subject, Systems page host and buttons.
9. **End-to-end chat scenario:** write `random`, install with a type error (the model gets the diagnostics), fix,
   approve, call `random/random`, change it, approve the update, restart, stop. Plus a member's request reaching an
   admin, and a changed folder after approval refused.
10. **Docs:** `harness.md` Systems section and Decided entry, the packaging part of the guide.

Left for the owner (not done here):

- the junk folders at the repository root from turn 4
- `systems/random` missing from the root `tsconfig.json` references
- whether `random` should stay in the repository at all.
