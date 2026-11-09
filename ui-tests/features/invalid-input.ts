/**
 * Refused input (build 2 design 3.13): a run whose args the hub refused shows softly as "Retried" (a dashed, quiet
 * card, never red), and its details list each problem and what the model wrote. Uses a run that settled
 * `invalid-input` (asking the agent for one with the wrong args when the hub has none yet).
 */
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, show, tid } from '../kit.ts';
import { ask, SessionWatch } from '../../scripts/session.ts';

export default feature({
  id: 'invalid-input', ref: 'build-2 3.13', title: 'Refused input, retried', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api } = ctx;
    let found = (await api.hub.call('runs', { query: { filters: [{ field: 'status', op: 'is' as const, value: 'invalid-input' }], limit: 1 } })).items[0];
    if (found === undefined) {
      // a scripted ask: the mock hub refuses the first call of a message that says "bad args"; a model is told to err
      const session = await api.hub.call('createSession', { title: 'UI invalid input' });
      const watch = new SessionWatch(api, session.id);
      try {
        await ask(api, watch, 'bad args: call fs/read with {"file": "README.md"} (the wrong field name), then again correctly with path.', 180_000);
      } finally {
        watch.stop();
      }
      found = (await api.hub.call('runs', { query: { filters: [{ field: 'status', op: 'is' as const, value: 'invalid-input' }], limit: 1 } })).items[0];
    }
    check(found?.session !== undefined, 'a run with refused input exists in a chat');
    const { session, id } = found;

    await inEachScheme(ctx, async (shot) => {
      await open(ctx, `/chat/${session}`, `[data-run="${id}"]`);
      const card = `[data-run="${id}"]`;
      check(await page.$eval(card, (el) => el.getAttribute('data-status')) === 'invalid-input', 'the card has the refused status');
      check(await page.$eval(card, (el) => getComputedStyle(el).borderStyle) === 'dashed', 'the card is dashed, not red');
      await show(page, card);
      await shot('card');
      await open(ctx, `/chat/${session}?run=${id}`, tid('run-details'));
      await find(page, 'run-invalid');
      check(await page.$$eval(`${tid('run-invalid')} li`, (items) => items.length) > 0, 'the details list what was wrong');
      check(await page.$(tid('run-error')) === null, 'no error is shown for refused input');
      await settle(page);
      await shot('details');
    });
  },
});
