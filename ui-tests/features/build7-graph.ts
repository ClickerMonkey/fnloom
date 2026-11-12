/**
 * The graphs, rendered (build 7): the global graph drawn with a cluster per system, a node hovered (desktop) or tapped
 * (phone) showing what it is, the details panel, filters and a collapsed system from the URL, and a system's own Graph
 * tab with its references into other systems greyed. Layout and hover can only be checked rendered. Against the mock
 * hub's sample graph, or a real stack.
 */
import type { Core } from 'cytoscape';
import type { Page } from 'puppeteer';
import { check, feature, inEachScheme, isTouch, open, settle, tid } from '../kit.ts';

/** One drawn node: id, classes and where it is on the page. */
interface DrawnNode { readonly id: string; readonly classes: string; readonly x: number; readonly y: number; readonly inView: boolean }

/**
 * The drawn graph's nodes, read from the graph library's instance (Cytoscape keeps it on its container as `_cyreg.cy`).
 * Runs in the page, so the check that it is one is written out there.
 */
function drawnNodes(el: Element): DrawnNode[] | undefined {
  const isCore = (value: unknown): value is Core => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'nodes') === 'function';
  const registry: unknown = Reflect.get(el, '_cyreg');
  const cy: unknown = typeof registry === 'object' && registry !== null ? Reflect.get(registry, 'cy') : undefined;
  if (!isCore(cy)) { return undefined; }
  const box = el.getBoundingClientRect();
  return cy.nodes().map((node) => {
    const at = node.renderedPosition();
    const x = box.left + at.x;
    const y = box.top + at.y;
    // clear of the edges, the zoom buttons (top) and the legend (bottom), and on screen: where a person can point at it
    const inView = x > box.left + 16 && x < box.right - 16 && y > box.top + 48 && y < box.bottom - 40 && y < window.innerHeight - 8 && x < window.innerWidth - 8;
    return { id: node.id(), classes: node.classes().join(' '), x, y, inView };
  });
}

/** The drawn graph's nodes, once it has drawn some (within 15 seconds). */
async function drawn(page: Page): Promise<DrawnNode[]> {
  const until = Date.now() + 15_000;
  for (;;) {
    const nodes = await page.$eval(tid('graph-canvas'), drawnNodes).catch(() => undefined);
    if (nodes !== undefined && nodes.length > 0) {
      await settle(page, 300);
      return await page.$eval(tid('graph-canvas'), drawnNodes) ?? nodes;
    }
    check(Date.now() < until, 'the graph draws within 15 seconds');
    await settle(page, 200);
  }
}

export default feature({
  id: 'build7-graph', ref: 'build-7 spec §6', title: 'System graph and global graph', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await inEachScheme(ctx, async (shot) => {
      await open(ctx, '/graph', tid('graph-canvas'));
      const nodes = await drawn(page);
      check(nodes.some((node) => node.classes.includes('cluster')), 'the global graph draws a cluster per system');
      const fn = nodes.find((node) => node.id === 'fn:fs/write' && node.inView) ?? nodes.find((node) => node.id.startsWith('fn:') && node.inView && !node.classes.includes('external'));
      check(fn !== undefined, 'the graph draws fns');
      if (isTouch(ctx)) {
        await page.touchscreen.tap(fn.x, fn.y);
        await page.waitForSelector(tid('graph-panel'), { timeout: 5_000 });
        check(await page.$('[role="dialog"]') !== null, 'tapping a fn opens the fn modal');
        await page.keyboard.press('Escape');
      } else {
        await page.mouse.move(fn.x, fn.y);
        const hover = await page.waitForSelector(tid('graph-hover'), { timeout: 5_000 });
        const text = await hover?.evaluate((el) => el.textContent);
        check(text?.includes('Mode') === true && text.includes(fn.id.slice(3)), 'hovering a node shows its name and facts');
      }
      await settle(page);
      await shot('global');
    });

    // a context item opens its details panel with Open and its neighbourhood
    const nodes = await drawn(page);
    const item = nodes.find((node) => node.id === 'context:fs/authoring' && node.inView) ?? nodes.find((node) => node.id.startsWith('context:') && node.inView && !node.classes.includes('external'));
    check(item !== undefined, 'the graph draws context');
    if (isTouch(ctx)) { await page.touchscreen.tap(item.x, item.y); } else { await page.mouse.click(item.x, item.y); }
    await page.waitForSelector(tid('graph-panel'), { timeout: 5_000 });
    check(await page.$(tid('graph-focus')) !== null, 'the details panel offers its neighbourhood');
    await settle(page);
    await ctx.shot('details');

    await open(ctx, '/graph?nodes=fn,type,context,system&collapse=database&q=&hops=2&focus=context:fs/authoring', tid('graph-canvas'));
    const focused = await drawn(page);
    check(focused.every((node) => !node.id.startsWith('fn:database/')), 'a collapsed system draws no items of its own');
    check(await page.$(tid('graph-focus-chip')) !== null, 'the focus shows with its hops');
    await page.click(tid('graph-filters-toggle'));
    await page.waitForSelector(tid('graph-filter-panel'));
    await settle(page);
    await ctx.shot('filters');

    await open(ctx, '/admin/systems/fs/graph', tid('graph-canvas'));
    const own = await drawn(page);
    check(own.some((node) => node.classes.includes('external')), "a system's graph greys what it references elsewhere");
    await settle(page);
    await ctx.shot('system');
  },
});
