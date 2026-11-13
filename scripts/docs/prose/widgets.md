A fn that returns a `ResultTable` (a query, `hub/records_table`, any fn of that shape) is drawn by the result view,
which offers every **visual** that fits the result: the table, a bar chart, a single value, and any visual a system
adds. A **widget** is a saved view of such a fn: the visuals to switch between with their bindings, a control per
argument, the paging it drives and the actions on each row.

**Visuals.** All visuals live in the hub's registry `hub/visuals` (`HUB_VISUALS`). A system adds one by declaring it
in `contributes` with `visual(...)`, whose **shape** says what data it draws: its channels (`channel(name, label,
kinds, { required, many })`, the column kinds each takes), how many rows it shows well, and whether it only tells the
truth about a whole result (`whole`: a pie of one page lies). The hub and the widget agent judge fits from the shape
(`declaredFit`, `fittingVisuals`) without running client code. Then draw it in `client({ visuals })`:

<!-- include: scripts/docs/samples/charts.ts#visual -->

A visual entry may give its own `match(table)` (a `VisualFit` score from 0 to 1; the table scores 0); without one,
its declared shape judges the fit with `DECLARED_FIT_SCORE`. The component gets `table` and `system`.

**Widgets.** A widget is a fn of the hub's kind `hub/widget` (`WIDGET_KIND`) whose payload is a `WidgetSpec`: its
`source` fn, `visuals` (each `{ visual, bind: { channel: [columns] } }`), `controls` (per source argument: `label`,
`choices`, `pinned` to fix it, `hidden`), `paging` (the source's offset and limit arguments and the page size) and
`actions`. Its args are the source's minus the pinned and paged ones (`widgetArgs`); its controls are the rest
(`widgetControls`). A run calls the source as a child run and returns a `WidgetResult`; bindings that no longer fit
the real columns are listed as problems, never a failure (`checkWidget`). Versions, visibility, review and search come
free, as for any fn.

**Row actions** are derived, never listed by hand: each method of a row's type (a column's `ref`, such as the `id`
column of `hub/records_table`) is offered, labelled from its name (`actionLabel`), with a form for the args left after
binding (`widgetActionOptions`). Anything that is not a read asks first (`confirmOf`); a widget can add a confirm, never
remove one. Nothing runs until a person clicks, and the click is an ordinary run, so policies and approvals apply. Give
a stored type methods to make its records actionable.

**Making widgets.** People ask in the chat ("show my open tasks by owner as bars"), or press "Save as widget" on a
table result; `hub/make_widget` writes the spec. It is an authoring agent (**Kinds and agents**) that skips `find`
(it is handed the source) and names its tools for the job: `widget_source` (the source's args and a small sample),
`widget_visuals` (the visuals whose shapes fit), `widget_check` (the draft against `widgetSpecSchema`, a strict schema
built from the source's args, the sample's columns and the fitting visuals, then `checkWidget`) and `widget_save`.
