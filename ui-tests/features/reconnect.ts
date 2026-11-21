/**
 * Reconnecting (chat-features 2.7, 8.1): the socket drops while a chat is open, a fn runs and finishes meanwhile, and
 * once the hub is reachable again the thread catches up with what it missed (the message and its finished run card)
 * without a reload.
 */
import { QualifiedName, type RunId } from '@harness/core';
import { clientInfo } from '../../scripts/session.ts';
import { check, feature, find, newChat, settle, tid, type FeatureContext } from '../kit.ts';

/** Installed before the app loads: keeps every WebSocket the page opens, so the test can drop them. */
function trackSockets(): void {
  const sockets: WebSocket[] = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
    }
  };
  Reflect.set(window, '__sockets', sockets);
}

/** Close the page's sockets (with the network off, they can't come back until it is on again). */
async function dropSockets(ctx: FeatureContext): Promise<void> {
  await ctx.page.evaluate(() => {
    const sockets: unknown = Reflect.get(window, '__sockets');
    if (!Array.isArray(sockets)) { return; }
    for (const socket of sockets.splice(0)) { if (socket instanceof WebSocket) { socket.close(); } }
  });
}

export default feature({
  id: 'reconnect', ref: 'chat-features 2.7, 8.1', title: 'Catches up after the socket drops',
  async run(ctx) {
    const { page, api } = ctx;
    await page.evaluateOnNewDocument(trackSockets);
    const session = await newChat(ctx);
    await page.reload({ waitUntil: 'networkidle0' });
    await find(page, 'thread', 20_000);
    await settle(page);

    // offline: the page can't reach the hub, and its socket is gone
    await page.setOfflineMode(true);
    await dropSockets(ctx);
    await find(page, 'connection-banner', 10_000);
    await ctx.shot('offline');

    // meanwhile a fn runs in this chat and finishes
    const invoked = await api.hub.call('invoke', { session, fn: QualifiedName.parse('fs/bash'), args: { command: 'ls ui-tests/features/reconnect.ts' }, client: clientInfo() });
    const run: RunId = invoked.run;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const record = await api.hub.call('run', { run });
      if (record.status === 'done') { break; }
      check(Date.now() < deadline, `the run finished while offline (it is ${record.status})`);
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
    check(await page.$(`[data-testid="run-card"][data-run="${run}"]`) === null, 'nothing reached the page while it was offline');

    // back online: the thread fetches what it missed
    await page.setOfflineMode(false);
    await page.waitForSelector(`[data-testid="run-card"][data-run="${run}"][data-status="done"]`, { timeout: 30_000 });
    await settle(page, 600);
    check((await page.$eval(tid('thread'), (el) => el.scrollHeight - el.scrollTop - el.clientHeight)) < 40, 'the caught-up thread sits at its latest message');
    check(await page.$(tid('needs-you')) === null, 'nothing is left waiting after catching up');
    await ctx.shot('caught-up');
  },
});
