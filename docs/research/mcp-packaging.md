# Hub MCPs, system packages, QR pairing and system fleets

Research note for build 2 ([plans/build-2.md](../plans/build-2.md)). It covers four of the owner's asks that all touch
the same records (systems, pairing, installed systems, actors) and so are designed together:

1. **Hub MCPs**: admin-made MCP endpoints served by the hub, each with its own route, secret and include/exclude rules.
2. **System packages**: the standard system folder, the hub-provided data folder, config in the hub DB, the
   `harness system new|build|pack|install|export-data` CLI and zip install.
3. **QR pairing**: a system started with a hub URL prints a QR code that opens the hub's pairing page, where the admin
   fills in config and finishes pairing.
4. **Fleets**: many instances of one system (several fs machines) attached at once.

Read against: product's `design/claude-code-system.md` §11 (the product as an MCP server for Claude sessions),
`design/mcp-system.md` (the product as an MCP client), `design/system-packages.md` (the `.syspkg` zip), harness's
SDK MCP face (`packages/sdk/src/server/mcp*.ts`), pairing (`packages/hub/src/link/pairing.ts`), installed systems
(`link/supervisor.ts`, `link/process.ts`, `core/src/records/systems.ts`), and `@ayepi/mcp` (`ayepi-mcp.md` and
source on the `harness` branch). Everything here is a proposal for the Design phase unless marked **(today)**.

---

## 0. What exists today

| Piece | Today | File |
|---|---|---|
| A system as an MCP server | `McpFace` serves one system's native, LLM-visible fns as tools, its resources as MCP resources and its `/commands` as prompts, over stdio or Streamable HTTP. Calls run **locally** in the system, not through the hub's queue, policies or ledger. | `sdk/src/server/mcp.ts` |
| `@ayepi/mcp` | Server and client, no external SDK. `McpToolSource` / `McpResourceSource` / `McpPromptSource`, `mcpSourceServer`, `mcpHttp` (a web `fetch` handler: sessions, SSE, `allowedOrigins`, `maxBody`), `serveStdio`, `McpClient`. `McpTool` is `{ name, title?, description, inputSchema, outputSchema? }`: **no `annotations`, no `_meta`**. No server-sent `notifications/progress`. No auth: transport auth is the caller's job. | `ayepi/packages/mcp` |
| Pairing | Code (system logs `system.pairing { code, url }`, admin approves at `/admin/systems?pairing=…`) or a one-time token. Installed systems are paired at install with a hub-made key. | `hub/src/link/pairing.ts` |
| Installed systems | `<systems>/<name>/versions/<version>` and `<systems>/<name>/state`; sources are a folder, an npm package or a git repo; `package.json` `harness: { name, main }` says what it is. One process per system. | `link/supervisor.ts`, `link/process.ts` |
| Identity | `SystemName` is the unique key of `SystemRecord`, of keys, config, status and connections. `Hello.instance` is a **per-process nonce** (to tell a restart from a reconnect), not an identity; a second connection under the same name **replaces** the first (`link.replaced`). | `core/src/link.ts`, `link/connections.ts` |
| Data | `HARNESS_SYSTEM_STATE` (default `.harness/systems/<name>`) holds the key pair, outcome journal and whatever the system keeps (fs puts snapshots and its client build there). There is no `ctx.dataDir`. | `sdk/src/server/env.ts` |
| Policy matching | `FnMatch { fn (glob), system, kind, tags, when }` is the one fn selector, used by policies. | `core/src/records/actors.ts` |

Two facts decide most of what follows:

- **The SDK's MCP face bypasses the hub.** It is right for "use one system directly from Claude Code with no hub",
  but it cannot answer the owner's ask, which is an MCP that **talks to the hub**: every call a real run, with
  policies, approvals, budgets, the ledger, metrics, and access to every system. Hub MCPs are a second, hub-side
  face; they reuse the SDK face's *shape* (tool source, resource source, prompt source over `@ayepi/mcp`) but not its
  execution.
- **The system name is the identity everywhere.** A fleet needs a second key (the instance) under it, and the change
  must break at compile time everywhere a `SystemName` is used as a connection key.

