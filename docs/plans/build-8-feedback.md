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
