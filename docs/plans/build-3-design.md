# Build 3 design (binding)

Spec: [build-3.md](build-3.md). Contracts are in `@harness/core` now (typecheck green); new endpoints are stubbed with
501 in `packages/hub/src/api/web/build3.ts` and `context.ts` (`updateMemory`) for the hub lane to replace.

## Lanes

| Lane | Owns |
|---|---|
| **platform** | `ayepi` (client `unauthorized` hook, `wsTransport.reconnect()`, tests, md docs; rebuild dist), `packages/sdk/**` (auto-pair storage, `hub/query` fn), `systems/fs/**` (secret exclusion), `scripts/` gallery script |
| **hub** | `packages/hub/**` except `api/web/build3.ts`'s file header (replace freely) |
| **web** | `packages/web/**`, `ui-tests/**` |

Core changes go through the design lane (this doc's owner); ask in your report.

## Shared contracts (done, in core)

| File | What |
|---|---|
| `query.ts` | `ListQuery` (`text`, `filters`, `sort`, `cursor`, `limit`), `Filter` (op-discriminated), `FIELD_TYPES`, `FILTER_OPS`, `OPS_BY_TYPE`, `OP_LABELS`, `FieldDecl`, `LIST_FIELDS` (per list: fields + `defaultSort`), `ListName`, `ListField<L>`, `fieldOf`, `sortOf`, `queryProblems`, `ListValuesQuery`, `FieldValueOption`, `QueryFnArgs`, `QueryFnResult` |
| `suggestions.ts` | `SuggestionRecord` (`by`, `threshold`, `call`, `items: SuggestionOutcome[]`), `SkipReason` + `SKIP_REASON_LABELS`, `SuggestDecision` (off by default; needs `model` when on), `SuggestDecisionView`, `HubOption` (table `hubOptions`) |
| `auto-pair.ts` | `AutoPairChoice` (`expiresIn`, `null` = never), `AutoPairGrant` (in `Welcome`), `AutoPairProof` (in `Hello`), `AutoPairSecret` (table `autoPairSecrets`, hashes only), `AutoPairView`; id kind `autoPair` (`apk_`) |
| `context-graph.ts` | `ContextOptions` (weight, summary, tags, tied `fns`, `suggestFns`, `alwaysFor`, `command`, `visible`, `suggest`, `parent`); `RememberArgs` and `ContextFromResourceArgs` extend it; `UpdateMemoryArgs` |
| `records/chat.ts` | `ChatMessage.suggestions?`, `ControllableRun`, `SessionControls.runs?` |
| `web.ts` | `query: ListQuery.optional()` on every list body (sessions, notifications, runs, llmCalls, resources, browseResources, contexts, modelCalls, systems); `control.runs?`; `approvePairing.autoPair?`, `createPairingToken.autoPair?`; `contextSlice.updateMemory`; new `querySlice` (`query`, `listValues`, admin `fns`), `suggestionsSlice` (`suggestDecision`, `setSuggestDecision`, `previewSuggestions`), `autoPairSlice` (`autoPairs`, `revokeAutoPair`) |
| hub `query/index.ts` | `ListSource`, `FieldAccessors`, `QueryService` interfaces |

The legacy narrow filters on list bodies (`search`, `status`, `system`, …) stay this build; when `query` is present it
wins and the legacy fields are ignored. The web lane moves every list to `query`; build 4 removes the legacy fields.

## Per item

1. **Exact cost** — exists: `formatCost` in `web/src/chat/logic/format.ts` prints `<$0.01`. Change: show 2 significant
   digits below a cent (`$0.00042`), `$0` for zero, cents above. One formatter, all callers already use it. **web.**
2. **Suggestions below the user message** — exists: `chat/enrich.ts` adds `extra` parts (`suggested-context`,
   `suggested-fns`) that the LLM sees; `SuggestionChips.vue` shows them. Change: hub writes `ChatMessage.suggestions`
   (every candidate it looked at, used or not, with `SkipReason`; graph sessions record the graph selection with
   `by: 'graph'` and `budget`/`below-threshold` for what it dropped) while the extra parts stay what the LLM reads.
   Web: `UserMessage.vue` shows a small icon row (context icon + count, fn icon + count) only when any were used; a
   popover lists used and not used with reason and score. **hub** (`chat/enrich.ts`, `contextor/`), **web**.
3. **Stop / pause / resume per fn** — exists: `chat.control` over all runs (`chat/sessions.ts`), `RunService.pause`
   and `resume`. Change: hub fills `SessionControls.runs` (each active or paused run, what it allows) and applies
   `control` to `runs` when given, all otherwise. Web: the stop/pause control becomes a split button whose menu lists
   the running fns with checkboxes and "All". **hub**, **web**.
4. **Decision model** — new. Hub: an `index/` `SuggestionDecider` reading `hubOptions['suggestDecision']`; when on,
   sends the last `messages` user messages and up to `candidates` candidates scoring ≥ `floor` to `model` (through the
   model gateway, so it is a `ModelCall` with cost, linked in `SuggestionRecord.call`), asks for JSON picks with a
   reason each (zod-checked, at most `cap`); on failure the score decides and items get `failed`. Implements
   `suggestionsSlice`. Web: an admin card (Models or a new "Suggestions" tab) to set it and try `previewSuggestions`.
   **hub**, **web**.
5. **Expression editor / viewer** — exists: `web/src/gin/GinExprView.vue`, `components/GinExprNode.vue`,
   `logic/expr.ts`. Change: render as code (monospace, one statement per line, args inline until the line would pass
   ~80 chars, then wrap with indent), docs and descriptions behind an info icon (hover/tap; editable in edit mode).
   Pure layout logic in `logic/expr.ts` with unit tests; one browser shot. **web.**
6. **Model calls dense** — `admin/views/ModelCallsView.vue`: one row, at most three text lines (model · modality ·
   status / system · session / cost · tokens · time). **web.**
7. **Fns catalogue and fn page** — exists: per-system `FnList.vue` and `admin/systems/:name/fns/:fn` (`FnView.vue`).
   Missing: a global catalogue. Hub implements `fns` (`fns` list source over the `fns` table plus `fnMetrics`). Web:
   `/admin/fns` (nav entry) with the search box; the fn page shows stats and its runs (runs list filtered `fn is X`).
   **hub**, **web**.
8. **Density pass** — the `( Bash {} )` pill (`RunCard.vue`, `ArgList.vue`, `StatusLine.vue`), half-empty rows in
   chat and admin, and duplicated info: show a run's command/args once (the title line abbreviates; details show the
   full value only if the title cut it). Look across `RunCard`, `RunDetails`, `TurnDetails`, `LlmCallDetails`,
   `ModelCallDetails`, `SystemCard`. **web.**
