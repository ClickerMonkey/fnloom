# Build 9 design (binding)

The spec is [build-9.md](build-9.md). Prior art: product's `design/mcp-system.md`, `claude-code-system.md` (Route B, with
the MCP callback), `api-kind.md` and `packages/core/src/kinds/{code,api,program}.ts` (take the intent, not the code).
Owner rules: the Decided section of [../harness.md](../harness.md). The shared contracts are written (core, below).

## 0. Decisions

1. **Three new bundled systems and one reworked one**: `mcp` (fleet: one instance per MCP server), `api` (fleet: one
   instance per API service), `code` (one instance), `claude` (fleet: one instance per machine). Each is a workspace in
   `systems/<name>` (skeleton `package.json` in place; the lane adds `system.json`, `tsconfig.json` and the root
   `tsconfig.json` reference).
2. **An MCP server and an API service are instances**, added from the browser with the hub's new `addInstance`
   (web, admins) and the hub fn `hub/add_instance` (the same `AdminOperations` call). The hub installs the system's
   bundled folder (`InstallSource.path`) as a new hub-run instance, pairs it with `pairInstalled`, sets its config and
   starts it. The stack does not run `mcp` or `api` processes; it runs `code` and `claude/main` like `widgets` and `fs`.
3. **One auth shape for remote services**, `RemoteAuth` (`none | bearer | headers | oauth`, each `shared` or
   `person`). Shared secrets are config secrets. Per-person ones (and OAuth) go through the existing connect flow,
   made **instance-scoped**: `ConnectDecl.scope: 'instance'`, the instance tells the hub how people connect to it
   (`instanceConnect` on the hub link, `InstanceConnect`), connections carry `instance`.
4. **Approvals and questions are proposed runs.** `ProposeRun` gains `for` (the person a run proposed outside a run
   waits for), `chat` (the chat that also shows the card) and `ask` (`ProposalAsk`: a form the approver fills; its
   value becomes `args[into]`). The approve endpoint takes `answer`. A system hears the run settle through the existing
   `run` system event (done: go ahead; cancelled: denied, with the reason). The inbox and chat show them as they show
   every approval; the card draws `ask` with the gin value editor.
