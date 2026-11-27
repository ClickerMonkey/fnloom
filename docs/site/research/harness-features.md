# Harness features: what exists and works (2026-11-26)

The inventory behind the site's feature matrix (`docs/plans/site-2026-11-26.md`). Every row is something built in this
repository, with the code and the tests that show it. Paths are relative to the repository root (`E:\GitHub\harness`)
unless they start with `aits/` (the aeye libraries, `E:\GitHub\aits`, linked from `../aits`).

**Status column**

- **Built**: built, covered by unit/component tests and, where marked, by e2e suites, ui-tests or passing scenarios.
- **Opt-in**: built and unit-tested with fakes; the test against the real service runs only when a key or local server
  is present (`describe.skipIf` / `realModel.it`).
- **Partial**: built, but with a real limit a page must state (the row says which).

"Scenario N" is a case of the 84-case scenario bench (`scripts/scenarios/cases*.ts`, results under
`.harness-test/scenarios/<iteration>/report.md`): a simulated person (DeepSeek v4.1 Flash) talks to the real stack
running GPT-6 Luna, and a judge model scores each case. Latest results: set 1 (cases 1-40) iter-5, 71 pass / 47 weak /
2 fail of 120; set 2 (41-80) iter-6-second, 75 / 37 / 7; set 3 (81-84) cases3-run2, 0 / 3 / 1.

Labels are 1-5 plain words for non-technical readers; the technical names are in the evidence column.

---

## 1. Safety and control

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Asks before risky actions | Anything that writes, deletes or runs a command waits for a person's Approve or Deny card, with a preview of what will happen. | Policies allow/deny/ask in `packages/hub/src/execution/policies.ts`; `ApprovalTray.vue`, `components/approvals/ApprovalCard.vue`, `ApprovalPreview.vue`; tests `execution/policies.test.ts`, `execution/approvals.test.ts`; ui-test `approvals`; e2e `chat` (approval of a shell command) | Built |
| Previews before you approve | Approval cards show the exact SQL and rows touched, file diffs, type changes or the shell command, not just a fn name. | `ApprovalPreview.vue`, `TypeDiff.vue`, `SensitiveFiles.vue`; database `server/link.test.ts` "proposes a write…, previews it, and runs it once approved"; `systems/claude/server/preview.ts` | Built |
| Remember my answer | "Always" on an approval becomes a lasting rule; "for this chat" lasts the chat. | Approvals as records turning into policies (`docs/harness.md` § Actors and permissions); `execution/policies.test.ts` | Built |
| Choose how much it may do | Each chat has a mode: nothing, read only, up to write, up to delete, or auto (a classifier model judges each call). | Fn modes `packages/hub/src/fns/gate.ts`, `fns/auto.ts`; `execution/modes.test.ts`; ui-test `chat-modes` | Built |
| Who approves is configurable | A rule can route the question to the person, a named person, a group, an AI judge, or the hub. | `Policy` ask targets, `execution/policies.ts`; admin `PoliciesView.vue`; ui-test `admin-policies` | Built |
| Rules for one task only | A rule can allow a fn only when a specific other fn calls it (e.g. "allow writes only from the nightly backup"). | Policy `via` match, `execution/policies.ts` | Built |
| Guards secret files | Reading or writing .env files, keys, credentials, git-ignored or secret-looking files always asks, and they are hidden from listings and search. | `systems/fs/server/sensitive.ts`; `systems/fs/server/impl.test.ts` "flags sensitive files before a run, leaves them out of listings and searches" | Built |
| Only plainly safe commands skip asking | A shell command runs without asking only if it is a plain, known-safe command inside the allowed folders; chains, pipes and redirects ask. | `systems/fs/server/safe.ts`; `safe.test.ts` "refuses lookalikes and anything that chains, pipes, redirects or substitutes" | Built |
| Never leaves its folders | File tools are fenced to configured folders; links that point outside are refused. | fs root guard, `systems/fs/server/paths.ts`, `links.test.ts`; claude folder check `systems/claude/server/claude.test.ts` | Built |
| Checks a call before asking you | Bad arguments are caught and sent back to the model before anyone sees an approval card. | `FnDecl.check`, args check before approval (`docs/harness.md` § Args checks); commit 85d9b11; schedule `server/fns.test.ts` | Built |
| Resists pasted instructions | Pasted "delete everything" text and forged notes are refused rather than obeyed. | Scenarios 39 "Paste this in" and 77 "A note from the doctor": pass in every rep (iter-5, iter-6-second) | Built (scenario-proven) |
| Never asks for passwords | Asked to check for leaked passwords, it helps without ever asking for one. | Scenario 34: pass in every rep (iter-5) | Built (scenario-proven) |
| Says when it is blocked | When something is refused or keeps failing, it tells you what blocks it and why instead of working around it. | Chat prompt rule `packages/sdk/src/chat-prompt.ts`; the model always gets the refusal reason (`docs/harness.md` § Systems) | Built (prompt rule, no hub guard) |
| Admin reviews every add-on | A new or changed add-on waits on a review page (what it adds, the access it wants, risk flags) before it goes live; its screens load only after approval. | `link/lifecycle.ts`, `ReviewView.vue` Pending tab, `SystemLifecycle.approvedClient`; ui-test `build7-review`; e2e `install` | Built |
| Add-ons get only what they declared | The hub enforces each add-on's declared access: the fns it may call, network hosts (through an allowlist proxy) and file permissions. | `link/grants.ts`, `link/gate.ts` and tests; Node permission model and proxy in `systems/fs/server/runner.ts`, `hosting.test.ts` | Partial: the network guard is advisory, not OS-level sandboxing (security review, Low items) |
| Blocks private network addresses | Web reads and API calls refuse local and private addresses on every redirect unless an admin allows it. | `systems/web/server/network.test.ts`, `systems/api/server/guard.test.ts` | Built |
| Hardened web app | Strict content policy, no framing, http(s)-only links, outside images load only on request. | `api/serve.ts`, `api/headers.test.ts`; `safeHref` in the SDK; ui-test `security`; `docs/plans/security-review-2026-11-21.md` | Built |
| Secrets stay encrypted | Provider keys and add-on secrets are encrypted at rest and never shown back. | AES-256-GCM `packages/hub/src/api/secrets.ts`, `secrets.test.ts`, `boot/admin-secrets.test.ts` | Built |
| Sign-in attack limits | Password tries are rate-limited per address, so guessing can't lock the owner out. | `@ayepi/rate` sign-in limits, `api/web/web.test.ts`; admin People › Sign-in | Built |