---

## 1. Hub MCPs

### 1.1 The record

One record per MCP endpoint, in the hub DB (new `HUB_TABLES` entry `mcps`, new id kind `mcp` → prefix `mcp`).

```ts
// core/src/records/mcps.ts (proposed)

/** A selector over what the hub knows. Every list is optional; an empty selector matches nothing. */
export const McpSelector = z.object({
  /** Whole systems: their fns, types, context and resources. */
  systems: z.array(SystemName).optional(),
  /** Fns, with the same matcher policies use (glob over names, system, kind, tags, a gin predicate). */
  fns: z.array(FnMatch).optional(),
  /** Named types, by qualified name or glob (`fs/*`). */
  types: z.array(NameGlob).optional(),
  /** Context items, by qualified name or glob. */
  context: z.array(NameGlob).optional(),
  /** Resources: a URI prefix, optionally on one system or instance. */
  resources: z.array(z.object({ system: SystemName.optional(), instance: InstanceName.optional(), uri: z.string() })).optional(),
});

/** What an MCP exposes: anything matched by `include` and not by `exclude`. */
export const McpRules = z.object({ include: McpSelector, exclude: McpSelector });

/** How tools are offered: one MCP tool per fn, or the small static toolset (find, describe, run). */
export const McpToolMode = z.enum(['each', 'static']);

