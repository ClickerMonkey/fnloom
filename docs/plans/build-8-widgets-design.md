# Build 8 widget pass: design

Binding for the widget pass. Sources: build-8-feedback.md (the ECharts note and the 39 answers win over everything),
product's widget plan (intent only), build-8-design.md Status. Shared contracts are already in `packages/core`
(listed in §1); a lane that needs a change to them asks in its report.

**Lanes.** **platform**: `packages/sdk/**`, `scripts/**` (stack, docs generator), libraries. **hub**: `packages/hub/**`.
**systems**: the new `systems/widgets/**`, `systems/database/**`. **web**: `packages/web/**`, `ui-tests/**`.
Order: platform's sdk pieces (§2) first, the rest in parallel against the core contracts.

## 1. Contracts now in `packages/core`

| File | What |
|---|---|
| `registries.ts` | `VisualShape` extended (rules, size strategy, styles, range claims, priority band and terms, page size; `VisualShapeInput` for authors); `VisualChannel.min`/`role`; `VisualRule`, `VisualStyle`, `VisualClaim`, `VisualSizeStrategy`, `PriorityBand`, `PriorityTerm`; `ResultColumn.role`/`key`/`editable`; `ResultTable.write` (affected count) and `.records` (type and id column). `VisualFit`, `BUILT_IN_SHAPES`, `barFit`/`valueFit`/`tableFit` are `@deprecated` |
| `visuals.ts` (new) | `HUB_VISUALS`, `ColumnFacts`/`ResultFacts`/`columnFacts(table, typeFacts?)`, `VisualBinding`, `VisualRank`, `rankVisuals`, `bindingProblems`, the priority constants, `VISUAL_FAMILIES`/`BUILT_IN_VISUALS`/`BUILT_IN_ENTRIES`, `CHART_PALETTE_SIZE`; `declaredFit` (deprecated) |
| `widgets.ts` (rewritten) | `WIDGETS_SYSTEM`, `WIDGET_KIND = 'widgets/widget'`, `RelativeDate`/`RELATIVE_DATES`, `ArgValue`, `ChoiceOption`, `ArgPlan`, `WidgetPreset`, `WidgetRange`, `WidgetPaging`, `WidgetVisual`, `ActionThen`, `WidgetAction`, `WidgetDrill`, `WidgetSpec`, `WidgetShownControl`, `WidgetPager`, `WidgetActionOption`, `WidgetResult`, `RowActionsQuery`, `ReadTableArgs`, `MakeWidgetArgs`, `WidgetProposal`, `SaveWidgetArgs`, `ExportQuery`, `RESULT_TABLE_ROUTING`/`RESULT_TABLE_INSTRUCTION`, `tableModelView`, `widgetSummary`, `confirmOf`, `deriveThen`, `actionLabel`, `upgradeWidgetSpec` |
| `widgets-v1.ts` | build 8's contracts renamed `*V1` (`WIDGET_KIND_V1 = 'hub/widget'`). `WidgetSpecV1` stays for the migration; the rest goes with its last reader. Every consumer was renamed mechanically, so typecheck stays green |
| `manifest.ts` | `FnLive` (`FnDecl.live: { every }`), a source that changes on its own |

## 2. Per answer

**Scope**

