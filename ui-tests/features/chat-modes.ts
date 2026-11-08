/**
 * Chat modes (build 2 design 3.3, 3.4): a chat's settings pick its chat mode and contextor (the agent's own, or one
 * for this chat, with its settings in the gin value editor), saved on the session; the settings panel is in the URL.
 * The fixture chat goes back to the agent's choices afterwards.
 */
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, show, tid } from '../kit.ts';

export default feature({
  id: 'chat-modes', ref: 'build-2 3.3', title: 'Chat modes and contextors', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api, fixtures } = ctx;
    const url = `/chat/${fixtures.session}?panel=settings`;
    try {
      await inEachScheme(ctx, async (shot) => {
        await open(ctx, url, tid('session-settings'));
        await show(page, tid('session-prompt'));
        await shot('settings');
      });

      // a static toolset for this chat, with its settings in the value editor
      await open(ctx, url, tid('session-mode'));
      await page.select(`${tid('session-mode-type')} select`, 'static');
      await page.waitForFunction(() => document.querySelector('[data-testid="session-mode"] [data-testid="gin-value-view"]') !== null, { timeout: 10_000 });
      const mode = (await api.hub.call('session', { session: fixtures.session })).mode;
      check(mode?.type === 'static', `the chat's mode is the static toolset (got ${mode?.type ?? 'the agent’s'})`);
      await show(page, tid('session-mode'));
      await ctx.shot('static');

      // the context graph contextor
      await page.select(`${tid('session-contextor-type')} select`, 'graph');
      await page.waitForFunction(() => document.querySelector('[data-testid="session-contextor"] [data-testid="gin-value-view"]') !== null, { timeout: 10_000 });
      const contextor = (await api.hub.call('session', { session: fixtures.session })).contextor;
      check(contextor?.type === 'graph', 'the chat uses the context graph');
      await show(page, tid('session-contextor'));
      await settle(page);
      await ctx.shot('graph');

      // a reload keeps the panel and the choices
      await page.reload({ waitUntil: 'networkidle0' });
      await find(page, 'session-settings');
      check(await page.$eval(`${tid('session-mode-type')} select`, (el) => (el instanceof HTMLSelectElement ? el.value : '')) === 'static', 'the mode shows after a reload');

      // back to the agent's own
      await page.select(`${tid('session-mode-type')} select`, 'agent');
      await page.waitForFunction(() => document.querySelector('[data-testid="session-mode"] [data-testid="gin-value-view"]') === null, { timeout: 10_000 });
      check((await api.hub.call('session', { session: fixtures.session })).mode === undefined, 'the chat follows the agent’s mode again');
    } finally {
      await api.hub.call('updateSession', { session: fixtures.session, mode: null, contextor: null });
    }
  },
});
