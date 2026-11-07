/**
 * Pairing by code (admin systems): a throwaway system started here connects without a token, its pairing card shows
 * the code it was given, and approving it connects the system. The system is stopped and removed afterwards.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemName } from '@harness/core';
import { system } from '@harness/sdk';
import { serve } from '@harness/sdk/server';
import { waitFor } from '../../scripts/hub-client.ts';
import { check, feature, find, open, settle, show, tid } from '../kit.ts';

export default feature({
  id: 'pairing', ref: 'admin systems', title: 'Approve a system that pairs by code',
  async run(ctx) {
    const { page, api } = ctx;
    const name = SystemName.parse(`uipair${Date.now().toString(36)}`);
    const state = mkdtempSync(join(tmpdir(), 'harness-ui-pair-'));
    const hub = new URL('/link', ctx.url('/'));
    hub.protocol = hub.protocol === 'https:' ? 'wss:' : 'ws:';
    const running = await serve(system(name, { description: 'A throwaway system the UI tests pair.' }), {}, { hub: hub.toString(), state, version: '0.0.1' });
    try {
      const pairing = await waitFor(`${name} to ask to pair`, async () => (await api.hub.call('pairings', { status: 'pending' })).find((p) => p.name === name), { timeout: 20_000, every: 250 });
      check(pairing.method === 'code' && pairing.code !== undefined, 'a system without a token pairs by code');
      await open(ctx, '/admin/systems', tid('systems'));
      const card = tid(`pairing-${pairing.id}`);
      await page.waitForSelector(card, { timeout: 20_000 });
      const shown = await page.$eval(`${card} ${tid('pairing-code')}`, (el) => el.textContent.replace(/\s/g, ''));
      check(shown === pairing.code.replace(/\s+/g, ''), `the card shows the code the system was given (${shown}, expected ${pairing.code})`);
      await show(page, card);
      await ctx.shot('waiting');
      await page.click(`${card} ${tid('pairing-approve')}`);
      await page.waitForFunction((selector) => document.querySelector(selector) === null, { timeout: 20_000 }, card);
      await find(page, `system-${name}`, 20_000);
      await page.waitForFunction((selector) => !(document.querySelector(selector)?.textContent ?? '').toLowerCase().includes('pairing'), { timeout: 20_000 }, tid(`system-${name}`));
      await show(page, tid(`system-${name}`));
      await settle(page);
      await ctx.shot('paired');
    } finally {
      await running.stop();
      await api.hub.call('removeSystem', { system: name }).catch(() => undefined);
      rmSync(state, { recursive: true, force: true });
    }
  },
});