## 2. Undo, retry and compare

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Undo the last step | Undo puts back what the newest message changed: files written or edited, saved fns, session state, loaded context. | `packages/hub/src/chat/undo.ts`, `chat/undo.test.ts`; `packages/hub/context/undo.md`; ui-test `undo`; scenario 30 pass every rep | Partial: only the newest message; shell commands, outside sends and dropped tables can't be undone |
| Honest undo report | After an undo it says exactly what changed back, and what could not. | `UndoReport` (`docs/harness.md` § Sessions: "it had changed nothing" only when true) | Built |
| Retry as a true redo | Retry undoes the message and sends it again. | `docs/harness.md` § Sessions; `MessageActions.vue` | Built |
| Edit an earlier message | Editing an earlier message undoes it and everything after, then sends the edit. | `MessageActions.vue` "Edit and resend"; `context/undo.md` | Built |
| Continue where it stopped | A turn that hit its step limit or was cancelled can carry on with the conversation kept. | Continue (`docs/harness.md` § Sessions); ui-test `turn-controls` | Built |
| Stop, pause or cancel | Stop opens Pause, Resume and Cancel for the running work; a single run can be stopped by id. | `docs/harness.md` § Sessions; scenario 31 "Wait, stop" pass every rep; e2e `build3` (stopping one run) | Built |
| Compare answers side by side | Send one message to 2-4 variations (model, mode, prompt, tools) at once, watch them side by side, keep the best. | `packages/hub/src/chat/compare.ts`, `compare.test.ts`, `execution/compare-approvals.test.ts`; `CompareDialog.vue`, `CompareColumn.vue` | Built |
| Comparing can't overspend | Compared variants share one message's budget, and their changes always ask in that variant. | `docs/harness.md` § A/B compare; `compare.test.ts` | Built |
| Every version kept | Saved fns, add-on items and records keep their version history, and you can see each change. | `catalog/versions.ts`, `catalog/versions.test.ts`; `hub/item_versions`, `hub/record_versions`; `ItemHistory.vue` | Built |
| File snapshots for undo | Each file write keeps a snapshot so it can be put back (pruned by size and count). | `systems/fs/server/snapshots.ts`, fs config `snapshots` | Built |

## 3. Memory and context

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Remembers you across chats | It keeps short facts about you (for one chat, for you, or for everyone) and uses them in later chats. | `hub/remember`, `hub/forget`, `hub/memory_update`; `packages/hub/context/memory.md`; scenarios 28 "Peanut allergy, later" and 67 "We moved" pass every rep | Built |
| Recalls memories by itself | With each message the closest few memories are brought in automatically, no searching needed. | Memory recall (`docs/harness.md` § What gets added; `docs/plans/iteration-4-2026-11-25.md`); commit 97c5e80 | Built |
| See and forget memories | Ask what it knows about you, correct a memory, or forget one or all of them (it checks once first). | `context/memory.md`; scenarios 68 and 69 (68 pass every rep) | Built |
| Private memories stay private | One person's memory never shows up in another person's chat. | Visibility on memories (`access/service.ts`); scenario 44 "Keep the surprise" pass every rep | Built |
| Your own shortcuts | A request you make often can become your own `/command`. | Memory `command` (`context/memory.md`); scenario 70 "A quick word for it" pass every rep | Built |
| Finds earlier chats | "What did we decide last week" finds and quotes the right earlier chat. | `hub/sessions_list`, `hub/session_messages`, `context/earlier_chats.md`; scenarios 29 and 73 pass every rep | Built |
| Knows your local time | Every message carries your local time and time zone. | Hub additions (`docs/harness.md` § What gets added) | Built |
| Suggests the right tools | Tools and guides that fit your message are suggested (or loaded) by meaning, never twice in a chat. | `chat/suggestions.ts`, `chat/suggestions.test.ts`; `SuggestionChips.vue`, `DraftSuggestions.vue`; ui-test `suggestions`; e2e `chat`, `build3` | Partial: needs the embedding service; with it slow, nothing is suggested |
| Optional AI picks what to load | An admin can let a small decision model or an LLM choose which tools and guides to suggest or load. | "Who picks" setting, `hub/suggest_decision_set`, `models/decide.ts`, `decide.test.ts` | Built |
| Searches words and meaning | One search over tools, guides, memories and file sections, by words and by meaning together. | Hybrid vectors + BM25 with rank fusion, `store/hybrid.ts`, `index/search.ts`, `index/index.test.ts` | Built |
| Skills that bring their tools | A guide can import other guides and bring the tools it needs, so loading it sets up the whole skill. | Context imports and `fns` (`docs/harness.md` § Content); `contextor/graph.ts`, `resources/context.ts` tests | Built |
| Knowledge as a linked graph | Guides, tools and files are linked with weights the hub also learns from use; a decision model can walk the links. | `contextor/graph.ts`, `contextor/crawl.ts` and tests; `hub/ctx_crawl`; admin `/admin/graph` (ui-test `build7-graph`) | Built |
| Turn documents into knowledge | Any file or page can become context, one piece per section, kept in step with the file. | `hub/ctx_from_resource`; stable section keys (`docs/harness.md` § Content); e2e `resources` | Built |
| Fits any model's window | Every prompt is planned against the model's real window and reply size; what doesn't fit is shortened and reported, never silently cut. | Prompt planner (`contextor/planner.ts`, `contextor/limits.ts` and tests); e2e `contextor` | Built |
| See what the model will get | Ask "what would this message get?": the context, the budget and the whole prompt, without calling a model. | `previewPrompt`, `SelectionReportView.vue`; ui-test `context-graph`; `npm run prompt:render` | Built |
| Cites its sources | Optional citations: each claim gets a numbered chip that opens the exact tool result it came from. | `chat/cite-rule.ts`, `Session.citations`, `CiteChip.vue` (`docs/harness.md` § Use citations) | Built |
| Admin sees injected guidance | Admins see and switch every guide the hub adds to each agent's prompt, and its order. | `contextor/injected.ts`, `catalog/injections.ts`, `api/injections.ts` and tests; `hub/ctx_injections_list`; fn page Injected tab | Built |

