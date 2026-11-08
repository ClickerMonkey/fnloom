/**
 * Every model call (build 2 design 3.16): the model calls browser with its kind filter (chat, embeddings, images,
 * transcription, speech) in the URL, a call opened beside the list or in a sheet, and a chat call showing what the
 * model saw and said.
 */
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'model-calls', ref: 'build-2 3.16', title: 'Model calls', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api } = ctx;
    const chat = (await api.hub.call('modelCalls', { modality: 'chat', limit: 1 })).items[0];
    check(chat !== undefined, 'the hub has made a chat model call');

    await inEachScheme(ctx, async (shot) => {
      await open(ctx, '/admin/model-calls', '[data-testid^="model-call-"]');
      await shot('list');
      await open(ctx, '/admin/model-calls?modality=chat', '[data-testid^="model-call-"]');
      check(await page.$eval(`${tid('filter-modality')} select`, (el) => (el instanceof HTMLSelectElement ? el.value : '')) === 'chat', 'the kind filter reads the URL');
      await shot('chat-only');
      await open(ctx, `/admin/model-calls?call=${chat.id}`, tid('model-call'));
      if (chat.interaction !== undefined) { await find(page, 'llm-call'); }
      await settle(page);
      await shot('opened');
    });

    const other = (await api.hub.call('modelCalls', { limit: 50 })).items.find((c) => c.modality !== 'chat');
    if (other !== undefined) {
      await open(ctx, `/admin/model-calls?call=${other.id}`, tid('model-call'));
      check(await page.$(tid('llm-call')) === null, 'a call that isn’t chat shows its own units, not a conversation');
      await ctx.shot('other-modality');
    }
  },
});
