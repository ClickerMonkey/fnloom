# Widgets: product's plan, ECharts and build 8: answers

39 of 39 answered. Written by questionme; the answers themselves are in the .json next to this file.

## Scope

### scope-depth: How much of product's widget plan goes into build 8?

Everything

Applied: Recorded in build-8-feedback.md (35ab704) and harness.md Decided. These differ from my recommendation and are applied as answered: a focused widget pass runs right after build 8 integrates.

### scope-hub-kind: Should the widget kind belong to the hub (`hub/widget`)? harness.md says the hub ships only `native` and `llm` kinds.

A bundled widgets system

Applied: Recorded in build-8-feedback.md (35ab704) and harness.md Decided. These differ from my recommendation and are applied as answered: a focused widget pass runs right after build 8 integrates.

### scope-dashboards: Dashboards (pages placing several widgets)?

Later

## Chart types

### charts-catalog: "Every type": which ECharts charts become visuals?

Every one that draws from rows and columns

### charts-switcher: In the visual switcher: one entry per chart type, or families with styles inside?

About 12 families, each with a style picker

### charts-browser-math: Histograms, boxplots from raw rows and a pie's "Other" slice need maths over rows. Where?

In the browser, only when the result is whole

### charts-candlestick: Include candlestick (open/high/low/close) charts now?

Yes

## Visuals registry

### registry-shape: How does a visual declare the data it can draw?

Extended, declarative

### registry-column-facts: Who works out column facts (grouped vs measure, distinct counts, ranges)?

Both

### registry-ranking: How is the best visual picked?

Product's order

### registry-withheld: Show visuals that can't draw this data?

Hide them (today)

### registry-database-visuals: The database system's own table, bar and value visuals?

Delete them

### registry-system-charts: Can systems contribute their own ECharts charts?

Yes, each system bundles ECharts

Applied: Recorded in build-8-feedback.md (35ab704) and harness.md Decided. These differ from my recommendation and are applied as answered: a focused widget pass runs right after build 8 integrates.

## Controls

### controls-choice-labels: Should dropdown choices carry their own words?

Label + value, plus an "Any" row that clears it

### controls-hidden-pinned: Keep both "pinned" (fixed value, hidden) and "hidden" (no control, takes its default)?

Both

### controls-presets: Named presets that set several arguments in one tap ("Overdue", "This week")?

Yes

### controls-relative-dates: Relative dates in date controls, so saved widgets stay current?

A fixed list now

### controls-bar: How do a widget's controls look?

An always-visible chip row

### controls-visual-claims: Should a chart drive arguments itself (the calendar's month or a zoomed time axis sets from/to; brushing sets a range filter)?

Range args yes, brush later

### controls-paging: How does paging work?

Product's buffer

## Actions and writes

### actions-confirm: A write action with a form: is filling the form the confirmation, or does a confirm follow it?

Form, then confirm (today)

Applied: Recorded in build-8-feedback.md (35ab704) and harness.md Decided. These differ from my recommendation and are applied as answered: a focused widget pass runs right after build 8 integrates.

### actions-then: What happens after an action runs?

Derived

### actions-drill: Clicking a bar, slice or point?

Runs the widget's declared drill action

### actions-read-only-writes: When the rows shown came from a write ("update my tasks and show them")?

Read-only

### actions-any-fn: Keep harness's ability to bind any fn (not just the row type's own methods) to a row's columns?

Keep

### actions-bulk: Act on several selected rows at once (table checkboxes or a chart brush)?

Later

## Authoring

### authoring-save: How does a new widget get saved?

The agent proposes; the chat shows a preview; you press Save

### authoring-strict-schema: How strict is the authoring agent's tool schema?

Product's strict schema, built per call

### authoring-sources: Which fns can a widget draw from?

Only read fns returning a table

### authoring-edit-source: Changing an existing widget to a different source fn?

Allow when the arguments are compatible

## Routing in chat

### routing-declared: How does the chat model learn that table results draw as charts?

A line derived from each fn's declared return, plus a short instruction

### routing-tool-result: What does the model see after a widget run?

A summary plus the first few rows

Applied: Recorded in build-8-feedback.md (35ab704) and harness.md Decided. These differ from my recommendation and are applied as answered: a focused widget pass runs right after build 8 integrates.

### routing-run-after-make: After a widget is made, should the chat run it at once?

Yes, when the person asked to see something

## Data system link

### data-grid: Should the Data page's record tables use the widget view (same visuals, controls, actions), with inline editing added?

Yes, one view

### data-refresh: When hub records change, what do widgets showing them do?

Nothing (build 8), a reload chip later

### data-home: Where do saved widgets live?

/data/widgets, plus the fn page and chat (as designed)

## Look

### look-palette: Chart colours, given the app's "one accent colour" rule?

A small categorical palette tuned to the accent, light and dark

### look-phone: Charts on a phone?

Product's rules

### look-export: Download a chart as an image (PNG/SVG)?

Yes