## 4. Works with your stuff

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Reads and edits your files | Reads, searches, writes and edits files in folders you choose, with diffs for every change. | `systems/fs` (`fs/read`, `write`, `edit`, `list`, `glob`, `grep`, `remove`); 24 test files; e2e `chat`; scenarios 55, 58 | Built |
| Runs commands, shows changes | Runs shell commands (with approval) and lists every file each command changed, with per-file diffs. | `fs/bash`, `systems/fs/server/changes.ts`; `BashView`, `ChangeSetView.vue`; ui-test `build8-changes`; e2e `chat` (bash rerun, `cd` state) | Built |
| Many computers, one assistant | Attach the file system of several machines (laptop, desk) and the assistant picks the right one. | Fleets (`docs/harness.md` § Fleets); e2e `pairing` (two fs instances), `package` | Built |
| Searches and reads the web | Web search, readable pages (script-built ones rendered in a headless browser) and whole-site crawls kept as files. | `systems/web` (`web/search`, `web/read`, `web/crawl`), 12 test files; e2e `web`, `build4` | Opt-in (needs a Tavily key); scenarios degraded when the quota ran out |
| Talks to your databases | Connect SQLite, Postgres or SQL Server; tables become types it can query in plain words. | `systems/database`; e2e `build5` (two SQLite instances); `drivers.live.test.ts` | Built for SQLite; Postgres and SQL Server opt-in tests only |
| Your calendar, your account | Each person connects their own Google Calendar and picks which actions are on and which ask first. | `systems/google-calendar`, `server/link.test.ts`; `/connect/google-calendar` | Opt-in (never exercised in scenarios; needs a Google client) |
| Plugs into any tool server | Add any MCP server (local or remote, with sign-in): its tools, prompts and files appear in chat, with approvals. | `systems/mcp` (stdio, HTTP, SSE; bearer, headers, OAuth; shared or per person); `server/link.test.ts`, `oauth.test.ts`; e2e `build9` | Built (not in scenarios) |
| Connects to web services | Writes request fns for any web API from its OpenAPI document; each person connects their own token. | `systems/api` (`make_api`, `operations`, `test_request`); `api.test.ts`, `guard.test.ts`; e2e `build9`; `api.live.test.ts` | Built |
| Point at things with @ | Type @ to point at a file, a page or a database row; the model is told exactly what and where it is. | Mentions (`chat/mentions.ts`, `mention-search.test.ts`); ui-test `mentions`; e2e `chat` (file mentions) | Built |
| Live repository info | Messages can carry the current git branch and changed files automatically. | fs `git` hook, `systems/fs/server/git.test.ts` | Built |
| Runs Claude Code sessions | Start, watch and steer Claude Code sessions on your machines from the web app, with their permission prompts as approval cards. | `systems/claude` (`start_session`, `send`, `control`, `transcript`, `permit`), `/s/claude/sessions`; `claude.test.ts`, `fleet.test.ts` | Opt-in (real Claude only in opt-in e2e and live tests) |
| Imports Claude skills and agents | Claude Code skills, agents and MCP servers can be imported as guides, fns and tool servers. | `claude/importables`, `claude/import`; `probe.test.ts` | Opt-in |