9. **Query standard** — hub: `query/` module (`QueryService` and one `ListSource` per list in `LIST_FIELDS`), a
   generic in-memory evaluator for what a source can't push down, `queryProblems` → 422; every list endpoint reads
   `query`; `query`/`listValues` endpoints. SDK: `hub/query` read fn = `querySlice.endpoints.query` in
   `HUB_READ_ENDPOINTS` (**platform**). Web: one `ui/UiSearch.vue` (pills; typing suggests field values from
   `listValues` and fields from `LIST_FIELDS`; a filter icon in the box opens a field menu → operator → value) plus
   `ui/UiSort.vue` beside it, always showing the applied `sortOf`; query state ↔ URL (`?q=` encoded `ListQuery`) in a
   shared `state/query.ts`. Layout standard: search + sort on one row at the top of the list, no card around it, counts
   at the right. Used by resources, fns, runs, model calls, LLM calls, sessions, context, inbox, systems. **hub**,
   **web**, **platform**.
10. **Auto pair** — new (pairing today is code or one-time token only). Hub (`link/pairing`): on approve or token with
    `autoPair`, mint 32 random bytes (base64url), store `sha256` in `autoPairSecrets`, send `Welcome.autoPair`. A hello
    with `autoPair`: rate limited per address and per id (`@ayepi/rate`), look up by id, constant-time compare
    (`timingSafeEqual`) with `secretHash` or `previousHash`, refuse expired/revoked (same refusal as unknown); then a
    challenge with the hello's new key; on proof, replace the instance key, rotate (old → `previousHash`), count the
    use, send the new grant. Never log secrets or hashes. Env slice: default expiry 90 days, rate window. Implements
    `autoPairSlice`. SDK (**platform**): `KeyStore` gains `autoPair()` / `saveAutoPair(grant)` stored as a 0600 file
    in the state dir beside the key; `LinkHost` sends it in `hello` and saves every `Welcome.autoPair`. Web: pairing
    page and token dialog get an "Auto pair" switch with expiry (90 days default, never); the instance page lists
    secrets with revoke. **hub**, **platform**, **web**.
