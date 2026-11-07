/**
 * The admin pages, in three scenarios:
 * - `admin-systems`: the systems list with a pairing request (approve it), a system's tabs in the URL (overview with
 *   its switches and process, the config form made from its config type, its fns, its live output), and the pairing
 *   token and install dialogs.
 * - `admin-rules`: providers, models and categories; budgets, priorities and the resolved view (kept in the URL);
 *   policies; actor settings with their typed form.
 * - `admin-browsers`: runs, LLM calls and resources, each opening an item beside or over the list, kept across a
 *   reload.
 */
import type { Scenario } from '../harness.ts';
import { adminPage, check, closeDialog, settle, tracked } from './steps.ts';

export const adminSystems: Scenario = {
  name: 'admin-systems',
  description: 'Systems and pairing, a system tab by tab (overview, config, fns, live output), the token and install dialogs.',
  async run(ctx) {
    const { page, url } = ctx;
    await tracked(ctx, async (shot) => {
      // a pairing request is waiting (another arrives live soon after one is answered)
      await adminPage(ctx, '/admin/systems', '[data-testid="systems"]');
      const request = await page.waitForSelector('article[data-testid^="pairing-"]', { timeout: 5_000 });
      const id = await request?.evaluate((el) => el.getAttribute('data-testid')?.replace('pairing-', '') ?? '');
      await page.goto(url(`/admin/systems?pairing=${id ?? ''}`), { waitUntil: 'networkidle0' });
      await page.waitForSelector('article.highlight[data-testid^="pairing-"]');
      await settle(page);
      await shot('list');

      await page.click('[data-testid="open-token"]');
      await page.waitForSelector('[data-testid="token-create"]');
      await settle(page, 300);
      await shot('token');
      await page.click('[data-testid="token-create"]');
      await page.waitForSelector('[data-testid="token-made"]');
      await settle(page, 300);
      await shot('token-made');
      await closeDialog(page);

      await page.click('[data-testid="open-install"]');
      await page.waitForSelector('[data-testid="install-form"]');
      await page.click('[data-testid="install-submit"]');
      await settle(page, 300);
      await shot('install-problems');
      await closeDialog(page);

      await page.click(`[data-testid="pairing-${id ?? ''}"] [data-testid="pairing-approve"]`);
      await page.waitForFunction((gone) => document.querySelector(`[data-testid="pairing-${gone}"]`) === null, {}, id);

      await page.click('[data-testid="system-fs"]');
      await page.waitForSelector('[data-testid="enable-functions"]');
      await settle(page);
      await shot('overview');
      const toggle = '[data-testid="enable-renderers"] [role="switch"]';
      const was = await page.$eval(toggle, (el) => el.getAttribute('aria-checked'));
      await page.click(toggle);
      await page.waitForFunction((sel, before) => document.querySelector(sel)?.getAttribute('aria-checked') !== before, {}, toggle, was);

      await page.goto(url('/admin/systems/fs/config'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="gin-form"]');
      await settle(page);
      await shot('config');

      await page.goto(url('/admin/systems/fs/fns'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="fns"] li');
      await settle(page);
      await shot('fns');

      await page.goto(url('/admin/systems/fs/logs'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="log"] .line');
      const before = await page.$$eval('[data-testid="log"] .line', (lines) => lines.length);
      await page.waitForFunction((count) => document.querySelectorAll('[data-testid="log"] .line').length > count, { timeout: 6_000 }, before);
      await settle(page);
      await shot('output');
      const selected = await page.$eval('[role="tab"][aria-selected="true"]', (el) => el.textContent.trim());
      check(selected === 'Output', `the Output tab should be chosen from the URL, got "${selected}"`);
    });
  },
};

export const adminRules: Scenario = {
  name: 'admin-rules',
  description: 'Providers, models and categories; budgets, priorities and the resolved view; policies; actor settings.',
  async run(ctx) {
    const { page, url } = ctx;
    await tracked(ctx, async (shot) => {
      await adminPage(ctx, '/admin/models', '[data-testid="providers"]');
      await shot('providers');
      await page.click('[data-testid="providers"] [data-testid="add"]');
      await page.waitForSelector('[data-testid="provider-form"]');
      await page.click('[data-testid="provider-save"]');
      await settle(page, 300);
      await shot('provider-form');
      await closeDialog(page);

      await page.goto(url('/admin/models/models'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="models"] li');
      await settle(page);
      await shot('models');

      await page.goto(url('/admin/models/categories'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="categories"] li');
      await page.click('[data-testid="categories"] [data-testid="edit"]');
      await page.waitForSelector('[data-testid="category-form"]');
      await settle(page, 300);
      await shot('category');
      await closeDialog(page);

      await page.goto(url('/admin/limits'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="budgets"] li');
      await settle(page);
      await shot('budgets');
      await page.click('[data-testid="budgets"] [data-testid="add"]');
      await page.waitForSelector('[data-testid="budget-form"]');
      await settle(page, 300);
      await shot('budget-form');
      await closeDialog(page);

      await page.goto(url('/admin/limits/priorities'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="priorities"] li');
      await settle(page);
      await shot('priorities');

      await page.goto(url('/admin/limits/resolved?user=act_grace'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="resolved"]');
      await settle(page);
      await shot('resolved');

      await page.goto(url('/admin/policies'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="policies"] li');
      await settle(page);
      await shot('policies');
      await page.click('[data-testid="new-policy"]');
      await page.waitForSelector('[data-testid="policy-form"]');
      await settle(page, 300);
      await shot('policy-form');
      await closeDialog(page);

      await page.goto(url('/admin/actor-settings'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="setting-db/rows"]');
      await settle(page);
      await shot('settings');
      await page.click('[data-testid="setting-add"]');
      await page.waitForSelector('[data-testid="setting-form"]');
      await page.select('[data-testid="setting-form"] select', 'act_ops');
      await page.waitForSelector('[data-testid="setting-form"] [data-testid="gin-form"]');
      await settle(page, 300);
      await shot('setting-form');
      await closeDialog(page);
    });
  },
};

export const adminBrowsers: Scenario = {
  name: 'admin-browsers',
  description: 'Runs, LLM calls and resources: filter, open one beside the list, and keep it across a reload.',
  async run(ctx) {
    const { page, url } = ctx;
    await tracked(ctx, async (shot) => {
      await adminPage(ctx, '/admin/runs', '[data-testid^="run-"]');
      await shot('runs');
      await page.click('[data-testid^="run-"]');
      await page.waitForFunction(() => new URL(location.href).searchParams.has('run'));
      await page.waitForSelector('[data-testid="run-details"]');
      await settle(page);
      await shot('run');
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="run-details"]');
      check(new URL(page.url()).searchParams.has('run'), 'the opened run should survive a reload');
      await page.goto(url('/admin/runs?status=failed'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="admin"] .ui-empty, [data-testid^="run-"]');
      await settle(page);
      await shot('runs-failed');

      await page.goto(url('/admin/llm'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid^="llm-"]');
      await settle(page);
      await shot('llm');
      await page.click('[data-testid^="llm-"]');
      await page.waitForFunction(() => new URL(location.href).searchParams.has('call'));
      await page.waitForSelector('[data-testid="chat-panel"] [role="tablist"]');
      await settle(page);
      await shot('llm-call');

      await page.goto(url('/admin/resources'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="resource-harness.md"]');
      await settle(page);
      await shot('resources');
      await page.click('[data-testid="resource-harness.md"]');
      await page.waitForSelector('[data-testid="resource-view"] .markdown');
      await settle(page);
      await shot('resource');
    });
  },
};