## 5. Builds and extends itself

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Builds its own tools | Asked for a lookup or calculation, it writes a small program over its other tools, tests it and saves it as a new tool. | `systems/code` (`make_code`, kind `code/program`), `code.test.ts`; `packages/sdk/src/program/`; e2e `build9` | Built |
| Saved tools you reuse | What it builds is saved as yours, found again by meaning in later chats, and can be shared. | `hub/fns_save`, `hub/fns_search`; `packages/hub/context/saved_fns.md`; scenario 65 "Paint, again later" | Built |
| Saved database questions | A question about your data becomes a saved query it reuses next time. | `database/get_query`, `edit_query`, kind `database/query`; e2e `build5` | Partial: reuse depends on search; e2e misses on a loaded embedder |
| Ready-made table actions | For any table it can generate add, change, remove, page, count and sum tools with no AI involved. | `database/table_fns_generate`, `table-fns.test.ts` (aits `@aeye/query` `tableFns`) | Built |
| Creates tables with approval | It can create or change a database table, showing the SQL and flagging irreversible steps first. | `database/create_table`, `alter_table`; e2e `build5` (a table made through approval) | Built |
| Programs checked before running | Every program it writes is type-checked, limited in size, time and calls, and run against a sample before saving. | gin (`aits/packages/gin`: `run-control.test.ts`, `effects.test.ts`, `complexity.test.ts`); `packages/sdk/src/program/runtime.ts` | Built |
| Writes and installs add-ons | From chat, it can write a whole add-on, build it, test it, and install it after an admin approves the card. | `fs/install_system`, `systems/fs/server/hosting.ts` (`hosting.test.ts`); e2e `authoring`, `install` | Partial: works when told to; from plain requests set 3 scored 0 pass (see "Do not claim") |
| Restarts itself after changes | The file add-on can restart itself so edits to its own code go live. | `fs/restart`; e2e `restart` (fs restarting itself under the supervisor) | Built |
| Add-ons in any process | Add-ons are separate programs that connect over one socket, can run anywhere, and are picked up on reconnect. | `docs/harness.md` § Systems; `link/` in the hub; `sdk/src/server/` | Built |
| Pair a device by QR code | Start an add-on on any machine, scan its QR code with your phone, fill its settings, done. | `/pair` (`PairPage.vue`), `link/pairing.ts`, `pairing.test.ts`; ui-test `qr-pairing`; e2e `pairing` | Built |
| Install, upgrade, export | Package, install, upgrade, stop and export add-ons from the command line or chat. | `packages/cli` (`system new/build/pack/install/upgrade/export-data`); `link/packages.test.ts`; e2e `package` | Built |
| Add-on toolkit with tests | A typed SDK, a generated authoring guide and a test kit (fake hub, scripted or real models, screenshot previews). | `packages/sdk` (`AUTHORING.md`, 33 sections), `@harness/sdk/testing`, `harness test --previews`; e2e `authoring` | Built |
| Add-ons draw their own screens | Add-ons can add their own pages, result cards, inputs and file viewers to the web app. | `/s/:system/:page` (`SystemPageHost.vue`); `sdk/src/client.ts`; ui-test `renderers` | Built |
| Bring your own model provider | An add-on can supply a whole model provider (chat, embeddings, decisions); an admin reviews its prices. | Providers from systems, `models/remote.ts`, `runtime-providers.test.ts`; `systems/embedder` | Built |
| Change it by asking | Everything an admin can set (models, budgets, rules, add-ons, people) can also be done by asking in chat, with approval. | Admin hub fns (`boot/admin-fns.ts`, `admin-fns.test.ts`); `docs/harness.md` § Configuring by asking | Built |
| Live edits, no restart | Add-ons can add, change or remove tools, types and guides while running, each change versioned. | Runtime manifest changes (`docs/harness.md` build 6); e2e `install` | Built |

## 6. Data, forms and dashboards

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Keeps track of anything | Logs of spending, reading, fuel or anything else, kept as records you can correct later. | Hub data (`packages/hub/src/data/`, `data/service.test.ts`); scenarios 41, 42, 75, 78 | Built |
| Browse and edit your data | A Data page lists every kind of record with search, filters, inline edits and each record's history. | `/data`, `DataTypePage.vue`, `RecordPanel.vue`; ui-test `build8-data` | Built |
| Charts you can keep | It proposes a chart or table over your data with a live preview; press Save to keep it. | `systems/widgets` (`make_widget`, `save_widget`), `widgets.test.ts`; `/s/widgets/saved`; scenario 63 | Built (saved only when the person presses Save) |
| Twelve kinds of charts | Bars, lines, pies, calendars, timelines, finance and more, with a style picker and phone-friendly layout. | `packages/web/src/components/visuals/families/`, ECharts; ui-tests `widgets-charts`, `widget-chrome` | Built |
| Click into the numbers | Click a bar or group to see the rows behind it, with breadcrumbs back. | Drill (`database/drill_down`, aits `drill-down.test.ts`); ui-test `widget-drill` | Built |
| Filters, presets and paging | Saved views have filter chips, presets, relative dates ("last 30 days") and paging. | `WidgetChips`, `RELATIVE_DATES`, `widget-state.ts` (`build-8-widgets-design.md` § Status) | Built |
| Export charts and rows | Export a chart as PNG or SVG and the rows as CSV, including every row. | `visuals/export.ts`; `WidgetView.vue` | Built |
| Forms when it needs details | It shows a proper form (text, choices, numbers, dates, lists) when it needs several answers, and can save the form. | `systems/input` (`get_input`, `ask_*`, `save_form`), `authoring.test.ts`; scenario 64 | Partial: forms are in-chat only, not shareable links; scenario 64 weak |
| Quick questions mid-task | It can ask you one plain question while a task stays open, and carry on with your answer. | `hub/ask_user`, `context/asking.md` | Built |
| Real arithmetic over files | Sums and comparisons over CSV files and statements are worked out, not guessed. | Scenarios 66 (pass every rep), 51 (mixed), 55 | Built (scenario-proven) |
| Typed forms for every value | Every value type has a matching input and viewer in the app. | gin editors `packages/web/src/gin/`; ui-test `gin-editors` | Built |

