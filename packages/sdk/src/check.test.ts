/**
 * A fn's args check in the SDK (`fn({ check })`): the deps it calls in the manifest (as qualified names), the
 * `checkArgs` hook a system answers over the link with only the check's deps to call, under `check:` keys so they never
 * share a key with the run's own calls, and serving refused when the implementation has no `check`.
 */
import { Json } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { fn } from './fn.ts';
import { g } from './gin.ts';
import { hub } from './hub.ts';
import { manifestOf } from './manifest.ts';
import { system, type SystemImpl } from './system.ts';
import { testHub, type TestSystem } from './testing/index.ts';

const args = g.obj({ fn: g.fnName(), limit: g.num() });
const checking = system('checking', { description: 'Checks its args.' }).with({
  fns: {
    add: fn({ description: 'Add one.', args, returns: g.bool(), deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save }, check: { calls: ['getFn'] } }),
    plain: fn({ description: 'Plain.', args, returns: g.bool(), check: true }),
    none: fn({ description: 'None.', args, returns: g.bool() }),
  },
});
type Defs = (typeof checking)['defs'];

/** The deps each check found on its ctx, by fn. */
const seen: Record<string, string[]> = {};

const impl: SystemImpl<Defs> = {
  fns: {
    add: {
      async run(_args, ctx) { return ctx.done(true); },
      async check(input, ctx) {
        seen['add'] = Object.keys(ctx.fns);
        const target = await ctx.fns.getFn({ fn: input.fn });
        return target.available ? [] : [{ path: 'fn', message: `${input.fn} can't run for ${ctx.user.name} now.` }];
      },
    },
    plain: { async run(_args, ctx) { return ctx.done(true); }, check: (input) => Promise.resolve(input.limit > 0 ? [] : [{ path: 'limit', message: 'more than 0' }]) },
    none: { async run(_args, ctx) { return ctx.done(true); } },
  },
};

let kit: TestSystem<'checking', Defs> | undefined;
afterEach(async () => { await kit?.stop(); kit = undefined; });

describe('a fn that checks its args before approval', () => {
  it('puts the deps its check calls in its manifest, and nothing for a fn without one', async () => {
    const manifest = await manifestOf(checking, { version: '1.0.0' });
    const decl = (name: string) => manifest.fns.find((f) => f.name === name);
    expect(decl('add')?.check).toEqual({ deps: ['hub/fns_get'] });
    expect(decl('plain')?.check).toEqual({ deps: [] });
    expect(decl('none')).not.toHaveProperty('check');
  });

  it('answers the hub with its problems, calling only its own deps under check: keys', async () => {
    kit = await testHub(checking, impl);
    kit.hub.onCall = (call) => Promise.resolve({ status: 'done', result: Json.parse({ fn: 'demo/x', kind: 'native', description: 'X.', version: 1, available: call.args !== null && JSON.stringify(call.args).includes('demo/ok') }) });
    const bad = await kit.check('add', { fn: 'demo/gone', limit: 1 });
    expect(bad.problems).toEqual([{ path: 'fn', message: 'demo/gone can\'t run for Tess Tester now.' }]);
    expect(bad.hubCalls.calls).toMatchObject([{ fn: 'hub/fns_get', args: { fn: 'demo/gone' }, key: 'check:getFn#1' }]);
    expect(seen['add']).toEqual(['getFn']);
    expect((await kit.check('add', { fn: 'demo/ok', limit: 1 })).problems).toEqual([]);
    expect((await kit.check('plain', { fn: 'demo/ok', limit: 0 })).problems).toEqual([{ path: 'limit', message: 'more than 0' }]);
    // a fn that declares no check finds nothing, and asks the hub nothing
    const none = await kit.check('none', { fn: 'demo/ok', limit: 0 });
    expect(none).toMatchObject({ problems: [], hubCalls: { calls: [] } });
  });

  it('refuses to serve a fn that declares check without one in its implementation', async () => {
    const hookless: SystemImpl<Defs> = { fns: { ...impl.fns, plain: { async run(_args, ctx) { return ctx.done(true); } } } } as SystemImpl<Defs>;
    await expect(testHub(checking, hookless)).rejects.toThrow(/declares check, so its implementation needs a check\(args, ctx\)/);
  });
});