5. **Claude base: the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk@0.3.323`, installed in `systems/claude`), not
   the CLI. The SDK drives the same Claude Code binary and gives, typed: `query()` with streaming input (send messages to
   a live session), `interrupt()`, `setPermissionMode()`, `setModel()`, `resume`; `canUseTool` (a tool waits on a
   promise we resolve from an approval), `onElicitation` and `onUserDialog` (questions); `listSessions`,
   `getSessionInfo`, `getSessionMessages`, `listSubagents`, `getSubagentMessages` (paged reads of Claude's own store);
   `task_started/updated/progress/notification` messages (subagents, shells, monitors and workflows with progress);
   `supportedAgents()`, `supportedCommands()`, `mcpServerStatus()` (imports). The CLI's `stream-json` is the same
   protocol without the types, the callbacks or the transcript readers, which we would re-implement.
6. **No new local stores.** Live session handles live in the claude process (process state, like the database
   system's waiting changes); each live session is mirrored as a hub record (`claude/Session`, owner the person), so
   the fleet list, filters and search run in the hub's database. Transcripts stay in Claude's store and are read a page
   at a time. MCP tools, prompts and resources are mirrored into the hub with the runtime add/update/remove API.
7. **Code and API share one gin program runtime in the SDK** (`@harness/sdk/program`, `packages/sdk/src/program/`), the
   port of product's `kinds/program.ts`: session artifact and prefeed (types, fns, data), the validation pipeline
   (`registry.parseExpr`, closed-world type check, `engine.validate` with a scope of args, `fns`, `config`, the
   result-type check with the paste-ready spelling), the scope-read walk, and execution with `fns.<system>.<name>(…)`
   calling `ctx.call`. Use gin's own `analysis`, `authoring`, `effects` and `engine` first; port only what gin lacks.

## 1. Shared contracts (written; `packages/core/src`)

| File | Holds |
|---|---|
| `remote-auth.ts` | `RemoteAuth`, `RemoteAuthPer`, `HeaderValues`, `REMOTE_AUTH_SECRETS`, `TypedAuth` and `TYPED_AUTH_SECRETS` (no OAuth: API services), `connectFlowOf`, `RemoteCredentials` |
| `mcp-servers.ts` | `MCP_SYSTEM`, `MCP_TOOL_KIND`, `McpTransport` (stdio, http, sse), `McpServerConfig`, `MCP_CONFIG_SECRETS`, `McpServerStatus`, `McpToolAnnotations`, `McpToolSpec` (the `mcp/tool` payload), `mcpToolFnName`, `mcpRootOf` |
| `programs.ts` | `CODE_SYSTEM`, `CODE_KIND` (`code/program`), `CodeFnSpec`; `API_SYSTEM`, `API_KIND` (`api/request`), `ApiFnSpec`, `HttpMethod`, `ApiServiceConfig`, `API_CONFIG_SECRETS`, `HttpExchange` |
| `claude.ts` | `CLAUDE_SYSTEM`, `CLAUDE_SESSION_TYPE`, `ClaudeInstanceConfig`, `CLAUDE_CONFIG_SECRETS`, `ClaudeSession`, `ClaudeSessionStatus`, `ClaudeTask`, transcript `Query`/`Page`/`Item`, `ClaudeStart`, `ClaudeSend`, `ClaudeTurn`, `ClaudeControl`, `ClaudePermit`, `ClaudeAnswer`, `ClaudeImportable` (an MCP server as `ClaudeMcpServerSummary`: never its secrets), `ClaudeImport` |
| `connections.ts` | `ConnectDecl.scope` / `defaults`, `UserConnection.instance`, `ConnectStart`/`ConnectFinish.instance`, `InstanceConnect`, `ConnectPage.instances` |
| `approvals.ts`, `records/actors.ts` | `ProposalAsk`; `ProposeRun.for` / `chat` / `ask`; `Approval.ask` |
| `package.ts`, `web.ts`, `link.ts` | `AddInstance`; web `addInstance` (packaging slice), `connect` takes `instance`, `approve` takes `answer`; hub link `instanceConnect` |

Config types are these zod schemas read into gin with the SDK's `zodGin` (one source). A lane that needs a contract
change writes it in its report.

## 2. Platform lane (libraries and SDK plumbing)

- **@ayepi/mcp** (harness branch, rebuild dist): (a) `McpClient` answers server requests through a handler option
  (`elicitation/create`, `roots/list`, `ping`; `sampling/createMessage` refused for now) and advertises the capabilities
  it handles; (b) `McpSseClientTransport` for the 2024-11-05 HTTP+SSE transport; (c) `oauth.ts`: the MCP authorization
  client (protected-resource metadata from `WWW-Authenticate` / `.well-known`, authorization-server metadata, dynamic
  client registration, PKCE authorize URL with the `resource` indicator, code exchange, refresh) as plain functions over
  `fetch`; (d) `spawnStdioClient(command, args, { env, cwd })` returning the transport and the child. Docs in
  `ayepi-mcp.md`.
- **SDK** (`packages/sdk`): `system.instanceConnect(InstanceConnect)`; `propose` passes `for`, `chat`, `ask`; the test
  kit's fake hub records proposals and lets a test approve (with an answer) or decline them; `zodGin` covers what the new
  configs use. `scripts/docs/outline.ts` places new exports.

## 3. Hub lane

- `addInstance` / `hub/add_instance`: bundled folders from a new env setting `HARNESS_BUNDLED_SYSTEMS` (default the
  repository's `systems/`), or the source of an installed instance of the same system; refuses a system whose
  `system.json` says `instances: "one"` and a taken instance name. `removeInstance` already exists.
- Instance-scoped connections (`connections/`): rows keyed by system, instance and owner; `instanceConnect` stored per
  instance; a fn that runs on an instance needing a connection is unavailable to a person without one (shared: the
  admin's connection, shared with everyone); `connectStart`/`connectFinish` go to that instance; the run carries the
  connection as today.
- Proposals (`link/`, `execution/`): `for` accepted only when that person owns a `claude/Session`-style record of the
  proposing system's types naming the proposal, or a run of it (refuse otherwise, logged); `chat` places the card in
  that chat; `ask` stored on the approval, `answer` checked against the type and set at `args[into]` before the run
  starts.
- Grants: `mcp` and `api` declare `network: ['*']` (reviewed at go-live); confirm the allowlist proxy accepts it.
- Merge nothing else into `hubWebSpec`; run `npm run web:manifest` after the core changes.

## 4. MCP lane (`systems/mcp`)

- Contract: config `zodGin(McpServerConfig)`, `configSecrets: MCP_CONFIG_SECRETS`, `connect` with `scope: 'instance'`,
  kind `mcp/tool` (describe from `McpToolSpec`: args, returns, effects from annotations only when `trusted`, approval
  by `approval` policy), fns `server_status`, `refresh`, `answer_elicitation` (proposal target, hidden from the model).
  `system.json`: `instances: "many"`, `permissions.childProcess: true` (stdio).
- Instance: connects with `McpClient` over stdio, http or sse, signing with the instance's auth (OAuth tokens
  refreshed and handed back with `connectionUpdate`); mirrors tools (fns `<instance>_<tool>`, JSON Schema to gin with
  `degraded` where it does not map), prompts (context items with `/commands`; content from `getPrompt` when shown,
  as dynamic context) and resources (root `mcp://<instance>/`, read through `readResource`); re-mirrors on
  `list_changed`; never removes on absence (a down server leaves its fns unavailable, not deleted); reports status.