## 7. Automation and schedules

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Runs things on a schedule | Any saved tool can run later, once or repeating (weekly, nth weekday, every other week), as you. | `systems/schedule` (`schedule/add`, kind `schedule/schedule`), 9 test files ~115 tests; scenario 62 pass every rep | Built (optional add-on; scenarios 59-61 mixed) |
| Reminders | "Remind me" becomes a schedule that notifies you. | `schedule/remind` | Built |
| Pause, skip or change | Pause until a day, skip one date, change or remove a schedule, all undoable. | `schedule/pause`, `skip`, `change`, `remove`; `server/fns.test.ts`; scenario 60 | Built |
| Calendar of what runs | A calendar page (month, week, agenda) shows past and upcoming runs, coloured by outcome. | `/s/schedule/calendar`; `client/pages.test.ts`; ui-test `schedule-pages` | Built |
| Catches up after downtime | Missed runs are handled sensibly after the machine was off, across daylight saving. | `server/timer.test.ts` "after downtime, runs the latest missed firing once within the grace window", "plans across daylight saving" | Built |
| You choose: ask or just run | At creation you can let a schedule's runs go ahead without asking; an admin's rules still win. | "Allow at creation", `hub/fns_allow_runs` yielding policy (`docs/harness.md` § The schedule system) | Built |
| Keeps working in the background | Send a new message while tools run: they move to the background and report when done. | Background runs (`docs/harness.md` § Sessions); `hub/run_status`, `run_wait`; `BackgroundStrip.vue`; scenario 49 | Built |
| Several tasks at once | Independent tool calls run in parallel; ones touching the same file wait their turn. | Parallel claims `execution/claims.ts`, `claims.test.ts`; aits `prompt-parallel-claims.test.ts` | Built |
| Honest about what it can't time | Without the schedule add-on it says plainly it can't run things later, then helps now. | `packages/hub/context/later.md`; scenarios 24, 25 (honest "not connected") pass every rep | Built |

## 8. People and sharing

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Accounts for the whole family | Several people on one hub, each with their own chats, memories, connections and data; admins and members. | Actors, roles, groups (`api/web/people.ts`, `people.test.ts`); scenario 35 "Set it up for my wife" pass every rep | Built |
| Groups | People can be put in groups that share rules, budgets and settings. | `hub/add_group`, `set_membership`; Admin › People › Groups | Built |
| Private, shared or public | Anything you make (saved tools, forms, charts, memories) is private until you share it with people or everyone. | `access/service.ts`, `access/scope.ts`, `access/hits.ts` and tests; `AccessControl.vue`, `ShareEditor.vue`; e2e `build3` (visibility) | Built |
| Shared lists | Two people can add to the same list. | Scenario 45 "A list we both add to" pass every rep | Built (scenario-proven) |
| Group chats with agents | Several people can share a chat; the agent answers only when addressed or replied to. | Sessions with participants (`docs/harness.md` § Sessions); `SessionPeople.vue`; ui-test `people` | Built |
| Sign in with your provider | Single sign-on with any OpenID Connect provider, with join rules (invite only, email domains, anyone). | `api/sso.ts`, `sso.test.ts`, `api/identities.ts`, `boot/identity.test.ts`; Admin › People › Sign-in with Test sign-in | Built |
| Turn someone off | An admin can disable a person's sign-in (signed out everywhere at once) without deleting them. | `hub/update_user`; security § Live events; scenario 48 | Built (scenario 48 weak: didn't explain how to turn it back on) |
| Per-person settings | Add-ons can declare settings an admin sets per person or group (e.g. database row rules). | Actor settings, `ActorSettingsView.vue`; ui-test `admin-actor-settings` | Built |
| Connect your own accounts | Each person connects their own logins to services, and can share a connection. | `connections/service.ts`, `api/connect.ts` and tests; `/connect/:system` | Built |
| Live updates for everyone | Every screen updates live, and each person only receives events meant for them. | Realtime over WebSocket; security review "Live events go only to the people they are for"; e2e `chat` (second browser) | Built |