export const HubMcp = z.object({
  id: HubMcpId,
  /** The route: `/mcp/<slug>`. */
  slug: McpSlug,                 // SYSTEM_NAME_PATTERN-like: lower-case, digits, dashes
  name: z.string(),
  /** Sent as the MCP `instructions` on initialize. */
  instructions: z.string(),
  rules: McpRules,
  toolMode: McpToolMode,
  /** The person whose permissions, budget and approvals its runs use. */
  user: ActorId,
  /** The actor its runs are attributed to (kind `mcp`). */
  actor: ActorId,
  /** Hash of the endpoint secret; the secret itself is shown once, at create and rotate. */
  secretHash: z.string(),
  /** Systems allowed to mint short-lived session tokens for it (the Claude system). */
  grantees: z.array(SystemName),
  /** Browser origins allowed (`mcpHttp` `allowedOrigins`); none means requests without `Origin` only. */
  origins: z.array(z.string()),
  enabled: z.boolean(),
  createdBy: ActorId, createdAt: Timestamp, updatedAt: Timestamp,
});
```

- `FnMatch` is reused as is, so "which fns" has one selector shape across policies and MCPs. If `FnMatch` changes,
  both break together.
- `NameGlob` is a new branded string in `primitives.ts` (`fs/*`, `hub/search_*`); the matcher that `FnMatch.fn`
  already uses becomes its one implementation (`catalog/scope.ts` or a shared `globMatch`).
- A new actor kind `McpActor { kind: 'mcp', mcp: HubMcpId }` joins the `Actor` union. Runs carry
  `user` = the MCP's `user` (real person: permissions, budget, data scope, approvals go to them) and
  `caller` = the MCP actor (attribution: "Claude session via mcp `claude-dev`"). This is product's §11.6 answer
  (a distinct principal, not act-as) mapped onto harness's existing `RunInfo { user, caller }`. Policies can then
  target `{ kind: 'mcp' }` or `{ actor: <mcp actor> }` with no new policy shape.

### 1.2 Resolution: live, on every list **and** every call

`McpScope` (hub, `catalog/` or a new `mcp/` module) turns `McpRules` plus the catalog into what is exposed:

| Object | Exposed when |
|---|---|
| fn | available, matched by `include` (its system, or an `FnMatch`), not by `exclude`, and **not tagged `admin`**. |
| type | matched, **or** in the type closure of an exposed fn's signature (`Catalog.typeClosure`). A type an exposed fn needs can't be excluded; the admin page shows that as a warning, not silently. |
| context | matched, not excluded. Context that "brings fns" brings only fns that are themselves exposed: an MCP's scope never widens through a link. |
| resource | its URI starts with a matched prefix (or its system is matched), not excluded. |

Rules:

- **A hidden tool is not a denied tool.** `tools/call` re-resolves the scope and refuses a non-member before a run is
  created. (Product §11.4 names this as the one easy vulnerability.)
- **Nothing reachable through an MCP may change what an MCP reaches.** Hub fns that edit MCPs, policies, config,
  pairing or installs carry the `admin` tag (declared on the fn, not a list in the MCP layer) and are never exposed.
- The resolved scope is cached per `(mcp.updatedAt, catalog version)` and dropped on the bus's catalog change
  events; the change also fires the tool source's `onChange`, so connected clients get
  `notifications/tools/list_changed` (and the resource and prompt equivalents).
- **Disclose the closure.** The admin page's preview lists every exposed fn, type, context item and resource root,
  with counts, the types pulled in by closure, and which exposed fns call other fns (a code fn's child calls run
  under the same grant). Product's `fnReach` is the prior art; harness can derive it from `FnDecl` deps.

### 1.3 The server: three hub-side sources over `@ayepi/mcp`

One `McpServer` per enabled hub MCP, built with `mcpSourceServer`, cached by id and rebuilt when the record changes:

- **`HubMcpTools implements McpToolSource`**
  - `toolMode: 'each'`: one tool per exposed fn. Name `<system>_<local>` (the SDK face's `toolName` rule, moved to
    one shared helper so the two faces can't drift). `inputSchema` is the fn's args as gin's value schema with docs,
    as JSON schema (the catalog's `FnSignature`, exactly what the hub's own LLM tools use). For a fleet system the
    hub adds an `on` property (an enum of the connected instance names) when more than one instance is attached
    (§4.4).
  - `toolMode: 'static'`: the build-2 static toolset (find fns, describe a fn, `run` a fn by name with args), scoped
    to the MCP. Same implementation as the chat's static mode; the MCP is just another caller of it. Cheaper for
    clients with a large exposed set.
  - `call` creates a **real run** through `RunService` (user = MCP user, caller = MCP actor, priority interactive,
    budget from the user's limits), then waits for it to settle. Outcomes map onto MCP results:

    | Run outcome | MCP result |
    |---|---|
    | `done` | `structuredContent` = result (when it is an object) and a text block of its JSON |
    | `invalid-input` | `isError: true` with the validation message. The MCP spec says input errors belong in the tool result so the model can correct them; this matches build 2's retryable `invalid-input`. |
    | `error`, `cancelled` | `isError: true` with the message |
    | waiting for approval | the call stays open; the approval card goes to the MCP's user (inbox, push) and names the MCP and the args. A deadline (`HARNESS_MCP_ASK_TIMEOUT`) ends it with `isError` "not approved in time". |
    | paused | the call stays open until the run settles (a pause resumes server-side; the MCP client only sees the end) |

    The MCP client going away (HTTP request aborted, `notifications/cancelled`) cancels the run through the signal
    `@ayepi/mcp` already passes to `call`.
- **`HubMcpResources implements McpResourceSource`**: exposed resource roots (through the link module's resource
  reader, with content refs fetched from the owning instance), plus the hub's own read-only views as resources so a
  client can learn the system without tools:
  - `harness://types/<system>/<Type>`: a type's definition, rendered as the TypeScript-like text the chat's static
    mode shows, `mimeType: text/x-typescript`.
  - `harness://context/<system>/<name>`: a context item's text.
  - `watch` follows the hub's resource change events; `onChange` follows catalog changes.
- **`HubMcpPrompts implements McpPromptSource`**: exposed context items that are loadable by `/name` become prompts,
  filled exactly as the chat fills them (the SDK's `McpPrompts` does the same per system; the filling code should be
  one function used by both).

### 1.4 Transport, route and auth

- **Route:** `/mcp/:slug` on the hub's `HttpFront`, beside `/api`, `/ws`, `/link` and `/_files` (a new
  `MCP_PATH = '/mcp'` constant in `api/http.ts`). The handler is `mcpHttp(server, { maxBody, allowedOrigins })`
  wrapped in an auth check; it is a raw handler, not an ayepi `spec()` endpoint (Streamable HTTP answers either JSON
  or SSE from one path, which the spec DSL can't express).
- **Auth:** `Authorization: Bearer <secret>`. Two kinds of bearer are accepted:
  1. the **endpoint secret** (random 32 bytes, base64url, `hmcp_` prefix so leaks are greppable; stored hashed, shown
     once, rotatable; rotating ends every open session of that MCP);
  2. a **session token** minted from it: a short-lived `@ayepi/auth` JWT `{ mcp, label, exp }` signed with the hub's
     key, minted by a hub fn `hub/mint_mcp_token({ mcp, label, ttl })` that only systems in `grantees` may call. This
     is how a future **Claude system** hands each Claude Code session its own MCP: the master secret never leaves the
     hub, each session is labelled in the runs list, and revocation is "stop minting" plus the TTL (Claude Code
     re-runs a `headersHelper` on 401 and retries once, per product §11.5). A `revoked` set keyed by label covers the
     urgent case.
- Unknown slug, disabled MCP and bad bearer all answer `404`/`401` without saying which (no slug probing).
- Rate limits per MCP with `@ayepi/rate` (`HARNESS_MCP_RATE`), so a looping client can't flood the queue.
- **stdio:** `harness mcp <slug> --hub <url>` (in the CLI, §2.5) is a stdio ↔ HTTP bridge built from `McpClient`
  + `serveStdio`, for clients that only launch stdio servers. No second server implementation.
- Connect snippets on the admin page, copyable: `claude mcp add --transport http <slug> <url>/mcp/<slug> --header
  "Authorization: Bearer …"` and the equivalent `.mcp.json` entry.

### 1.5 Admin, chat and API

- Web API slice `mcpsSlice` (admins): `mcps`, `mcp`, `createMcp` (returns the secret once), `updateMcp`,
  `rotateMcpSecret`, `deleteMcp`, `previewMcp` (the resolved scope for a draft `McpRules`, so the form previews
  before saving), `mcpSessions` (open MCP sessions: label, client info from `initialize`, since, last call).
- The same operations as admin fns (`hub/create_mcp`, …, tagged `admin`) through `AdminOperations`, so the owner can
  say "make an MCP for Claude with fs and search, no shell" in chat.
- Pages, every one on the URL: `/admin/mcps` (list: name, route, enabled, sessions now, calls today),
  `/admin/mcps/:id/(rules|preview|connect|activity)`. The rules editor is a pair of selector editors (include,
  exclude) with pickers fed by the catalog, a live preview pane beside it on wide screens and below on phones.
  Activity is the runs page filtered to the MCP's actor.
- Env slice `mcpEnv` (hub): `HARNESS_MCP_MAX_BODY`, `HARNESS_MCP_ASK_TIMEOUT`, `HARNESS_MCP_RUN_TIMEOUT`,
  `HARNESS_MCP_TOKEN_TTL`, `HARNESS_MCP_RATE`.
- Structured logs: `mcp.session.opened { mcp, label, client }`, `mcp.call { mcp, tool, run }`,
  `mcp.call.refused { mcp, tool, reason }`, `mcp.secret.rotated { mcp, by }`.

### 1.6 The SDK face stays, renamed in docs

`McpFace` keeps serving a single system directly (no hub), which is useful in dev and for sharing one system. Docs
should call it the **system MCP face** and the new one **hub MCPs**, and say which to use: a hub MCP whenever the
hub is running, because only it gets policies, approvals, budgets, metrics and other systems.

---

## 2. System packages

### 2.1 The source folder

```
systems/<name>/
  system.json        the manifest: name, version, description, entries, instances, needs
  package.json       npm dependencies and scripts (dev only; never shipped)
  shared/            the contract (source only; other systems import it for typed refs)
  server/            the process; main.ts is the entry
  client/            browser renderers; index.ts is the entry (optional)
  dist/              `harness system build` output: exactly what is packed
```

`shared/` stays in the source folder: it is bundled into `server/` and `client/` at build time and published as an
npm package for authors who want typed refs, but it is not part of an installed package.

### 2.2 `system.json`: one schema, in core

```ts
// core/src/package.ts (proposed): the one source of truth for what a package is
export const SystemPackageManifest = z.object({
  format: z.literal(1),
  name: SystemName,
  version: SemVer,
  description: z.string(),
  /** The link protocol it speaks (`LINK_PROTOCOL`); the hub refuses a package it can't talk to. */
  protocol: z.number().int().min(1),
  server: z.object({
    /** Relative to the folder: `server/main.ts` in source, `server/main.js` once built. */
    entry: z.string().min(1),
    /** npm packages left out of the bundle (native addons); the installer installs these. */
    external: z.record(z.string(), z.string()).default({}),
    node: z.string().optional(),
  }),
  client: z.object({ entry: z.string().min(1) }).optional(),
  /** One instance, or a fleet (§4). */
  instances: z.enum(['one', 'many']).default('one'),
  /** File hashes, written by `pack`, checked by install. */
  files: z.record(z.string(), z.string()).optional(),
});
```

- `Installer.describe` reads `system.json` instead of `package.json`'s `harness` block; `SystemPackageJson` goes
  away (one fact in one place). The contract name in `shared/` must equal `system.json`'s `name`; `build` checks it
  and `serve()` checks it at startup.
- The manifest's `version` replaces `package.json`'s version as the system's version.

### 2.3 Data and config

- **Config lives in the hub DB** (today's `SystemRecord.config`, moving onto the instance record, §4.2). Nothing in
  the package or the data folder holds config. Secret config fields go through the hub's secrets module as today.
- **Data**: the hub gives each installed instance its own folder **outside the package**, so upgrades and rollbacks
  keep it:

  ```
  <HARNESS_DATA>/systems/<name>/
    versions/<version>/            the unpacked package, read-only once placed
    instances/<instance>/
      state/                       the SDK's: key pair, outcome journal (HARNESS_SYSTEM_STATE)
      data/                        the system's: ctx.dataDir (HARNESS_SYSTEM_DATA)
      cache/                       rebuildable (client builds, indexes); never exported (HARNESS_SYSTEM_CACHE)
  ```

  A new `SYSTEM_ENV.data` / `SYSTEM_ENV.cache` pair joins `SYSTEM_ENV`, and `ctx.dataDir` / `ctx.cacheDir` join
  `SystemCtx` (every ctx a system gets). A system run outside the hub defaults to
  `.harness/systems/<name>/<instance>/{state,data,cache}` beside it, so the code is the same either way. fs moves its
  snapshots to `dataDir` and its client build to `cacheDir`.
- "Leave it up to them" is the answer for **format**: a system stores what it likes in `dataDir` (files, SQLite, …).
  Portability comes from the folder being known: the hub can back it up, export it and restore it without knowing
  what is inside. A system that needs a quiet moment for a consistent copy (an open SQLite file) handles a new
  lifecycle event `exporting` (flush, checkpoint) before the copy; the default is nothing.

### 2.4 Zip install

- `InstallSource` gains `z.object({ zip: ContentHash, name: z.string() })`: the zip is uploaded through the hub's
  file store (ayepi files, content-addressed), then installed. One install path for every source.
- Install: unzip into staging, parse `system.json`, check `protocol` and the `files` hashes, refuse paths that escape
  the folder, refuse a name that is installed already (upgrade is the upgrade path), `npm install` only the
  `server.external` packages, place under `versions/<version>`, pair with a hub-made key (as today), preset config
  if given, start.
- Upgrade from a zip: same checks plus "same name, higher version"; the old version stays for rollback
  (`goodVersion`, already in `InstalledSystem`).
- Admin UI: the install dialog gets a drop zone for a zip beside folder, npm and git.
- Zip library: **`fflate`** (pure JS, no native code, streaming unzip) is the suggestion; needs adding to
  `@harness/hub` and the CLI.
- Trust: a package is code that runs on the hub machine as the hub's user. Install is admin-only, hashes catch
  corruption (not malice). Say so on the install dialog. Process isolation already exists (one process per system).

### 2.5 The CLI: `harness`

A new workspace package `packages/cli` (`@harness/cli`, `bin: { harness }`), arguments parsed with
`node:util` `parseArgs` and checked with zod (no CLI framework needed; one schema per command). It talks to a running
hub over the web API (`hubWebSpec` client from `@ayepi/core`) and signs in with an admin token: `--token`,
`HARNESS_TOKEN`, or the admin email and password from `.env` as `scripts/hub-client.ts` does today (that helper moves
into the CLI so scripts use it from there).

| Command | Does |
|---|---|
| `harness system new <name> [--dir]` | Copies the **template system** (build 2's first item: placeholders and comments, no example code) and fills in the name. |
| `harness system build [dir]` | Typechecks, checks the contract name against `system.json`, bundles `server/main.ts` into `dist/server/main.js` (Vite SSR build: everything inlined except `server.external`), builds `client/` with `buildClient` into `dist/client/`, writes `dist/system.json` with built entries. |
| `harness system pack [dir]` | Builds if stale, hashes every file into `files`, zips `dist/` to `<name>-<version>.zip`. |
| `harness system install <zip\|dir\|npm-spec> [--config file.json] [--instance name]` | Uploads the zip (or names the folder/npm/git source) and calls `installSystem`; prints the instance's status as it starts. |
| `harness system export-data <name> [--instance] [--out]` | Calls a new admin endpoint `exportSystemData`: the hub runs `exporting`, zips `data/` plus `config.json` (the config value, secret fields left out unless `--with-secrets` and the admin confirms) and `system.json`, and returns a content ref the CLI downloads. `install --data <export.zip>` restores both. |
| `harness system list|start|stop|upgrade|uninstall` | Thin wrappers over the existing admin endpoints. |
| `harness mcp <slug>` | The stdio bridge to a hub MCP (§1.4). |

Each command is a class implementing one `Command` interface (`name`, `args` zod schema, `run(args, io)`), with the
hub client and file system injected, so every command is unit-tested without a hub or a disk.

---

## 3. QR pairing

### 3.1 Flow

1. A system starts with `HARNESS_HUB` set and no stored pairing. It says hello; the hub answers `pairing` with a
   code and a URL (today).
2. **New:** the system then calls a new link endpoint `pairingInfo` with what the admin needs to see before the
   manifest is sent: `{ description, instance, config: GinTypeDef | undefined, version }`. The hub stores it on the
   `PairingRequest` (new optional fields `description`, `instance`, `configType`).
3. The SDK prints, besides the existing `system.pairing` log line, a **terminal QR code** of the URL and the code
   in large text under it. `HARNESS_PAIRING_QR=auto|always|never` (sdk env slice; `auto` = only when stdout is a
   TTY, so supervised and JSON-logged systems don't print blocks).
4. The URL is a dedicated page: **`/pair/:pairing?code=<code>`** (a new web route, phone-first). Scanning carries
   the code, so the page shows "matches the code on the screen" without typing; opening the link from the admin list
   asks the admin to compare it as today. The pairing id is unguessable (`mintId` uses secure randomness), so the QR
   binds the admin to exactly the request on that screen, which is stronger than picking from a list.
5. The page (signs in first if needed, then returns): system name, instance name (editable, §4), version, address,
   short key fingerprint, expiry countdown, and the **config form** rendered from `configType` with the build-2 gin
   value editor (secrets as secret inputs). Buttons: **Pair**, **Reject**.
6. **Pair** sends `approvePairing { pairing, approve: true, instance, config }`: the hub checks the config against
   the type, pairs, presets the config, and tells the waiting socket `paired`. The system says hello again, gets a
   challenge and a welcome **with config**, and is usable in one step instead of "pair, then go find config".
7. The page then follows the system live (connected → indexed → ready) and links to its admin page.

### 3.2 The URL must be reachable from the phone

The approval URL is built from the hub's `url` setting, which is `127.0.0.1` in dev; a phone can't open that. Proposal:
build it from `HARNESS_PUBLIC_URL` when set, else from the `Host` the system used to reach `/link` (if the system
dialed `ws://192.168.50.112:4300/link`, the phone can open `http://192.168.50.112:4300/pair/…`). Never a hostname
the hub guesses.

