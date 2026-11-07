/** Admin systems: fs and the embedder are listed as connected; a pairing token can be made for a new system. */
import { check, feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'admin-systems', ref: 'admin systems', title: 'Systems list and pairing tokens',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/systems', tid('systems'));
    const text = await page.$eval(tid('systems'), (el) => el.textContent);
    check(text.includes('fs') && text.includes('embedder'), 'fs and the embedder are listed');
    await ctx.shot('list');
    await page.click(tid('open-token'));
    await find(page, 'token-create');
    await settle(page);
    await ctx.shot('token-form');
    await page.click(tid('token-create'));
    await find(page, 'token-made');
    await settle(page);
    await ctx.shot('token-made');
    await page.keyboard.press('Escape');
  },
});
