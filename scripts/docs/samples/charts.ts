/**
 * A compiled sample for the authoring guide (**Visuals and widgets**): a system that adds a pie visual to the hub's
 * visual registry, declared with its shape and drawn by its client. Nothing runs it; `npm run typecheck` compiles it.
 */
import { HUB_VISUALS, channel, client, system, visual, type Renderer, type VisualView, type WithSystem } from '@harness/sdk';

/** The pie's component (`client/PieVisual.vue` in a real system): it gets the `table` to draw and `system`. */
declare const PieVisual: Renderer<VisualView & WithSystem<(typeof charts)['defs']>>;

// #region visual
/** The contract: the pie, declared in `hub/visuals` with the data it draws. */
export const charts = system('charts', {
  description: 'Charts for results.',
  contributes: [visual({
    name: 'pie',
    label: 'Pie',
    icon: 'chart',
    shape: {
      channels: [channel('label', 'Slice', ['text']), channel('value', 'Size', ['integer', 'number'])],
      // a few slices read well; a pie of one page of a longer result lies, so it wants the whole result
      rows: { min: 1, max: 12 },
      whole: true,
    },
  })],
});

/** The client: the pie's component, with no `match` of its own, so its declared shape judges the fit. */
export default client(charts, { visuals: { [HUB_VISUALS]: { pie: { component: PieVisual } } } });
// #endregion visual