11. **Resource → context on mobile** — the icon in `resources/` gets a visible label or tooltip and a confirm dialog
    (`ConfirmDialog`) saying what it makes. **web.**
12. **Context page** — `pages/ContextPage.vue` "Remember" → "Context"; `context/components/MemoryDialog.vue` gets a
    collapsed Advanced section with every `ContextOptions` field (tied fns picker included) and edits via
    `updateMemory`. Hub: `ContextLibrary.remember`/new `update` map `ContextOptions` onto the memory's `ContextDecl`
    (tied fns are `decl.fns`, already loaded with the item). **hub**, **web**.

Carry-overs: ayepi auth hook and reconnect (**platform**, then **web** drops `watchRefusals` from `api/client.ts` and
passes `unauthorized`; reconnect after refresh); fs secret exclusion (**platform**, `systems/fs/server`, configurable
glob list in the fs config with the spec's defaults); screenshot gallery script (**platform**, `scripts/gallery.ts` over `ui-tests/run.ts`,
run only for changed screens).

## Tests

Unit/component/API only, except: expression viewer layout, search box pills and menu, chat density at phone and
desktop (one shot each). Core query tests are in `core/src/build3.test.ts`.

## Status (end of build 3)

| Item | Status |
|---|---|
| 1 Exact cost | done (`formatCost`) |
| 2 Suggestions below the user message | done: `ChatMessage.suggestions` with `SkipReason`, icon row and popover in `UserMessage.vue` |
| 3 Stop / pause / resume per fn | done: `SessionControls.runs`, `control.runs`, `RunControl.vue` menu |
| 4 Decision model | done: `chat/suggestions.ts`, `suggestionsSlice`, `DecisionDialog.vue` under Models |
| 5 Expression editor / viewer | done: code layout in `gin/logic/layout.ts`, docs behind an info icon |
| 6 Model calls dense | done |
| 7 Fns catalogue and fn page | done: `/admin/fns` (`FnsView.vue`), fn page with stats and runs |
| 8 Density pass | done for the named components |
| 9 Query standard | done: hub `query/`, `hub/query` fn, `ListSearch.vue` (`UiSearch` + `UiSort`) on resources, fns, runs, model calls, LLM calls, sessions, context, inbox, systems. Legacy narrow list filters still accepted (build 4 removes them) |
| 10 Auto pair | done: hub `link/auto-pair.ts`, SDK key store and hello, web switch, expiry and revoke |
| 11 Resource → context on mobile | done: label and `ConfirmDialog` in `ResourceViewer.vue` |
| 12 Context page | done: "Context", Advanced section, `updateMemory` |
| Carry-overs | done: ayepi `unauthorized` hook and `wsTransport.reconnect()` (committed on ayepi's `harness` branch), web passes `unauthorized`; fs secret exclusion (`systems/fs/server/secrets.ts`); `scripts/gallery.ts` |

Not finished: the three browser shots in §Tests (expression viewer layout, search box pills and menu, chat density at
phone and desktop) have no dedicated scenario; those layouts are covered by unit and component tests only.
