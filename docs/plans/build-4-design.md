# Build 4 design (binding)

Spec: [build-4.md](build-4.md). The contracts are in `@harness/core` now and typecheck is green. The new web endpoints
answer 501 from `packages/hub/src/api/web/build4.ts`, and the new system-link endpoints are stubbed in
`sdk/src/server/runtime.ts` (`buildFourStub`; `validate` answers `{ ok: true }`). The lanes replace both.

## Lanes

| Lane | Owns |
|---|---|
| **platform** | `aits` (`@aeye/aws` Bedrock API key; runtime-added providers if `@aeye/ai` lacks them; rebuild dist), `packages/sdk/**`, `systems/**` (web crawl, new `google-calendar`, new `input`), `scripts/` (dev stack pairs the new systems when configured) |
| **hub** | `packages/hub/**` (replace `api/web/build4.ts` freely), `e2e/**`. It also owns these core edits: joining `awsProviderVariant` into `providerVariants` (and the `aws` line in `core.test.ts`), and removing the legacy list filters |
| **web** | `packages/web/**`, `ui-tests/**` |

Ask the design lane for any other core change in your report.

## Shared contracts (done, in core)

| File | What |
|---|---|
| `access.ts` | `Visibility` (`private`/`shared`/`public`) with labels, `Sharing` (`owner`, `visibility`, `with`), `ShareRule` (no owner), `AccessTarget` (system, fn, context, root, connection), `accessKey`, `AccessRecord` (table `access`), `AccessView`, `AccessInfo` (`multiUser`) |
| `connections.ts` | `ConnectDecl` (manifest `connect`: page title, `how` = oauth or form, per-person `settings` type, `fns` with default `{ on, ask }`), `UserConnection` (table `connections`), `ConnectionView`, `ConnectPage`, `RunConnection` (`RunRequest.connection`), link shapes `ConnectStart`, `ConnectFinish`, `ConnectResult`, `ConnectionUpdate`, web `ConnectionChange`; id kind `connection` (`cnx_`) |
| `system-providers.ts` | `SystemProviderDecl` / `ProviderModelDecl` / `TokenPricing` (manifest `providers`), link shapes `ProviderChat`, `ProviderChunk`, `ProviderEmbed`, `ProviderEmbedResult`, and `awsProviderVariant(secret)` (region, auth `keys` or `apiKey`, `profilePrefix`) |
| `validation.ts` | `FnValidation` (`FnDecl.validate`), `InputVerdict`, `OutputVerdict` (`retry` or `stop`), `ValidateRequest` (by phase), `ValidateAnswer` |
| `pickers.ts` | `PickSource` (fn, context, system, person, group, model, resource, type, kind), `PickQuery` (`text`, or `values` to label chips), `PickOption` |
| `model-calls.ts` | `CacheSupport` (`yes`/`no`/`unknown`), `ChatUnits.caching` |
| `records/chat.ts` | `MessagePart` `input-answer` (`run`, `title`, `value`, `text`; also in `OutgoingPart`), `INPUT_ANSWER_TAG`, `ChatMessage.cacheMiss` (`call`, `at`) |
| `resource-forms.ts` | `ResourceImportArgs` URL variant `folder` (one root per crawl) |
| `manifest.ts` | `FnDecl.validate`, `Manifest.providers`, `Manifest.connect` (all optional). `LocalName` moved to `primitives.ts` |
| `link.ts` | system link: `validate` (`vl`), `providerChat` (`pc`, streams `ProviderChunk`), `providerEmbed` (`pe`), `connectStart` (`cs`), `connectFinish` (`cn`), `disconnect` (`dc`); hub link: `connectionUpdate` (`cu`); `RunRequest.connection` |
| `web.ts` | `accessSlice` (`accessInfo`, `access`, `setAccess`), `connectionsSlice` (`connectPages`, `connect`, `updateConnection`, `disconnect`), `pickerSlice` (`pick`) |
| tables | `access` (by `key`), `connections` (by `id`) |

## Per item

1. **Cache-miss line.** What exists: `ChatUnits.cached` is recorded per call. Changes:
   - **hub** (`models/`, `execution/` model call recording): fill `caching` from the aeye model info. It is `yes` when the model has cached-input pricing or a cache capability, `no` when the info says it has neither, and `unknown` when there is no info.
   - **hub** (`chat/turns.ts`): when an assistant message settles, set `cacheMiss` if all of these hold: the session's contextor sends the whole transcript (`plain` or `suggest`, not `graph`), this call has `caching: 'yes'` and read 0 cached tokens, and an earlier chat call in the same session read more than 0. Use the message's first call only.
   - **web**: `chat/components/CacheMissRule.vue` draws a wavy SVG rule across the thread above that message. Its label is the time, plus the date when it isn't today (the existing date formatters). Its tooltip reads "The model re-read the whole chat (no cache hit)". Add a component test.
