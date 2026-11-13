# Build 8: owner feedback

Binding for build 8's remaining phases; it wins over earlier docs where they conflict.

## 2026-11-12

> What UI library for charts are widgets using?

(Answer: none; the database visuals are hand-built Vue components: table, CSS bars, single value.)

> Have it use apache echarts and try to do every type. Look at the products widget plan I have it - thats what I want with this widget system.

- **Charts:** visuals use Apache ECharts (via vue-echarts, tree-shaken), with a visual for every ECharts series type
  that fits a query result (line, bar, pie, scatter, area, heatmap, radar, funnel, gauge, treemap, sunburst, sankey,
  graph, candlestick, boxplot, parallel, calendar, and so on), each declaring the data shape it draws, themed light
  and dark, working on a phone.
- **Scope:** the widget system follows product's widget plan (product/design/widget-kind.md, widget-actions.md,
  widget-controls.md, widget-authoring-fn.md, widget-writes-and-routing.md, query-visuals.md). A comparison with
  build-8-design.md and the owner's answers to open questions will be added here; follow them when they arrive.

## Owner answers on widgets (2026-11-12, questionme set `widgets`, verbatim)

The question set (.questionme/sets/widgets.json) compares product's widget plan with build-8-design.md; each answer
below is the option the owner picked, word for word. The full answers are in .questionme/answers/widgets.md.

**Scope**

- How much of product's widget plan goes into build 8? (scope-depth) → **Everything**
- Should the widget kind belong to the hub (`hub/widget`)? harness.md says the hub ships only `native` and `llm` kinds. (scope-hub-kind) → **A bundled widgets system**
- Dashboards (pages placing several widgets)? (scope-dashboards) → **Later**

**Chart types**

- "Every type": which ECharts charts become visuals? (charts-catalog) → **Every one that draws from rows and columns**
- In the visual switcher: one entry per chart type, or families with styles inside? (charts-switcher) → **About 12 families, each with a style picker**
- Histograms, boxplots from raw rows and a pie's "Other" slice need maths over rows. Where? (charts-browser-math) → **In the browser, only when the result is whole**
- Include candlestick (open/high/low/close) charts now? (charts-candlestick) → **Yes**

**Visuals registry**

- How does a visual declare the data it can draw? (registry-shape) → **Extended, declarative**
- Who works out column facts (grouped vs measure, distinct counts, ranges)? (registry-column-facts) → **Both**
- How is the best visual picked? (registry-ranking) → **Product's order**
- Show visuals that can't draw this data? (registry-withheld) → **Hide them (today)**
- The database system's own table, bar and value visuals? (registry-database-visuals) → **Delete them**
- Can systems contribute their own ECharts charts? (registry-system-charts) → **Yes, each system bundles ECharts**

**Controls**

- Should dropdown choices carry their own words? (controls-choice-labels) → **Label + value, plus an "Any" row that clears it**
- Keep both "pinned" (fixed value, hidden) and "hidden" (no control, takes its default)? (controls-hidden-pinned) → **Both**
- Named presets that set several arguments in one tap ("Overdue", "This week")? (controls-presets) → **Yes**
- Relative dates in date controls, so saved widgets stay current? (controls-relative-dates) → **A fixed list now**
- How do a widget's controls look? (controls-bar) → **An always-visible chip row**
- Should a chart drive arguments itself (the calendar's month or a zoomed time axis sets from/to; brushing sets a range filter)? (controls-visual-claims) → **Range args yes, brush later**
- How does paging work? (controls-paging) → **Product's buffer**

**Actions and writes**

- A write action with a form: is filling the form the confirmation, or does a confirm follow it? (actions-confirm) → **Form, then confirm (today)**
- What happens after an action runs? (actions-then) → **Derived**
- Clicking a bar, slice or point? (actions-drill) → **Runs the widget's declared drill action**
- When the rows shown came from a write ("update my tasks and show them")? (actions-read-only-writes) → **Read-only**
- Keep harness's ability to bind any fn (not just the row type's own methods) to a row's columns? (actions-any-fn) → **Keep**
- Act on several selected rows at once (table checkboxes or a chart brush)? (actions-bulk) → **Later**