- **scope-depth: Everything** (but dashboards). Covered below, realtime and streamed export included.
- **scope-hub-kind: a bundled widgets system.** New `systems/widgets` (`@harness/system-widgets`, `instances: "one"`,
  bundled like input), **systems** lane. It declares the kind `widget` (`describe`: args = source's minus pinned,
  paging and range-driven ones become optional; returns `ginAs(WidgetResult)`; deps = source, drill fn; effects = read),
  `check` (source is a read fn returning a table: `bindingProblems` over the source's declared columns when it has
  them), `run` (`ctx.call(source)` as a child run with resolved args and the first window, `columnFacts`, problems,
  controls, `hub/row_actions`, summary), and the fns `make_widget`, `save_widget` (visibility `user`, never an agent
  tool; `hub/save_fn` under `widgets/<name>`). Grants: `hub: ['ai','fns']`, calls `hub/fn_get`, `hub/save_fn`,
  `hub/read_table`, `hub/visuals`, `hub/row_actions`. **hub** lane: delete `packages/hub/src/widgets/` and the
  `hub/widget` kind, `make_widget`, `widget_*` fns from the hub contract (**platform**: `sdk/hub.ts`); add `hub/read_table`
  (`ReadTableArgs` → `ResultTable`: refuses anything not mode `read` or not returning a table; a child run as the
  caller's person), `hub/visuals` (→ `ContributionView[]` of `HUB_VISUALS`), `hub/row_actions` (`RowActionsQuery` →
  `WidgetActionOption[]`, today's derivation in `catalog`, `then` by `deriveThen`) and replace `widgetsSlice` by
  `rowActionsSlice` (`rowActions: { body: RowActionsQuery, response: WidgetActionOption[] }`). Migration (hub, in the
  store's start-up migrations): every fn of kind `hub/widget` becomes `widgets/<local>` of kind `widgets/widget` with
  `upgradeWidgetSpec(WidgetSpecV1.parse(payload))`, versions, owner and share kept; it runs whether or not widgets is
  paired yet. **platform**: `scripts/stack.ts` pairs `widgets` in dev, live and e2e (component `widgets`).
- **scope-dashboards: later.** Nothing.

**Chart types**

- **charts-catalog / charts-switcher / charts-candlestick.** `BUILT_IN_VISUALS`: table + value + 12 chart families,
  each with a style picker. ECharts series per style (**web** lane draws them):

  | Family | Styles → ECharts |
  |---|---|
  | `table` | table, compact, cards (DOM, not ECharts; cards below 600px) |
  | `value` | cards, single (DOM) |
  | `part` | pie, doughnut, rose, half (`pie` options), funnel (`funnel`) |
  | `category` | bar, stacked, percent, horizontal (`bar`), line, area (`line`), radar (`radar`), polar (`bar` on `polar`), pictorial (`pictorialBar`) |
  | `time` | line, smooth, area, stacked, step (`line`), bar (`bar`), river (`themeRiver`) — `dataZoom` |
  | `distribution` | scatter, bubble (`scatter`), pulse (`effectScatter`), histogram (`bar` over bins), boxplot (`boxplot`), parallel (`parallel`) |
  | `crosstab` | heatmap (`heatmap` on grid), cells (`matrix` coordinate), multiples (`matrix` with a series per cell) |
  | `calendar` | month, year (`heatmap`/`scatter` on `calendar`) |
  | `timeline` | gantt (`custom` via `registerCustomSeries`), timeline (`scatter` on a time axis) |
  | `network` | force, circular (`graph`), sankey (`sankey`), chord (`chord`) |
  | `hierarchy` | tree, radial (`tree`), treemap (`treemap`), sunburst (`sunburst`) |
  | `gauge` | gauge, progress (`gauge`) |
  | `finance` | candlestick, volume (`candlestick` + `bar`) |

  Map and lines are out (geography). Every chart option is `dataset` + `encode` with channel names as encode
  dimensions; graph, sankey, chord, tree, treemap and sunburst build nodes/links. A day axis uses `useUTC`. Hub
  contract (**platform**, `sdk/hub.ts`) contributes every `BUILT_IN_VISUALS` entry to `hub/visuals` in place of today's
  table. Web: `packages/web/src/components/visuals/` (one component per family, a shared `echarts-setup.ts` that
  registers only the used charts and components with `echarts/core`, loaded with `defineAsyncComponent` so the chat
  bundle doesn't carry ECharts until a chart draws). `echarts@6.1.0` and `vue-echarts@8.3.2` are in `packages/web`.
- **charts-browser-math: in the browser, only over a whole result.** Histogram bins, boxplot quartiles and the pie's
  "Other" (`size: 'partition'`) run in web only when `ResultFacts.whole`; `rankVisuals` already hides `whole` styles
  otherwise. `make_widget`'s prompt tells the agent to write an aggregate query instead.

**Visuals registry**

- **registry-shape: extended, declarative** — `VisualShape` (§1). **registry-column-facts: both** — sources set
  `ResultColumn.role`/`key` (**systems**: database sets `role` from GROUP BY / aggregates and `key` from the PK; **hub**:
  `records_table` sets `key`, `editable`, `records`); `columnFacts` derives the rest, with gin facts (enum members,
  bounds) from a new sdk `ginTypeFacts` (**platform**) passed as `typeFacts`. The widgets system attaches `facts` to every
  `WidgetResult`; web recomputes over the widest buffer it holds.
- **registry-ranking: product's order** — `rankVisuals` (coverage, then band + terms, then registry order). The client
  only vetoes: **platform** changes sdk `VisualEntry.match` to `veto?(table, facts): string | undefined` and drops scores
  from `VisualOption`; **web** replaces `results/visuals.ts` scoring with `rankVisuals` over `ContributionView`s.
- **registry-withheld: hide** — non-fits are not listed.
- **registry-database-visuals: delete** — **systems**: remove `systems/database/client/{TableVisual,BarVisual,ValueVisual}.vue`,
  `own-visuals.ts`, `visuals.ts`, `shared/visuals.ts`, its `contributes` and their tests; its `result` attachment draws
  through the web's result view (`VISUALS` injection). Then **web/platform** delete `BUILT_IN_SHAPES`, `barFit`,
  `valueFit`, `tableFit`, `VisualFit`, `declaredFit` from core usage (core lane removes the exports once unused).
- **registry-system-charts: yes, each system bundles ECharts.** A system declares `contributes: [visual({ name, label,
  shape })]` (sdk `visual()` takes `VisualShapeInput`) and `client({ visuals: { [HUB_VISUALS]: { name: { component,
  veto? } } } })`; its own `package.json` depends on `echarts` (exact version) and its client build bundles it. Its
  component gets `VisualView` (**platform** extends it): `table`, `facts`, `bind`, `style`, `palette` (the resolved
  `--chart-1..8` colours and the text/grid colours for the current theme) and emits `drill(rowIndex)` and
  `range({ from, to })`. No SDK chart wrapper. The authoring guide gets a "Your own chart" part (**platform**).

**Controls** (`ArgPlan`, `WidgetShownControl`; **systems** builds them in `run`, **web** draws them)

- **choice labels**: `ChoiceOption` label + value; an optional arg gets an "Any" row (no value) that clears it.
- **hidden and pinned**: both; `hidden` only when the arg has a default (`check` refuses otherwise).
- **presets**: `WidgetPreset` chips at the row's start; tapping one sets its args and runs.
- **relative dates**: `RELATIVE_DATES`, stored as grammar text; resolved in the web control when applied and by the
  widgets system when a saved widget runs (`resolveRelative(expr, now, zone)` in sdk, **platform**, one implementation).
- **chip row**: always visible, one chip per shown control (label and value, "Any" when unset) opening a `UiPopover`
  with the editor for its gin type, Apply beside the row; wraps on a phone, never a dialog.
- **visual claims**: `VisualClaim` on time, calendar, timeline, finance; `WidgetSpec.range` names the from/to args; a
  zoom end or calendar month change emits `range`, which sets them and re-runs (debounced). Brush later.
- **paging: product's buffer** — `WidgetPager` (`window` = limit applied, `more` = full window). Web holds a buffer,
  pages locally (page size from the visual's `pageSize`, changeable), runs the widget again with offset = rows held
  only when a page needs more; "No more rows" on an empty fetch. Visuals without `pageSize` draw the whole buffer.

**Actions and writes**

- **confirm: form, then confirm**; **then: derived** (`deriveThen`, author may override); **drill**: `WidgetDrill` runs
  as a new level with a breadcrumb (web keeps levels in the URL query `level`), else a click opens the row's action
  menu; **read-only writes**: `ResultTable.write` → `WidgetResult.readOnly` (no chips, pager or drill; row actions stay;
  "Run again" asks first) — **systems**: database write queries returning rows set `write.affected`; **any fn**: kept
  (`WidgetAction.bind` to columns, confirms and approvals as for any run); **bulk**: later.

**Authoring** (**systems**: `widgets/make_widget`, an agent fn: a prompt with real instructions and examples over
`ctx.ai()` tools `source` (fn_get + `hub/read_table` sample), `propose`)

- **save: propose, preview, Save.** `make_widget` returns a `WidgetProposal` (spec, name, description, `preview` from a
  real source run with the plan's args, `show`). The chat draws it as a widget card with Save (and Change); Save runs
  `widgets/save_widget` as the person (**web**). The agent never saves.
- **strict schema per call**: sdk `widgetProposalSchema({ args, facts, ranked, entries })` (**platform**) builds a zod
  schema: `choice` a discriminated union over only the ranked visuals, each style an enum, each channel's columns an
  enum of the columns that channel may bind; `plan.args` keys exactly the source's non-claimed args with typed values,
  choices' values in the arg's members; presets the same; the visuals list an enum. A broken widget can't be spelled.
- **sources**: only read fns returning a table (`hub/read_table` refuses others; `check` too). Writes show read-only
  results but can't be saved. **edit source**: allowed when every planned arg exists in the new source with a
  compatible type (sdk `sourceCompatible`, gin `compatible`).

**Routing in chat** (**hub**)

- **declared**: a fn whose declared `returns` is gin-compatible with `ginAs(ResultTable)` (sdk `returnsTable`,
  **platform**) gets `RESULT_TABLE_ROUTING` appended to its line in the fn lists; `RESULT_TABLE_INSTRUCTION` is added
  once to the chat system prompt when any such fn is listed.
- **tool result**: a run output that parses as `WidgetResult` or `ResultTable` reaches the model as `tableModelView`
  (summary + first `HARNESS_TOOL_RESULT_ROWS` rows, env, default 5); the person sees the chart. In a run nobody
  watches (`RunInfo.watched` not true: a nested agent, a background or scheduled run) the summary says no one sees the
  rows and the model gets the first `HARNESS_HEADLESS_RESULT_ROWS` (default 50) to answer from.
- **run after make**: `make_widget.show` is set by the calling model when the person asked to see something (its
  description says so); the proposal card then opens with the chart drawn, else collapsed.

**Data system link**

- **data-grid: one view.** **web**: the record table on `/data/:system/:local` is `WidgetView` over a `WidgetSource`
  interface (`widget-source.ts`: `run(args, window)`, `controls`, `actions`) with two implementations, a widget fn and
  `hub/records_table`; inline editing for `editable` columns stages changes, "Save N changes" then one confirm naming
  them, each through `hub/record_update`.
- **data-refresh: nothing now.** **data-home**: `/data/widgets` lists `widgets/widget` fns (search by kind
  `WIDGET_KIND`); each opens on its fn page and in chat.
- **Realtime (scope "Everything")**: a source with `FnDecl.live` lets a widget set `live`; the web re-runs while shown
  at max(`every`, `HARNESS_WIDGET_LIVE_FLOOR`, default 5000 ms, served in `WidgetResult.live`), one run in flight,
  paused when hidden. **Streamed export**: **hub** `GET /api/export` (`ExportQuery`) runs the read fn page by page as the
  person under one export run, writes CSV with `Content-Disposition`, cuts at `HARNESS_EXPORT_MAX_ROWS` with a final
  line; refuses non-read fns. Web: "Export CSV" in the widget menu builds the URL from `WidgetResult.source`/`paging`.

**Look** (**web**)

- **palette**: `--chart-1` … `--chart-8` in `ui/styles/tokens.css`, `light-dark()` OKLCH, `--chart-1` = `--accent`, the rest
  spaced hues at matching lightness/chroma (checked for contrast in both themes); an ECharts theme object built from the
  tokens on theme change. **phone (product's rules)**: legend at the bottom and scrollable, tap for tooltip, full screen
  as a sheet, tables become cards below 600px, pinch-zoom (`dataZoom` inside). **export**: PNG and SVG via
  `getDataURL`/`renderToSVGString` (an SVG renderer instance for the SVG download).

## 3. Tests

Unit: `rankVisuals`/`columnFacts`/`upgradeWidgetSpec` (core), the strict schema and relative dates (sdk), the
kind's run and `make_widget` with a fake hub (systems), `read_table`/`row_actions`/migration/export as API tests (hub).
Component (happy-dom): chip row, pager buffer, drill levels, proposal card, inline edit. Browser only: one ui-test
feature `widgets-charts` that renders each family at phone and desktop, light and dark, for overlap.

## 4. Status (end of the widget pass)

Built in `5bf949b`, integrated in `176d173`, two review rounds (`0b645c3`, `33df06d`), then the final step. One line per
owner answer; "done" means built as §2 says and covered by the tests in §3.

**Scope.** scope-depth: done (realtime over `FnDecl.live` sources, streamed CSV export; dashboards excluded).
scope-hub-kind: done (`systems/widgets`; `packages/hub/src/widgets/` and `hub/widget` gone; `hub/widget` fns migrate to
`widgets/<local>` in `tables/migrate.ts`). scope-dashboards: later, nothing built.

**Chart types.** charts-catalog: done (table, value and the 12 families in `components/visuals/families/`; map and
lines out). charts-switcher: done (family, then style picker). charts-browser-math: done (`visuals/maths.ts`, only
when `facts.whole`). charts-candlestick: done (`finance`: candlestick, volume).

**Visuals registry.** registry-shape: done (`VisualShape`; `VisualFit` and the fit helpers removed). registry-column-facts:
done (database sets `role`/`key`, `records_table` sets `key`/`editable`/`records`, `columnFacts` plus sdk
`ginTypeFacts`). registry-ranking: done (`rankVisuals`; the client only vetoes). registry-withheld: done (hidden).
registry-database-visuals: done (deleted). registry-system-charts: done (sdk `visual()`, client `visuals` with `veto`,
`VisualView` palette and `drill`/`range` events; "Your own chart" in AUTHORING.md); no system ships one yet.

**Controls.** controls-choice-labels: done ("Any" row on optional args). controls-hidden-pinned: done (`check` refuses
`hidden` without a default). controls-presets: done. controls-relative-dates: done (`RELATIVE_DATES`; one
`resolveArgValue` in sdk, used by the web control and the widgets system's run). controls-bar: done (`WidgetChips`).
controls-visual-claims: done for range args (time, calendar, timeline, finance); brush later. controls-paging: done
(buffer in `widget-state.ts`, "No more rows").

**Actions and writes.** actions-confirm: done (form, then confirm). actions-then: done (`deriveThen`, author override).
actions-drill: done (levels in the URL `level`, breadcrumb; action menu when there is no drill). actions-read-only-writes:
done (database `write.affected` → `readOnly`; "Run again" asks). actions-any-fn: done (`WidgetAction.bind`).
actions-bulk: later, nothing built.

**Authoring.** authoring-save: done (`WidgetProposal` card with Save and Change; `save_widget` runs as the person).
authoring-strict-schema: done (sdk `widgetProposalSchema` per call). authoring-sources: done (`hub/read_table` and
`check` refuse non-read or non-table fns). authoring-edit-source: done (sdk `sourceCompatible`).

**Routing in chat.** routing-declared: done (`RESULT_TABLE_ROUTING` per fn line, `RESULT_TABLE_INSTRUCTION` once).
routing-tool-result: done (`tableModelView`, `HARNESS_TOOL_RESULT_ROWS`; unwatched runs get
`HARNESS_HEADLESS_RESULT_ROWS`). routing-run-after-make: done (`show` opens the card drawn).

**Data system link.** data-grid: done (record tables are `WidgetView` over `WidgetSource`; inline edits staged, one
confirm, `hub/record_update` each). data-refresh: nothing, as answered (reload chip later). data-home: done
(`/data/widgets`, the fn page, chat).

**Look.** look-palette: done (`--chart-1..8` in `tokens.css`, ECharts theme from the tokens). look-phone: done (legend
at the bottom and scrolling, tap tooltips, full-screen sheet, cards below 600px, inside `dataZoom`). look-export: done
(PNG and SVG in `visuals/export.ts`).

**Not finished.** Type `display` is not used by widget rows or their action menus yet. No system contributes its own
ECharts chart yet (the path exists and is documented). Bulk actions, brush filters, dashboards and the hub-record reload
chip are later by answer.

**Checks (final step).** `npm run check` green apart from one load-timing web test (`context.test.ts`, passes alone);
stale generated authoring docs regenerated and one lint error fixed. e2e: 8 of 15 files passed; the 16 failing tests
are model-driven and hit OpenRouter's free-model daily limit (`429 free-models-per-day`), with later tests in the same
groups failing in turn, plus the known `chat` embedding wait on the shared embedder. Re-run them when the quota resets.