2. **Systems add aeye providers.** What exists: the SDK's `HarnessProvider` forwards a system's own calls to the hub. Changes:
   - **platform**: an SDK `provider()` builder in the contract (`with({ providers })`) that the manifest writes as `Manifest.providers`. The server side takes an aeye `Provider` per declared provider, serves `providerChat` (streaming) and `providerEmbed` with it, and fails a declared model the provider doesn't serve.
   - **hub** (`models/`): a `RemoteProvider implements` aeye `Provider` for each declared provider, registered as `<system>/<name>` while the system is connected and dropped when it isn't. It prices calls from `pricing` and records each as a `ModelCall` with `system` set.
   - **platform** (aits): if `@aeye/ai` can't add or remove a provider on a live `AI`, add that on aits's `harness` branch.
   - Test with the template system declaring a fake provider (unit plus one API-level test).
3. **AWS provider.** What exists: `@aeye/aws` (Converse, tools, streaming, images, Titan embeddings, cache points, key-pair credentials). Changes:
   - **platform** (aits): add a Bedrock API key option (`apiKey`, sent as `Authorization: Bearer` through the SDK's bearer auth scheme), with unit tests on recorded or fake responses. Add a `*.live.test` that is skipped without `AWS_*` / `AWS_BEARER_TOKEN_BEDROCK`. Rebuild dist and update `aeye-aws.md`.
   - **hub**: join `awsProviderVariant(secret)` into `providerVariants` and add the `aws` case to `execution/providers.ts` (the keys or the API key revealed from secrets). Update the core test that expects `aws` to be refused.
   - **web**: the provider form shows the AWS variant: region, a segmented choice between "Access keys" and "API key", and the secret fields.
4. **Web system feeds resources.** What exists: `web/read` imports a page through `hub/resource_import` (the raw content plus its markdown form), so it is already a resource. Changes:
   - **hub** (`resources/library.ts`): honor `folder` by putting the page under the hub's web imports at that folder. The folder is a root that the resource browser, context and search see, and an `AccessTarget` `root`.
   - **platform** (`systems/web`): a `crawl` fn. Its args are `url`, `depth` (default 1, max 3), `sameSite` (default true), `maxPages` (default 25, capped by an env tunable), and `include`/`exclude` globs. It reads robots.txt through the existing guard, sends progress per page, imports every page with `folder: crawls/<host>-<yyyymmdd-hhmm>`, and returns the root URI, the page count and the skipped pages with reasons. Unit tests run against a fake site.
5. **Visibility (the general part).**
   - **hub**: a new `access/` module.
     - `AccessService` gives a target's sharing (no row means `public`, owned by whoever added it), `canSee(actor, target)` and list filters.
     - It applies to the catalog and fn calls (a hidden fn is unavailable to that person), query list sources, suggestions and the graph contextor, context, resource roots, mentions, `pick` and connections.
     - Admins see everything. `multiUser` is true when there is more than one user actor.
     - It serves `accessSlice`.
   - **web**: one `ui/UiVisibility.vue` (segmented private/shared/public, with a people-and-groups picker for shared). It shows only when `accessInfo.multiUser`, on the system page, the fn page, a context item, a resource root and a connection.
6. **Google Calendar system.** New pieces:
   - **platform**: `systems/google-calendar`.
     - Its admin config is the OAuth client: client id, client secret, and the hub's public URL (the redirect is `<hub>/connect/callback`).
     - It declares `connect`: `how: oauth`, settings `{ calendars, defaultCalendar }`, and fns `list_events`, `search_events` and `get_event` (`{ on, ask: false }`), `create_event` and `update_event` (`{ on, ask: true }`), `delete_event` (`{ on: false, ask: true }`).
     - It calls Google through a `GoogleApi` interface, with `FetchGoogleApi` for real use and `FakeGoogleApi` for tests. It refreshes tokens and sends `connectionUpdate`.
     - A live test is skipped without Google keys.
   - **hub**: a `connections/` module, `ConnectionService`.
     - `connect` makes a pending row, signs `state` (the connection plus a nonce), calls `connectStart` and returns the URL. A form flow calls `connectFinish` directly.
     - A plain GET route `/connect/callback` checks the state, calls `connectFinish`, stores the credentials as a secret owned by the person, and redirects to `/connect/<system>`.
     - The catalog marks `connect.fns` unavailable to people with no usable connection, and leaves out a fn that is switched off.
     - For a fn with `ask` on, the run must be approved through the existing approvals.
     - Runs carry `RunRequest.connection`: the caller's own connection, else the newest one shared with them.
     - `disconnect` calls the system's `disconnect`, then deletes the secret.
   - **web**: one page per `ConnectPage` at `/connect/:system`, with a nav entry for every person. It has a connect button, the account, the settings (gin value editor), a table of fn switches (on, ask first) and sharing (multi-user only). Before the admin has configured the system, the page says so.
7. **Input system and kind.** New pieces:
   - **platform**: `systems/input`.
     - It has a kind `input/form` whose payload is `{ title, description, type: GinTypeDef, submit? }`, with no deps or refs.
     - `get_input(detailedDescription)` first looks for a saved `input/form` fn: hub search over fns, plus a name match, reused above an env threshold. Otherwise an agent writes a gin type (`ctx.llm` with the gin authoring context), checked by gin's registry, with at most 2 retries.
     - There are simple fns `ask_text`, `ask_choice`, `ask_confirm`, `ask_number` and `ask_date`.
     - Every input fn returns the form and its instructions tell the model to end its turn and wait.
     - `save_form({ name, description, form, visibility })` adds a runtime fn of kind `input/form` (a manifest patch) and sets its access.
     - Its client renderer draws the form with the gin value editor. Submitting sends one `input-answer` part, whose `text` is the labels and values as `key: value` lines. Under the form is "Save this form for next time" (name, description and, in multi-user hubs, visibility), and after submitting it shows "Answered" with the values.
   - **hub**: the LLM reads an `input-answer` as `<input-answer title="…">text</input-answer>`.
   - **web**: a user message whose parts are all hidden (`input-answer`, `extra`, `hook`) and that has no files is not shown. The chat menu has a "Debug" toggle, kept in the URL as `?debug=1`, that shows such messages and the hidden parts.
8. **Fn validation hooks.**
   - **platform** (SDK): `fn({ validate: { input(ctx, args, state), output(ctx, args, result, state) } })` sets `FnDecl.validate`, and the runtime serves `validate`.
   - **hub** (`execution/`): when `decl.validate.input` is set, call `validate` before dispatch.
     - A refusal settles the run as `invalid-input` with the reason.
     - The model reads it as "Not available now: <reason>". It doesn't count as a failure in metrics.
     - Use aeye's tool `validate` hook in `tools.ts` where the agent loop parses args, so the refusal goes back as a tool result.
   - **hub** (`execution/`): when `decl.validate.output` is set, call `validate` after a `done` run.
     - `retry` gives the model "The result was refused: <reason>. Try again." Retries are capped by an env tunable (default 2); after that the run stops.
     - `stop` fails the run with the reason, shows it to the person, and ends the turn.
     - Unit tests use the fake system.
9. **Pickers.**
   - **hub**: serve `pick` per source (catalog, context, systems, actors, models, resources, types, kinds), filtered by access. `values` returns those values, with `missing` set for the ones that resolve to nothing.
   - **web**: one `ui/UiPicker.vue` (single or multi; chips; search as you type, debounced; arrows, Enter, Backspace to remove a chip, Esc), with its caller and store in separate files. It is tested with component tests.
     - It replaces the Context Advanced inputs `fns`, `suggestFns`, `alwaysFor`, `imports` and `parent` (`ContextPage.vue`, `MemoryDialog.vue`) and the comma lists in `McpDialog.vue`.
     - Search `packages/web/src` for every other text input that names fns, systems, context, people, models, resources or types (comma splits, free text in policy, budget, role and limit editors) and switch it to the picker.
     - Tags stay a free-text chip input.

## Carry-overs

- **Expression editor** (web, `gin/GinExprView.vue`, `components/GinExprNode.vue`, `logic/expr.ts`): make it read as code. One statement per line, args inline and wrapped only past about 80 columns, no labels where position says it, monospace. Layout logic gets unit tests; take one shot at each size.
- **Legacy list filters**:
  - Web stops sending them, if any remain.
  - Then hub removes them from the list bodies in core (`SessionListQuery.search`, `ContextQuery.search/origin/system`, `ModelCallFilter`, `RunFilter`, `LlmFilter`, `ResourceFilter` and similar, keeping whatever `ListQuery` can't express) and from its handlers.
  - Typecheck finds the callers.
- **Partial flag** (web): every list shows "More rows than scanned; narrow the filters" when `partial` is set.
- **Ollama model** (hub, e2e): `ollama pull qwen2.5:3b` (pulling doesn't restart the server), then point the contextor e2e at it.

## Order

1. Platform: the aits API key and live providers first (hub item 2 waits on them), then the SDK hooks and providers, then the input, web-crawl and calendar systems.
2. Hub: access, then connections and pick, then validation, the cache miss and providers.
3. Web: picker and visibility, then the connect page, the input form, the cache line and debug, then the carry-overs. Work against the mock hub until the hub endpoints land.
