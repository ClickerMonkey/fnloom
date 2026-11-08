/**
 * QR pairing (build 2 design 3.10): the page a system's QR code opens (`/pair/:pairing?code=`), phone first. It shows
 * the system and whether the link's code is the one it shows, takes the instance name and the config the system asks
 * for, pairs in one step, and follows the system until it is connected. A throwaway system with a config type is
 * started here with only the hub's URL, so each run has one waiting (the mock hub always has one); it is stopped and
 * removed afterwards.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemName } from '@harness/core';
import { g, system } from '@harness/sdk';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { waitFor } from '../../scripts/hub-client.ts';
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, show, tid } from '../kit.ts';

/** Start a throwaway system that asks to pair, with a config the page asks for; none against the mock hub. */
async function waitingSystem(hubUrl: string, mock: boolean): Promise<{ name: SystemName; running: RunningSystem<string>; state: string } | undefined> {
  if (mock) { return undefined; }
  const name = SystemName.parse(`uiqr${Date.now().toString(36)}`);
  const state = mkdtempSync(join(tmpdir(), 'harness-ui-qr-'));
  const link = new URL('/link', hubUrl);
  link.protocol = link.protocol === 'https:' ? 'wss:' : 'ws:';
  const contract = system(name, { description: 'A throwaway system the UI tests pair by its QR link.' }).with({ config: g.obj({ label: g.text() }) });
  const running = await serve(contract, {}, { hub: link.toString(), state, version: '0.0.1' });
  return { name, running, state };
}

export default feature({
  id: 'qr-pairing', ref: 'build-2 3.10', title: 'QR pairing page', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api } = ctx;
    const pending = await api.hub.call('pairings', { status: 'pending' });
    const started = await waitingSystem(ctx.url('/'), ctx.mock);
    try {
      const request = started === undefined
        ? pending.find((p) => p.expiresAt > Date.now())
        : await waitFor(`${started.name} to ask to pair`, async () => (await api.hub.call('pairings', { status: 'pending' })).find((p) => p.name === started.name && p.configType !== undefined), { timeout: 20_000, every: 250 });
      check(request !== undefined, 'a system is waiting to pair');
      const link = `/pair/${request.id}${request.code === undefined ? '' : `?code=${request.code}`}`;

      await inEachScheme(ctx, async (shot) => {
        await open(ctx, link, tid('pair-system'));
        if (request.code !== undefined) { check((await page.$eval(tid('pair-code-check'), (el) => el.textContent)).includes('Matches'), 'the link’s code matches'); }
        await shot('request');
        await open(ctx, `/pair/${request.id}?code=000000`, tid('pair-system'));
        if (request.code !== undefined && request.code !== '000000') {
          check(await page.$eval(tid('pair-approve'), (el) => el instanceof HTMLButtonElement && el.disabled), 'a wrong code can’t pair');
          await shot('wrong-code');
        }
      });

      await open(ctx, link, tid('pair-instance'));
      await page.click(`${tid('pair-instance')} input`, { count: 3 });
      await page.type(`${tid('pair-instance')} input`, `ui-${Date.now().toString(36)}`);
      if (await page.$(tid('pair-config')) !== null) {
        // fill each text field of the config form, and add a row to each list it has
        for (const add of await page.$$(`${tid('pair-config')} [data-testid="gin-list-add"]`)) { await add.click(); }
        for (const input of await page.$$(`${tid('pair-config')} input[type="text"], ${tid('pair-config')} input:not([type])`)) { await input.type('ui-tests'); }
        await show(page, tid('pair-config'));
        await ctx.shot('config');
      }
      await page.waitForFunction(() => { const button = document.querySelector('[data-testid="pair-approve"]'); return button instanceof HTMLButtonElement && !button.disabled; }, { timeout: 10_000 });
      await page.click(tid('pair-approve'));
      await find(page, 'pair-done', 20_000);
      await page.waitForFunction(() => document.querySelector('[data-testid="pair-done"]')?.getAttribute('data-phase') !== 'joining', { timeout: 30_000 });
      await settle(page);
      await ctx.shot('paired');
      const phase = await page.$eval(tid('pair-done'), (el) => el.getAttribute('data-phase'));
      check(phase === 'connected' || phase === 'needs-config', `the system joined (${phase ?? 'unknown'})`);
    } finally {
      if (started !== undefined) {
        await started.running.stop();
        await api.hub.call('removeSystem', { system: started.name }).catch(() => undefined);
        rmSync(started.state, { recursive: true, force: true });
      }
    }
  },
});