- Elicitation during a call: a proposal of `answer_elicitation` under the call's run with `ask` from the requested
  schema. Tests: the SDK test kit and `McpMemoryClientTransport` over an `@ayepi/mcp` server; no network.

## 5. Codeapi lane (`systems/code`, `systems/api`, `packages/sdk/src/program/`)

- `@harness/sdk/program`: the shared runtime (decision 7) plus the authoring tools both agents use, on
  `authoringAgent()` with its forced stages (find → inspect → draft → check → fix → save) and progressive disclosure:
  `search` / `load` (types, fns, data), `signature`, `set`, `test`, `return`, `examples`, as product's table.
- `code`: kind `code/program` (payload `CodeFnSpec`; describe derives deps from the program's `fns` calls and effects
  from theirs), fn `make_code` (the authoring agent; saves with `hub/save_fn` and returns the authored fn).
- `api`: gin types `HttpRequest`, `HttpHeader`, `HttpParam`, `HttpBody`, `HttpPart`, `HttpResponse` (product §2.1),
  kind `api/request` (payload `ApiFnSpec`, runs on its service; mode from the method read off the program: GET/HEAD
  read, others write and ask), the executor (base URL enforced, auth applied by the instance, multipart and binary
  bodies from hub content, a file response kept as a resource, `HttpExchange` in the trace with credentials masked),
  fns `make_api`, `operations` (the service's OpenAPI document, paged), `test_request` (GETs only while authoring).
  Config `zodGin(ApiServiceConfig)`, `instances: "many"`, instance-scoped `connect`.
- Tests: the kit with `mockModel` replays of the authoring agents; one `realModel` live test each.

## 6. Claude lane (`systems/claude`)

- A `ClaudeDriver` interface (start, resume, send, interrupt, stop, set mode, list, messages, subagents, importables)
  with `AgentSdkDriver` and a fake for every test. **No test starts a real Claude session** (the owner's credits);
  a single opt-in `*.live.test.ts` may, with a one-line prompt.
- Fns: `start_session` (`ClaudeStart` → `ClaudeTurn`; a write), `send` (`ClaudeSend`; a write; with `wait` the run's
  progress shows tool uses and tasks), `control` (`ClaudeControl`), `transcript` (`ClaudeTranscriptQuery` →
  `ClaudeTranscriptPage`), `disk_sessions` (Claude's store, paged), `permit` and `answer` (proposal targets, hidden
  from the model), `importables`, `import` (an admin proposal). Sessions are listed through the hub's records
  (`hub/records_*`); type `claude/Session` with `records: { shape: 'table', owner: 'person', search: { text:
  ['title', 'folder', 'lastText'], embed: false } }`.
- `canUseTool` → proposal of `permit` (`for` the owner, `chat`, preview: the tool, a diff for edits, the command for
  shells); `AskUserQuestion`, `onElicitation`, `onUserDialog` (known kinds; others `cancelled`) → proposal of `answer`
  with `ask`. Pending callbacks keyed by request id; on restart they are gone and the runs fail plainly.
- `task_*` messages → `ClaudeTask`s on the record (debounced writes, env slice). Idle sessions close after
  `idleClose` and stay resumable. `hubMcp` is given as the `harness` MCP server only to the sessions of its `person` (the hub runs its calls as the person it was made for). Sessions run with an allowlisted env (`sessionEnv`, `CLAUDE_ENV_PASS`), never the harness keys.
- Imports: skills → context items with `/commands` (runtime patch), agents → fns of kind `claude/agent` that run a
  session as that agent, MCP servers → `hub/add_instance` of `mcp` with a mapped `McpServerConfig`.
- Stack: `scripts/stack.ts` / `run-stack.ts` gain the `claude` component (folders: the repository's parent); `code`
  joins the bundled components.

## 7. Web lane (`packages/web`)

- **MCP servers** (`/admin/mcp-servers`, `/admin/mcp-servers/:instance`): list with state, counts, degraded tools;
  add and edit from `McpServerConfig` (transport and auth as segmented choices, secrets as passwords, kept secrets shown
  as kept); links to the instance's fns and context on the system page.
- **API services** (`/admin/api-services`, `/:instance`): the same pattern over `ApiServiceConfig`.
- **Connections**: instance cards for instance-scoped systems (`ConnectPage.instances`), OAuth or form.
- **Approval cards** (chat and inbox): draw `Approval.ask` with the gin value editor; Approve sends `answer`.
- **Claude** (`/claude`, `/claude/:instance/:session`): the fleet from the hub's records (filters: machine, folder,
  status, waiting), a session's transcript paged as you scroll up, tasks and workflows with progress, its waiting
  cards inline, a composer (send), interrupt, stop and mode; new session (machine, folder, prompt). State and callers
  in `state/` and `api/`, components decoupled; component tests over fixtures; browser checks only for layout.

## 8. Order

core (done) → platform and hub in parallel with mcp, codeapi and claude (they build on the test kit's fakes) → web →
integration (stack, e2e API checks, ui-tests for the new pages' layout).

## 9. Status (2026-11-13, integration)

- **Core contracts** (§1): done as written.
- **Platform** (§2): done. `@ayepi/mcp` on its harness branch has the server-request handler (elicitation, roots,
  ping; sampling refused with `-32601`), `McpSseClientTransport`, the OAuth client functions and `spawnStdioClient`
  (`@ayepi/mcp/node`), with docs; dist rebuilt. The SDK has `system.instanceConnect`, `propose` with `for` / `chat` /
  `ask`, and recorded proposals in the test kit. gin (aits harness branch) gained stoppable runs (`RunOptions`
  `signal` / `slice`, `RunStoppedError`), which the program runtime uses. Both branches are committed with clean builds.
- **Hub** (§3): done. `add_instance` (web and `hub/add_instance`, `HARNESS_BUNDLED_SYSTEMS`), instance-scoped
  connections, proposals with `for`, `chat` and `ask` (answer checked and set at `args[into]`).
- **MCP** (§4): done. stdio, HTTP and SSE; `RemoteAuth` incl. OAuth with refresh; tools, prompts and resources
  mirrored and re-mirrored on `list_changed`; degraded schemas counted on the status; elicitations as proposals.
  Tests: unit over the kit and memory transports; e2e adds a stdio server and an HTTP server behind a bearer token.
- **Code and API** (§5): done. `@harness/sdk/program` (runtime and authoring tools), `make_code`, `make_api`,
  `operations`, `test_request`, the HTTP executor. One `realModel` live test each. Left: gin's `buildSchemas` lazy
  getters rebuild on every call, worked around in `program/runtime.ts` (marked `LIBRARY GAP (gin)`).
- **Claude** (§6): done on the Agent SDK behind `ClaudeDriver` (fake driver in every unit test). The e2e session test
  is opt-in (`HARNESS_E2E_CLAUDE=true`, one real Haiku session) and is not run by default, so the real driver against
  a real Claude Code is only covered by `agent-sdk.live.test.ts` (opt-in too).
- **Web** (§7): done. MCP servers and API services pages, instance connection cards, `ApprovalAsk` on approval cards,
  `/claude` fleet and session pages (transcript paged, tasks, waiting cards, composer, controls).
- **Owner feedback** (build-9-feedback.md): the create-table bug has a regression test (database `link.test.ts`,
  the model's string-typed `type`); tests use GPT-6 Luna (`HARNESS_LIVE_MODEL`); a fn on a system page opens the fn
  modal (`FnModal.vue`, shared with the fn page).
- **Integration run** (2026-11-13): `npm run check` passes except tests that time out only under load (8 files in the
  full run; each passes alone). `npm run e2e`: 11 of 16 files pass, `build9` among them. The rest failed twice on a
  loaded machine: the shared embedder took 90s for one embedding, so `chat` (fn suggestions from embeddings), `runs`
  (embedding calls recorded), `build5` (the saved query fn not found to reuse) and `build3` (the model did not call
  `hub/query`) did not get their search results; `authoring` ran out of iterations on GPT-6 Luna (its install test
  depends on it). The stack start wait is now `HARNESS_E2E_START_TIMEOUT` (default 180s; the hub alone takes about
  45s from source on a busy machine). Rerun these five suites when the embedder is idle.
