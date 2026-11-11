/**
 * A system's review, rendered (build 7): an installed system's fns with their switches and one opened (instructions,
 * signature, facts, examples, test call), its install checks, and a live system's pending changes with one diff open,
 * then the refusals the hub logged. The systems list marks the installed system. Against the mock hub (`notes` is
 * installed, `fs` has changes waiting), or a real stack with the same.
 */
import { check, feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'build7-review', ref: 'build-7 spec §5', title: 'Review and go live', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/systems', tid('system-notes'));
    check(await page.$(`${tid('system-notes')} ${tid('system-card-installed')}`) !== null, 'the installed system is marked in the list');

    await open(ctx, '/admin/systems/notes/review', tid('review-fns'));
    check(await page.$(tid('go-live')) !== null, 'an installed system offers Go live');
    const rows = await page.$$(`${tid('review-fns')} > li`);
    check(rows.length > 0 && (await page.$$(tid('review-fn-switch'))).length === rows.length, 'every fn has its own switch');
    await page.click(tid('review-fn'));
    await find(page, 'review-fn-body');
    check(await page.$(tid('review-fn-test')) !== null, 'an opened fn offers a test call');
    await settle(page);
    await ctx.shot('fns');

    await open(ctx, '/admin/systems/notes/review/checks', tid('review-checks'));
    await settle(page);
    await ctx.shot('checks');

    await open(ctx, '/admin/systems/fs/review/pending', tid('review-changes'));
    check(await page.$(tid('approve-review')) !== null && await page.$(tid('reject-review')) !== null, 'pending changes can be approved or rejected');
    await page.click(tid('review-change'));
    await find(page, 'review-diff');
    await settle(page);
    await ctx.shot('pending');

    await open(ctx, '/admin/systems/notes/review/refusals', tid('refusal-list'));
    await settle(page);
    await ctx.shot('refusals');
  },
});