### 3.3 Pieces

- core: `PairingRequest` gains `description`, `instance`, `configType`; `hubLinkSpec` gains `pairingInfo`;
  `approvePairing` body gains `instance` and `config`.
- sdk: `PairingDisplay` interface (`show(reply, info)`) with a `TerminalPairingDisplay` (QR) and a log-only one;
  injected so tests capture what was shown.
- web: `/pair/:pairing` page, its state file and caller, using the existing `PairingCard` and the gin value editor.
- QR library: **`qrcode`** (terminal UTF-8 output via `toString(text, { type: 'terminal', small: true })`, and SVG if
  the admin page ever shows one). Needs adding to `@harness/sdk`.

---

## 4. Fleets: many instances of one system

### 4.1 Choice: one system, many instances

Two ways to attach several fs machines:

| | A: one system per machine (`fs-laptop`, `fs-desk`) | **B: one system `fs`, instances `laptop`, `desk`** |
|---|---|---|
| fn names | `fs-laptop/read`, `fs-desk/read`: N copies of every fn | `fs/read` once |
| typed refs from other systems (`fs.fns.read`) | break: the name is in the contract | keep working |
| LLM tool list | grows with every machine (bad for small-context models) | constant; the instance is one argument |
| config, keys, data | per name | per instance |

