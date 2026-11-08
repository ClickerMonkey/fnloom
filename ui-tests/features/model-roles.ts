/**
 * Model roles (build 2 design 3.2): the Roles tab of the models page, each role's editor from the URL
 * (`?role=dictate`), switching dictation to a model and seeing the composer's mic follow, then back to the browser,
 * and each model's limits. The hub's own roles are put back as they were.
 */
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, openSession, settle, tid } from '../kit.ts';

export default feature({
  id: 'model-roles', ref: 'build-2 3.2', title: 'Model roles and limits', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api } = ctx;
    const before = (await api.hub.call('modelRoles', {})).find((r) => r.role === 'dictate');
    try {
      await inEachScheme(ctx, async (shot) => {
        await open(ctx, '/admin/models/roles', tid('roles'));
        check(await page.$$eval(`${tid('roles')} [data-role]`, (rows) => rows.length) === 6, 'the roles tab lists every role');
        await shot('roles');
        await open(ctx, '/admin/models/limits', tid('model-limits'));
        await shot('limits');
        const model = await page.$eval(`${tid('model-limits')} [data-model]`, (row) => row.getAttribute('data-model') ?? '');
        await open(ctx, `/admin/models/limits?model=${encodeURIComponent(model)}`, tid('limits-form'));
        await settle(page);
        await shot('limits-editor');
      });

      // dictation by a model: the editor from the URL, a hearing model chosen, saved
      await open(ctx, '/admin/models/roles?role=dictate', tid('role-form'));
      await page.click(`${tid('role-engine')} [role="radio"]:last-child`);
      await find(page, 'role-model');
      // the searchable picker offers only models that can hear (no video or chat-only models)
      const choices = await page.$$eval(`${tid('role-model')} [data-model]`, (rows) => rows.map((o) => o.getAttribute('data-model') ?? '').filter((v) => v !== '' && v !== 'default'));
      check(choices.length > 0, 'the role offers models to pick');
      await page.click(`${tid('role-model')} [data-model="${choices[0] ?? ''}"]`);
      await settle(page);
      await ctx.shot('dictate-model');
      await page.click(tid('role-save'));
      await page.waitForFunction(() => !new URL(location.href).searchParams.has('role'), { timeout: 10_000 });
      const saved = (await api.hub.call('modelRoles', {})).find((r) => r.role === 'dictate');
      check(saved?.choice?.role === 'dictate' && saved.choice.engine.engine === 'model', 'dictation is set to a model');
      await ctx.shot('dictate-saved');

      // the composer offers dictation once a model can hear (the mic shows where the browser can record)
      await openSession(ctx);
      const caps = await api.hub.call('capabilities', {});
      check(caps.voiceInput && caps.dictation?.engine === 'model', 'the chat hears dictation by the model');
      await ctx.shot('composer-mic');

      // back to the browser's speech recognition
      await open(ctx, '/admin/models/roles?role=dictate', tid('role-form'));
      await page.click(`${tid('role-engine')} [role="radio"]:first-child`);
      await page.click(tid('role-save'));
      await page.waitForFunction(() => !new URL(location.href).searchParams.has('role'), { timeout: 10_000 });
      const back = (await api.hub.call('capabilities', {})).dictation;
      check(back?.engine === 'browser', `dictation is back in the browser (got ${back?.engine ?? 'none'})`);
    } finally {
      if (before?.from === 'setting' && before.choice !== undefined) { await api.hub.call('setModelRole', before.choice); } else { await api.hub.call('clearModelRole', { role: 'dictate' }); }
    }
  },
});
