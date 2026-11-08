/**
 * Hub MCPs (build 2 design 3.11): the list, making one (its secret shown once, hidden until revealed), its rules
 * (include and exclude editors with the live preview beside or below them), saving, what it exposes, connecting and
 * trying it with its secret, and its activity, each tab in the URL. The MCP made here is deleted afterwards.
 */
import { HubMcpId } from '@harness/core';
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, show, tid } from '../kit.ts';

export default feature({
  id: 'hub-mcps', ref: 'build-2 3.11', title: 'Hub MCPs', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api } = ctx;
    const name = `UI ${Date.now().toString(36)}`;
    try {
      await open(ctx, '/admin/mcps', 'main');
      await ctx.shot('list');

      // make one: its route follows its name, and its secret is shown once
      await open(ctx, '/admin/mcps?create=1', tid('mcp-form'));
      await page.type(`${tid('mcp-name')} input`, name);
      await settle(page);
      await ctx.shot('create');
      await page.click(tid('mcp-save'));
      await find(page, 'secret-dialog', 15_000);
      check(!(await page.$eval(tid('secret-value'), (el) => el.textContent)).includes('hmcp_'), 'the secret is hidden until revealed');
      await page.click(tid('secret-reveal'));
      const secret = await page.$eval(tid('secret-value'), (el) => el.textContent.trim());
      check(secret.length > 8, 'the secret shows once revealed');
      await ctx.shot('secret');
      await page.click(tid('secret-done'));
      await settle(page);
      const id = HubMcpId.parse(new URL(page.url()).pathname.split('/')[3]);

      // rules: include the fs system, see the preview, save
      await page.type(tid('mcp-include-systems-input'), 'fs');
      await page.click(tid('mcp-include-systems-add'));
      await find(page, 'rules-changed');
      await page.waitForFunction(() => (document.querySelector('[data-testid="mcp-preview"] [data-group="fns"] .count')?.textContent ?? '0') !== '0', { timeout: 15_000 });
      await ctx.shot('rules');
      // a toast may sit over the bar's sticky place on a phone: bring the bar to the middle first
      await show(page, tid('rules-save'));
      await page.click(tid('rules-save'));
      await page.waitForFunction(() => document.querySelector('[data-testid="rules-changed"]') === null, { timeout: 10_000 });
      const saved = await api.hub.call('mcp', { mcp: id });
      check(saved.rules.include.systems?.some((s) => s === 'fs') === true, 'the rules are saved');

      await inEachScheme(ctx, async (shot) => {
        await open(ctx, `/admin/mcps/${id}`, tid('mcp-rules'));
        await shot('rules-saved');
        await open(ctx, `/admin/mcps/${id}/preview`, tid('mcp-preview'));
        await shot('exposes');
        await open(ctx, `/admin/mcps/${id}/connect`, tid('mcp-connect'));
        check((await page.$eval(tid('mcp-claude'), (el) => el.textContent)).includes('claude mcp add'), 'the connect tab shows the Claude Code command');
        await shot('connect');
        await open(ctx, `/admin/mcps/${id}/activity`, 'main');
        await shot('activity');
      });

      // try it as a client, with the secret
      await open(ctx, `/admin/mcps/${id}/connect`, tid('mcp-try-secret'));
      await page.type(`${tid('mcp-try-secret')} input`, secret);
      await page.click(tid('mcp-try'));
      await page.waitForFunction(() => document.querySelector('[data-testid="mcp-tried"]') !== null || document.querySelector('[data-testid="mcp-connect"] [role="alert"]') !== null, { timeout: 20_000 });
      await show(page, tid('mcp-try'));
      await ctx.shot('tried');
    } finally {
      for (const mcp of (await api.hub.call('mcps', {})).filter((m) => m.name === name)) { await api.hub.call('deleteMcp', { mcp: mcp.id }); }
    }
  },
});