**B.** The system is the contract; an instance is one paired attachment of it. Systems whose `system.json` says
`instances: 'one'` (the default) have a single instance named `main`, so nothing changes for them.

### 4.2 Identity and records

- New primitive `InstanceName` (same pattern as `SystemName`, branded) and `InstanceRef = { system, instance }`,
  written `fs@laptop` in logs and the UI.
- `Hello` gains `instance: InstanceName` (from `HARNESS_INSTANCE`, default `main`). Today's per-process nonce is
  renamed `boot` everywhere (`Hello.boot`, `LinkSession.boot`, `SystemInfo.boot`), so every use of the old field
  breaks at compile time and is looked at.
- `SystemRecord` splits:
  - `SystemRecord` (per system): name, description, enabled, `instances` mode, the accepted manifest, actor.
  - `InstanceRecord` (per instance, key `[system, instance]`): status, key fingerprint and public key, version,
    manifest hash, config, `installed?`, paired at/by, last seen, address. Pairing, config, status and installed
    systems all move from `SystemName` keys to `InstanceRef` keys.
- `SystemStatus` stays per instance; the system's status is derived (connected if any instance is).
- `LinkService.connection(system)` becomes `connection(ref)` plus `connections(system)`; the "a second connection
  replaces the first" rule applies per instance, not per system.
