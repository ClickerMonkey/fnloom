/**
 * The list search box with zero, two and many filter pills (owner feedback 2026-11-11, the Runs page): the box is one
 * control tall until the pills wrap, the pills, clear button and filter button share one centre line, the input takes
 * the room left beside the pills (with a hint to type there), and the sort, "Needs approval" and the count sit on one row
 * under it, the same height.
 */
import { NEEDS_APPROVAL, queryParam } from '../../packages/web/src/state/query.ts';
import { check, feature, open, settle, tid } from '../kit.ts';

/** The runs page narrowed by these filters. */
function runsWith(filters: Parameters<typeof queryParam>[1]['filters']): string {
  return `/admin/runs?q=${encodeURIComponent(queryParam('runs', { filters }))}`;
}

/** The search box's height and how far each pill's and button's centre is from the first row's. */
interface BoxShape { readonly height: number; readonly control: number; readonly offsets: readonly number[]; readonly rows: number; readonly room: number }

export default feature({
  id: 'search-pills', ref: 'build-6 feedback 2026-11-11', title: 'Search pills', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    const cases = {
      none: runsWith([]),
      two: runsWith([NEEDS_APPROVAL, { field: 'system', op: 'is', value: 'fs' }]),
      many: runsWith([NEEDS_APPROVAL, { field: 'system', op: 'is', value: 'fs' }, { field: 'fn', op: 'is', value: 'fs/read' }, { field: 'system', op: 'is', value: 'web' }, { field: 'fn', op: 'is', value: 'fs/bash' }]),
    } as const;
    for (const [name, path] of Object.entries(cases)) {
      await open(ctx, path, tid('search'));
      await settle(page);
      const shape = await page.$eval(tid('search'), (box): BoxShape => {
        const centre = (el: Element): number => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
        const pills = [...box.querySelectorAll('[data-testid="search-pill"]')];
        const buttons = [...box.querySelectorAll('.icon-btn, .lead')];
        const first = pills[0] ?? box.querySelector('input');
        const line = first === null ? 0 : centre(first);
        const input = box.querySelector('input');
        // the rows the pills and the input take: the input keeps room to type, on the pills' last row or its own
        const rows = new Set([...pills, ...(input === null ? [] : [input])].map((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2))).size;
        const control = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control'));
        return { height: box.getBoundingClientRect().height, control, offsets: buttons.map((b) => Math.abs(centre(b) - line)), rows, room: input?.getBoundingClientRect().width ?? 0 };
      });
      check(shape.offsets.every((off) => off <= 1), `${name}: the pills and buttons share one centre line (${shape.offsets.join(', ')})`);
      if (shape.rows <= 1) { check(Math.abs(shape.height - shape.control) <= 1, `${name}: the box is one control tall while the pills and the input fit one row (${shape.height}px)`); }
      check(shape.room >= 48, `${name}: the input keeps visible room to type (${shape.room}px)`);
      // the sort, "Needs approval" and the count share one row: the same top and bottom for the controls
      const row = await page.$$eval(`${tid('sort')}, ${tid('needs-approval')}`, (els) => els.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; }));
      check(row.length === 2 && row[0]?.[0] === row[1]?.[0] && row[0]?.[1] === row[1]?.[1], `${name}: the sort and "Needs approval" line up (${JSON.stringify(row)})`);
      await ctx.shot(name);
    }
  },
});
