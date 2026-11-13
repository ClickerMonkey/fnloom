/**
 * Build 9's fleet pages, which only rendering can check: the MCP servers list with a server's state, the add dialog
 * switched to a command, a server's overview and settings, an API service's settings with a kept token, and the MCP
 * connect page's instance cards.
 */
import type { Scenario } from '../harness.ts';
import { adminPage, check, settle, signedIn, tracked } from './steps.ts';

export const build9: Scenario = {
  name: 'build9',
  description: 'MCP servers and API services: list, add, overview, settings, and connecting to one instance.',
  async run(ctx) {
    const { page } = ctx;
    await tracked(ctx, async (shot) => {
      await adminPage(ctx, '/admin/mcp-servers', '[data-testid="mcp-servers"] [data-testid="status"]');
      await shot('mcp-servers');

      await page.click('[data-testid="add-mcp-server"]');
      await page.waitForSelector('[data-testid="mcp-server-form"]');
      await page.click('[data-testid="server-transport"] button:last-child');
      await page.waitForSelector('[data-testid="server-command"]');
      await page.type('[data-testid="server-label"] input', 'Git Hub');
      check(await page.$eval('[data-testid="instance-name"] input', (el) => (el instanceof HTMLInputElement ? el.value : '')) === 'git-hub', 'the instance name should follow the label');
      await settle(page);
      await shot('mcp-add-command');
      await page.keyboard.press('Escape');

      await adminPage(ctx, '/admin/mcp-servers/linear', '[data-testid="server-needs-auth"]');
      await shot('mcp-server');
      await adminPage(ctx, '/admin/mcp-servers/linear/settings', '[data-testid="server-settings"] [data-testid="remote-auth"]');
      await shot('mcp-server-settings');

      await adminPage(ctx, '/admin/api-services/github/settings', '[data-testid="auth-token"]');
      const placeholder = await page.$eval('[data-testid="auth-token"] input', (el) => (el instanceof HTMLInputElement ? el.placeholder : ''));
      check(placeholder.startsWith('Kept'), 'a kept token should read as kept');
      await shot('api-service-settings');

      await signedIn(ctx, '/connect/mcp');
      await page.waitForSelector('[data-testid="instance-connect"]');
      await settle(page);
      await shot('connect-instances');
    });
  },
};