- Installed systems: one `InstalledSystem` per instance (`versions/` shared under the system, `instances/<name>/`
  each, §2.3). `harness system install fs.zip --instance desk` adds an instance to an installed system.

### 4.3 Manifests across a fleet

Instances may run different versions during a rollout. The catalog keeps one manifest per system: the newest one
accepted. Each instance records its own manifest hash and the fn versions it serves; a run only routes to an instance
that serves the fn at the run's version. Instances behind show an "older version" badge; a fn no instance serves is
unavailable with `no-instance` (a new `FnUnavailable` value).

### 4.4 Routing a run to an instance

The instance is a **run option owned by the hub**, never a field in a fn's args, so contracts don't change:

- `RunRequest.run.system.instance` is the target; `ctx.call(fs.fns.read, args, { on: 'laptop' })` in the SDK.
- For LLM tools of a fleet with more than one attached instance, the hub adds an `on` property (enum of the attached
  instance names, described with each instance's description) to the tool's input schema and strips it before the
  args are checked. In the static toolset, `run fs/read on=laptop {…}`.
- When `on` is not given, the hub picks, in order:
  1. the instance a **resource URI** in the args belongs to (see below);
  2. the session's pinned instance (set by `/on laptop`, or by the last explicit choice in the session; kept in
     session state);
  3. the system's default instance (admin setting);
  4. the only connected instance.
  Otherwise the run ends `invalid-input` "fs has several machines: say on=laptop or on=desk", which build 2's
  retryable status already handles softly.