**Authoring**

- How does a new widget get saved? (authoring-save) → **The agent proposes; the chat shows a preview; you press Save**
- How strict is the authoring agent's tool schema? (authoring-strict-schema) → **Product's strict schema, built per call**
- Which fns can a widget draw from? (authoring-sources) → **Only read fns returning a table**
- Changing an existing widget to a different source fn? (authoring-edit-source) → **Allow when the arguments are compatible**

**Routing in chat**

- How does the chat model learn that table results draw as charts? (routing-declared) → **A line derived from each fn's declared return, plus a short instruction**
- What does the model see after a widget run? (routing-tool-result) → **A summary plus the first few rows**
- After a widget is made, should the chat run it at once? (routing-run-after-make) → **Yes, when the person asked to see something**

**Data system link**

- Should the Data page's record tables use the widget view (same visuals, controls, actions), with inline editing added? (data-grid) → **Yes, one view**
- When hub records change, what do widgets showing them do? (data-refresh) → **Nothing (build 8), a reload chip later**
- Where do saved widgets live? (data-home) → **/data/widgets, plus the fn page and chat (as designed)**

**Look**

- Chart colours, given the app's "one accent colour" rule? (look-palette) → **A small categorical palette tuned to the accent, light and dark**
- Charts on a phone? (look-phone) → **Product's rules**
- Download a chart as an image (PNG/SVG)? (look-export) → **Yes**

### What the answers mean

- **Scope: everything in product's plan except dashboards.** That includes realtime refresh and streamed export
  (scope-depth "Everything" names them; dashboards were answered "Later" on their own; data-refresh says "a reload
  chip later" for hub record changes, so realtime means widgets over fns that declare a live source, not hub records).
- **Widgets are a bundled system, not a hub kind.** A `widgets` system (shipped with harness, like web and database)
  owns the widget kind, its records and its authoring fn; the hub keeps only `native` and `llm` kinds, so
  harness.md's rule stands. The hub's visual registry, data pages and chat reach widgets through that system.
- **Charts:** every ECharts series that draws from rows and columns, candlestick included, grouped into about 12
  families with a style picker in each. Maths over rows (histogram, boxplot, pie "Other") runs in the browser only
  when the whole result is held; otherwise the agent writes an aggregate query.
- **Registry:** an extended declarative shape; column facts from both the source's declaration and the hub's own
  analysis; product's (coverage-first) ranking; visuals that can't draw the data stay hidden. The database system's
  own visuals are deleted. Systems may ship their own ECharts charts, each bundling ECharts.
- **Controls:** label + value choices with an "Any" row; both pinned and hidden args; presets; a fixed list of
  relative dates; an always-visible chip row; range args driven by the chart (brush later); product's buffered pager.
- **Actions:** a write with a form keeps the form and then a confirm; "then" is derived; clicking a bar, slice or
  point runs the widget's declared drill action (breadcrumbed level; action menu if none); rows from a write are
  read-only; any fn may still be bound as an action; bulk actions later.
- **Authoring:** the agent proposes, the chat shows a preview, the person presses Save; product's strict schema, built
  per call; only read fns returning a table are sources.
- **Chat:** each fn's declared return gives a derived routing line plus a short instruction; after a widget runs the
  model sees a summary plus the first few rows; a newly made widget runs at once when the person asked to see
  something.
- **Data:** the Data page's record tables use the widget view (same visuals, controls, actions) with inline editing;
  saved widgets live at /data/widgets, on the fn page and in chat.
- **Look:** a small categorical palette tuned to the accent, light and dark; product's phone rules; PNG/SVG export.

**How this lands:** build 8's running lanes were designed before these answers. The integration and review steps
should not try to apply them; a focused widget pass runs right after build 8 integrates and does this work
against these answers, then build 8 finishes.