## 9. Models and cost

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Use any model | OpenRouter (hundreds of models), OpenAI and compatible servers, Amazon Bedrock and local Ollama. | `packages/hub/src/execution/providers.ts`, `providers.test.ts`; aits `@aeye/openrouter`, `@aeye/aws`, `@aeye/ollama` | Built (no direct Anthropic API; Claude via OpenRouter or Bedrock) |
| Pick the model per chat | Each chat (or agent) has its own model, chosen from a picker. | `ModelPicker.vue`; ui-test `model-picker` | Built |
| Runs local models for you | Installs Ollama (checksum-verified), starts it, pulls models and offers chosen ones in the picker. | `systems/ollama` (`install`, `start`, `pull`, `remove`), `install.test.ts`, `serve.test.ts`; `/s/ollama/servers` | Built (tested with fakes; nothing real installed in tests) |
| Small-model mode | A cheaper mode with a fixed small toolset that also works on models without native tool calling. | Static chat mode `contextor/modes.ts`, `modes.test.ts`; e2e `contextor` (static toolset on a free model) | Built |
| Tools shaped for each model | One tool definition is rewritten to each provider's exact schema rules and limits, so requests are never rejected. | aits `@aeye/schema` profiles (`src/profile.ts`), `request-degrade.test.ts` "a request is always sendable"; harness: every model-facing schema (commit 4c98a73) | Built |
| Calm about model slips | A model's bad tool call is sent back to fix ("Thinking harder"), never shown as an error; messages say exactly what was wrong. | Invalid input (`docs/harness.md` § Invalid input); `conciseIssues`; ui-test `invalid-input`; e2e `runs` | Built |
| Spending limits everywhere | Budgets per hub, group, person, chat, message, add-on, tool or model, over a window or all time. | `execution/ledger.ts`, `limits.ts` and tests; `hub/set_budget`; `LimitsView.vue`; scenarios 71, 72 pass every rep | Built |
| Budget meter and raise | Each chat shows a live budget meter; hitting a limit can wait, refuse, or ask to raise it. | `BudgetMeter.vue`, `BudgetCard.vue`; ui-test `budget` | Built |
| Priority for live chats | Interactive chat is served before background work; priority set at every level. | `@ayepi/work` priority queue, `execution/queues.ts`; `hub/set_priority` | Built |
| Models for each job | Separate models for describing images, reading text in them, transcribing, dictation, speech and yes/no decisions. | Model roles `models/roles.ts`, `roles.test.ts`; ui-test `model-roles` | Built |
| Pictures for blind models | A model that can't see images asks a vision model questions about them instead. | `hub/image_read`, `chat/shown.ts`, `resources/images.test.ts`; `context/images.md` | Built |
| Stops runaway output | A tool call that streams thousands of blank characters is cut off and retried. | `execution/stream-guard.ts`, `stream-guard.test.ts` | Built |
| Shows cache misses | A chat call that missed the provider's prompt cache is marked, and the prompt's fixed part is kept stable so caching holds. | `chat/cache.ts`, `cache.test.ts` | Partial: the hub sets no explicit cache breakpoints (aits supports them; harness doesn't use them) |
| Cost of every call | Each answer shows its tokens, cost, model and timing. | Message details; ui-test `message-details`; aits `cost.test.ts` | Built (scenario 37 "what have I spent" weak: the agent doesn't report it well in chat) |

## 10. Files, pictures and documents

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Reads PDFs, sheets and photos | Attach a PDF, spreadsheet, document or photo and it reads it in one call. | `context/attached_files.md`, `resources/reader.ts`, `converters.ts`; scenarios 15, 16, 54 pass every rep | Built |
| Reads scanned pages | Scanned PDF pages are turned into pictures and read by a vision model. | `resources/pdf-pages.ts`, `pdf-pages.test.ts` (iteration 7) | Partial: fixed in iteration 7, seen only in a 1-rep smoke; some page encodings have no picture |
| Keeps the original and copies | Every file keeps its raw bytes plus converted forms (markdown, tables, page text, image description, transcript). | Raw content and forms (`docs/harness.md` § Raw content); e2e `resources` (a page, a workbook and a pdf) | Built |
| Viewer for every file type | Images (zoom), code with highlighting, markdown with diagrams, tables, PDFs, audio/video, JSON trees. | `packages/web/src/resources/viewers/`; ui-test `viewers` | Built |
| A file browser | Browse files as a list, thumbnails or groups (type, source, folder, date), with bulk actions. | `/resources` (`ResourcesPage.vue`); ui-test `resource-browser` | Built |
| Live file explorer | Browse a connected machine's folders live from the web app. | `/explore/…` (`ExplorePage.vue`), `hub/explore_*`; ui-test `build6-screens` | Built |
| Upload by drop or paste | Drop files, paste images or paste a web address; upload shows progress. | `Composer.vue`, `FileChips.vue`; ui-test `uploads` | Built |
| Search pictures by meaning | With a suitable embedding model, pictures are indexed and found by text or by another picture. | Image vector space (`docs/harness.md` § Content), `index/images.test.ts` | Partial: off unless an image-capable embedder is set |
| Renames files by content | It can read scans and rename them by what they say. | Scenario 57 (weak before iteration 7, pass 9 in fix7-smoke) | Partial (one smoke run) |

## 11. See everything, test everything

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Watch every step live | Every tool call shows as a live card with progress, and a turn opens as a tree of every call and model call. | `RunCard.vue`, `TurnTree.vue`; ui-tests `run-cards`, `live-runs`, `turn-tree`, `drawer-live`; e2e `chat` | Built |
| Every model call recorded | Every model call (chat, embeddings, images, speech, decisions) is kept with its full request, response, cost and timing. | Model call records (`docs/harness.md` § Every model call is recorded); admin `LlmCallsView.vue`, `ModelCallsView.vue`; e2e `runs` | Built |
| Reasoning shown, folded | The model's reasoning is shown where it happened, folded away. | `ReasoningBlock.vue`; ui-test `reasoning` | Built |
| Tool health stats | Failure rate, typical duration and cost per tool over 7, 30 or 90 days. | `metrics/fn-metrics.ts`, `rollup.ts` and tests; `hub/fns_metrics`; ui-test `fn-metrics` | Built |
| The assistant can read it too | Everything a person can see in the app (runs, costs, files, settings) the assistant can read through tools. | Hub read fns (`boot/read-fns.ts`, `read-fns.test.ts`); `docs/harness.md` § The LLM can see and do everything | Built |
| Map of everything | An admin graph of every add-on, tool, guide and type and how they connect. | `/admin/graph`, `packages/hub/src/graph/`, `hub/graph`; ui-test `build7-graph` | Built |
| Tested by a simulated family | An 84-case bench where an AI "person" makes everyday requests and a judge scores the results. | `scripts/scenarios/` (`run.ts`, `person.ts`, `judge.ts`, `checks.ts`, `household.ts`) | Built |
| Every screen tested at four sizes | Each UI feature has a browser test at desktop, laptop, tablet and phone, checked for overlap and errors. | `ui-tests/features/` (~75 scripts, ~220 checks); `npm run gallery` | Built |
| Whole-stack end-to-end tests | Sixteen e2e suites drive the real stack with a real model. | `e2e/*.e2e.test.ts` | Built (some suites fail on a loaded embedder or free-model quota) |
| Crash recovery | Add-ons are supervised and restarted with backoff, and stopped after too many crashes. | `link/supervisor.ts`, `supervisor.test.ts`; `systems/fs/server/runner.test.ts` | Built |
| A stable build to live on | `npm run live` runs a frozen build of the hub that code edits can't disturb. | `scripts/live.ts`; README § Running a stable stack | Built |
| Offline-safe delivery | Messages to add-ons are queued and delivered when they reconnect. | `chat/deliveries.ts`, `deliveries.test.ts` | Built |

## 12. Where you use it

| Label | What it means | Evidence | Status |
|---|---|---|---|
| Works great on phones | One web app that fits phones, tablets and desktops; no sideways scrolling at any size. | `AppShell.vue`, `AppTopBar.vue`; ui-test `responsive` | Built |
| Installs as an app on phones | Add to Home Screen on iPhone and iPad, Install app on Android: its own name, icon and full-screen window; an Install app item where the browser allows, and a short how-to on iPhone. | `/manifest.webmanifest` (`api/serve.ts` `webManifest`, `serve.test.ts`), `state/install.ts` (`install.test.ts`), `InstallCard.vue`, `InstallSheet.vue`; browser test `e2e/installable.browser.test.ts` (Chrome: no installability errors over https) | Built (no offline use: see "Do not claim" 7) |
| Installs as a desktop app | Install app in Chrome and Edge (Add to Dock in Safari): its own window and title bar, dock or Start-menu icon, shortcuts to a new chat and the inbox; links to other sites open in the browser. | `webManifest` (`display_override` window-controls-overlay, shortcuts, screenshots), `AppShell.vue` title bar, `app/standalone.ts` (`standalone.test.ts`); browser test `installable` | Built (a web app, not a store download) |
| Secure address with no setup | The hub answers https as well as http on its port with a certificate it makes for itself; a phone trusts it once (a QR code, then a few taps), so the app installs and notifications work there. A real certificate (Tailscale, mkcert) can be used instead. | `api/tls.ts` (`tls.test.ts`), `api/dual.ts` (`dual.test.ts`), `api/https.ts` (`https.test.ts`), `/harness-ca.crt`, Settings › App `PhoneCard.vue`, Settings › Hub switch; browser test `installable` | Built |
| A page when the hub is out of reach | The installed app shows "Can't reach your hub" with Try again instead of the browser's error. | `sw/sw.ts`, `public/offline.html`, `state/offline.ts` (`install.test.ts`); browser test `installable` | Built (a fallback page only) |
| Phone notifications | Push notifications for approvals, replies, finished answers, budgets and schedule results. | `api/push.ts`, `push.test.ts`, `chat/notifications.ts`; `sw/sw.ts` | Built |
| An inbox for everything | One inbox of what needs you; approvals answered right there. | `/inbox` (`InboxPage.vue`); ui-test `inbox` | Built |
| Speak instead of type | Dictation in the composer (a transcription model or the browser's own). | Dictate button `Composer.vue`; dictation role | Built (shown only when configured) |
| Self-hosted, your data | Runs on your own machine; everything is kept in one local database. | SQLite store + sqlite-vec (`docs/harness.md` § Storage); README § Running it | Built |
| Use it from other AI apps | An admin can expose chosen parts of the hub as an MCP endpoint other AI apps connect to. | Hub MCPs `packages/hub/src/mcp/endpoints.ts`, `scopes.ts`, `mcp.test.ts`; `harness mcp <slug>`; e2e `mcp`; ui-test `hub-mcps` | Built |
| Command line for add-ons | A CLI to make, build, pack, install and manage add-ons. | `packages/cli/src/cli.ts` | Built |
| Name your hub | An admin sets the hub's name, used in the title and installed app. | `boot/identity.ts` | Built |
| Light and dark themes | Follows the device or a pinned choice, contrast-checked. | `state/theme.ts`, `ThemePicker.vue`; ui-test `themes` | Built |
| Keyboard and accessibility | Keyboard shortcuts (press ?), reduced motion, accessibility checks. | `ShortcutsDialog.vue`; ui-tests `shortcuts`, `accessibility`, `motion` | Built |
| Every view has a link | Every page, panel, filter and tab is in the URL, so links can be shared and refresh keeps your place. | `packages/web/src/app/routes.ts`; ui-tests `url-state`, `url-reload` | Built |

---

## Headline features per category (for the matrix)

"Rare?" is a **hypothesis for the competitor research** (OpenCode, Claude Code / Claude apps, OpenClaw-style personal
agents, Codex CLI / Gemini CLI, Open WebUI) to confirm or reject. It is not a claim.

| Category | Headline features | Rare? (hypothesis) |
|---|---|---|
| 1. Safety and control | Asks before risky actions; Previews before you approve; Choose how much it may do; Guards secret files; Who approves is configurable; Admin reviews every add-on | Configurable approvers (a group, an AI judge) and per-add-on review are likely rare; approvals and modes are common in coding CLIs |
| 2. Undo, retry and compare | Undo the last step; Honest undo report; Compare answers side by side; Continue where it stopped; Every version kept | Side-by-side compare inside a live chat with shared budget is likely rare; undo of real changes beyond file checkpoints likely rare |
| 3. Memory and context | Remembers you across chats; Recalls memories by itself; Private memories stay private; Finds earlier chats; Fits any model's window; Cites its sources | Per-person private memory in a multi-user hub and citations that open the exact tool result are likely rare |
| 4. Works with your stuff | Reads and edits your files; Runs commands, shows changes; Talks to your databases; Plugs into any tool server; Many computers, one assistant; Runs Claude Code sessions | One assistant over several machines and managing Claude Code sessions from a web app are likely rare; files, web, MCP are common |
| 5. Builds and extends itself | Builds its own tools; Saved tools you reuse; Writes and installs add-ons; Pair a device by QR code; Change it by asking | Saved, checked, reusable tools made in chat and self-installed add-ons are likely rare |
| 6. Data, forms and dashboards | Keeps track of anything; Charts you can keep; Click into the numbers; Forms when it needs details; Browse and edit your data | Kept, live charts over your own data and in-chat forms are likely rare in agent tools |
| 7. Automation and schedules | Runs things on a schedule; Calendar of what runs; Catches up after downtime; Keeps working in the background | Scheduling exists in some personal agents; a calendar of runs with approvals per schedule is likely rare |
| 8. People and sharing | Accounts for the whole family; Private, shared or public; Group chats with agents; Sign in with your provider; Connect your own accounts | Multi-user is common in Open WebUI, rare in CLIs; per-item sharing of tools and charts likely rare |
| 9. Models and cost | Use any model; Runs local models for you; Small-model mode; Tools shaped for each model; Spending limits everywhere | Layered budgets (person, group, chat, message) and per-model schema shaping are likely rare |
| 10. Files, pictures and documents | Reads PDFs, sheets and photos; Viewer for every file type; Pictures for blind models; Keeps the original and copies | A blind model asking a vision model about images is likely rare |
| 11. See everything, test everything | Watch every step live; Every model call recorded; Tool health stats; Tested by a simulated family | Full recorded call trees and a simulated-household test bench are likely rare |
| 12. Where you use it | Works great on phones; Installs as an app on phones and desktops; Secure address with no setup; Phone notifications; An inbox for everything; Self-hosted, your data; Use it from other AI apps | Phone-first web app with push for approvals likely rare among CLIs; common for Open WebUI-style apps |

---

## Do not claim (half-built, broken or unproven)

Evidence for each is in `docs/plans/` and `.harness-test/scenarios/`.

1. **"Builds its own add-ons when you ask in plain words."** Set 3 (cases 81-84) latest run scored 0 pass / 3 weak /
   1 fail; "with plain words the model still never reaches for writing a system" (`docs/plans/scenarios-3-2026-11-26.md:229-232`).
   It works only when told to, and only on a hub with a harness checkout (`:95-104`). Case 19 (a small game) weak in every rep.
2. **"Restrict a child's account by chat."** Scenario 46 still fails after iteration 7 (the agent deleted files from the
   parent's folder in the child's chat); Phil set child accounts aside (`iteration-7-2026-11-26.md:9`). Scenario 47's agent
   disabled accounts unasked in one rep. Admin-by-chat changes to people are not proven safe.
3. **"Undo anything."** Only the newest message can be undone (`iteration-4-2026-11-25.md:142-146`); shell commands,
   outside sends and dropped tables can't be undone.
4. **"Reliable live web answers."** Web search needs a paid Tavily key; weather, prices and events cases (1, 10, 12, 21,
   27) degraded when the quota ran out.
5. **"Reports what you've spent" in chat.** Scenario 37 weak or fail in every iteration (costs are shown per message and
   on admin pages; the agent answering the question is the weak part).
6. **"Shareable forms / sign-up sheets."** Forms appear in the chat only (`iteration-7-2026-11-26.md:141`); scenario 64
   weak in every rep.
7. **"Works offline."** The app installs on desktop and phones, but without the hub it shows only a "Can't reach your hub" page: the service worker caches that page and nothing else, by design (never stale data). Nothing can be read or done offline (`packages/web/sw/sw.ts`).
8. **"Runs on a 2k-token local model."** `hub/chat_small` still doesn't fit a 2,048-token window
   (`scripts/chat-small-fit.test.ts` is an expected failure; `iteration-7-2026-11-26.md:179-180`). Say "local models"
   without the tiny-window claim.
9. **"Sandboxed add-ons."** Grants are enforced by the hub, but the network guard and child proxy are advisory, not
   OS-enforced; the security review has open items (H6 planted git textconv, M7 hub not proving itself to systems, ws://
   by default, token in the WS URL) (`security-review-2026-11-21.md:103-134`).
10. **Prompt caching as a cost feature.** The hub detects misses and keeps the prompt stable but sets no cache
    breakpoints itself.
11. **Calendar, MCP and Claude Code "proven in daily use".** Unit- and e2e-tested, but never exercised in the scenario
    bench; the calendar ran only on its "not connected" path; the real Claude test is opt-in.
12. **Postgres and SQL Server** are covered only by an env-gated live test.
13. **Dashboards, bulk row actions, brush filters, auto-refresh of record views**: "later, nothing built"
    (`build-8-widgets-design.md` § 4). Add-ons can't yet ship their own chart types in practice (the path exists; none does).
14. **Message branching**: there is Edit-and-resend (which undoes later turns), not a branch switcher.
15. **Direct Anthropic API**: no native provider; Claude models come through OpenRouter or Bedrock.
16. **Overall reliability numbers**: the everyday bench sits at about 60% "pass" with most of the rest "weak" (set 1
    iter-5: 71/47/2 of 120; set 2: 75/37/7); iteration 7's fixes were checked only in a 7-case smoke. Don't quote a
    success rate without these figures.
17. **Copy fix, not a feature gap**: `hub/configure_provider`'s description omits Bedrock although Bedrock works
    (`packages/sdk/src/hub.ts:438`).

Not features: `systems/template` (a scaffold of TODOs) and `systems/random` (a one-fn demo).

**Total: 151 feature rows in 12 categories** (Safety 19, Undo 10, Memory 17, Your stuff 12, Builds 16, Data 11,
Automation 9, People 10, Models 14, Files 9, See and test 12, Where 12).