- **Resource URIs carry the instance.** fs serves `file://` URIs; RFC 8089 allows a host, so in a fleet the SDK's
  `fileUri(path)` writes `file://<instance>/C:/…` (from `ctx.instance`), and the hub routes reads by the URI's host.
  Single-instance systems keep `file:///…`. Other schemes follow the same rule: the authority names the instance.
- Mentions and dynamic context ask every connected instance and merge, labelling options by instance
  (`laptop: docs/a.md`).

### 4.5 UI

- `/admin/systems/:system` shows the system with an **Instances** list (status dot, version, address, last seen,
  config state); `/admin/systems/:system/:instance` is one instance: config, process, logs, data export, remove.
- Systems list cards show `fs · 3 instances · 2 connected`.
- Chat: a run chip reads `fs/read · laptop`; the resource browser groups by instance first; mention options show the
  instance.
- Fleet health on the admin home: instances disconnected, behind on version, or needing config.

---

## 5. Order of work and ownership

1. **core (orchestrator):** `InstanceName`, `InstanceRef`, `boot` rename, `SystemRecord`/`InstanceRecord` split,
   `SystemPackageManifest`, `InstallSource.zip`, `PairingRequest` fields, `pairingInfo`, `HubMcp` and its slice,
   `McpActor`, `NameGlob`, `FnUnavailable.no-instance`, the `mcp` id kind, `SYSTEM_ENV.data/cache/instance`.
2. **link lane:** instance-keyed connections, pairing (`pairingInfo`, approve with config and instance, public URL),
   supervisor per instance and zip install, `exportSystemData`, routing reads by URI host.
3. **execution lane:** instance routing (`on`, the pick order, `invalid-input` when ambiguous), `no-instance`.
4. **a new mcp module in the hub (api lane or its own lane):** `McpScope`, the three sources, the `/mcp/:slug`
   route, secrets and session tokens, `hub/mint_mcp_token`, admin ops and fns.
5. **sdk lane:** `ctx.dataDir`/`cacheDir`/`instance`, `HARNESS_INSTANCE`, `fileUri` with instance host,
   `PairingDisplay` with QR, `system.json` check in `serve()`, shared tool-name and prompt-filling helpers.
6. **cli lane (new):** `packages/cli` commands; moves `scripts/hub-client.ts` in.
7. **fs lane:** snapshots to `dataDir`, client build to `cacheDir`, `system.json` with `instances: 'many'`.
8. **web lane:** `/pair/:pairing`, instances on system pages, MCP pages, install drop zone, run chips with instance.

Tests (all with injected seams): scope resolution tables (include/exclude, closure, `admin` tag never exposed,
call refused for a non-member even if listed earlier); MCP over `mcpHttp` against a fake run service (done,
invalid-input, error, approval wait and timeout, cancel on abort, list_changed on catalog change, bad bearer, rotated
secret, expired session token); pack → install round trip with a tampered file refused and a path escape refused;
export → restore round trip; pairing with `pairingInfo` and config set at approval reaching the welcome; two fs
instances connected at once, reads routed by `on`, by URI host and by session pin, the ambiguous case
`invalid-input`; a replaced connection only replaces its own instance. One live e2e: Claude-Code-like client
(`McpClient`) through a hub MCP calling `fs/read` on one of two fs instances, ports above 4400, data under
`.harness-test/`.

## 6. Library asks (`@ayepi/mcp`)

- **Tool `annotations` and `_meta`** on `McpTool` (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`, and `_meta` for `anthropic/requiresUserInteraction`), so the hub can mark write tools from the
  fn's own tags (product §11.4).
- **Server progress:** a way for a tool source to send `notifications/progress` for a call that carried a
  `progressToken` (long runs, approval waits).
- **Per-session info for sources:** pass the `initialize` client info and the session id to `call`/`read` (today
  only `signal` and, for subscriptions, the session), so the hub can label runs by MCP session without its own map.
- Optional: an `authenticate(request)` hook on `mcpHttp` so transports don't each wrap the handler.

## 7. Dependencies to add

- `fflate` (zip and unzip): `@harness/hub`, `@harness/cli`.
- `qrcode` and `@types/qrcode`: `@harness/sdk`.
- `@harness/cli` as a new workspace (its deps: `@harness/core`, `@ayepi/core`, `@ayepi/mcp`, `vite`, `zod`).
