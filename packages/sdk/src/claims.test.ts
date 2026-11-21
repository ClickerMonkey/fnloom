/**
 * Parallel claims in the SDK: a fn's claim templates and `dynamicClaims` in its manifest, the `claims` hook a system
 * answers over the link (from the args and the call's context), and `kit.claims` working a call's claims out as the
 * hub does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fn } from './fn.ts';
import { g } from './gin.ts';
import { manifestOf } from './manifest.ts';
import { system, type SystemImpl } from './system.ts';
import { testHub, type TestSystem } from './testing/index.ts';

const files = system('files', { description: 'Files.' }).with({
  fns: {
    write: fn({ description: 'Write a file.', args: g.obj({ path: g.text(), text: g.text() }), returns: g.bool(), parallelClaims: ['file:{args.path}'] }),
    zip: fn({ description: 'Zip files.', args: g.obj({ paths: g.list(g.text()), into: g.optional(g.text()) }), returns: g.bool(), parallelClaims: ['file:{args.paths}', 'file:{args.into|out.zip}'] }),
    move: fn({ description: 'Move a file.', args: g.obj({ from: g.text(), to: g.text() }), returns: g.bool(), parallelClaims: ['move'], dynamicClaims: true }),
    read: fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text() }),
  },
});
type Defs = (typeof files)['defs'];

const impl: SystemImpl<Defs> = {
  fns: {
    write: { async run(_args, ctx) { return ctx.done(true); } },
    zip: { async run(_args, ctx) { return ctx.done(true); } },
    move: {
      async run(_args, ctx) { return ctx.done(true); },
      // a path resolved the way the system resolves it, and who asked
      claims: (args, ctx) => [`file:/root/${args.from}`, `file:/root/${args.to}`, `user:${ctx.user.id}`],
    },
    read: { async run(args, ctx) { return ctx.done(args.path); } },
  },
};

let kit: TestSystem<'files', Defs> | undefined;
afterEach(async () => { await kit?.stop(); kit = undefined; });

describe('parallel claims in a contract', () => {
  it('puts a fn’s claim templates and dynamicClaims in its manifest, and nothing for a fn without them', async () => {
    const manifest = await manifestOf(files, { version: '1.0.0' });
    const decl = (name: string) => manifest.fns.find((f) => f.name === name);
    expect(decl('write')).toMatchObject({ parallelClaims: ['file:{args.path}'] });
    expect(decl('write')?.dynamicClaims).toBeUndefined();
    expect(decl('move')).toMatchObject({ parallelClaims: ['move'], dynamicClaims: true });
    expect(decl('read')).not.toHaveProperty('parallelClaims');
    expect(decl('read')).not.toHaveProperty('dynamicClaims');
  });

  it('refuses to serve a fn with dynamicClaims but no claims hook', async () => {
    const hookless: SystemImpl<Defs> = { fns: { ...impl.fns, move: { async run(_args, ctx) { return ctx.done(true); } } } };
    await expect(testHub(files, hookless)).rejects.toThrow(/declares dynamicClaims, so its implementation needs a claims\(args, ctx\)/);
  });
});

describe('a call’s claims, as the hub works them out', () => {
  it('fills the templates from the args: a list gives one claim per item, a fallback fills an arg left out', async () => {
    kit = await testHub(files, impl);
    expect(await kit.claims('write', { path: 'a.md', text: 'x' })).toEqual(['file:a.md']);
    expect(await kit.claims('zip', { paths: ['a.md', 'b.md'] })).toEqual(['file:a.md', 'file:b.md', 'file:out.zip']);
    expect(await kit.claims('read', { path: 'a.md' })).toEqual([]);
  });

  it('asks the claims hook over the link, with the args and the call’s context, and joins its answer to the templates', async () => {
    kit = await testHub(files, impl);
    const claims = await kit.claims('move', { from: 'a.md', to: 'b.md' });
    expect(claims).toEqual(['move', 'file:/root/a.md', 'file:/root/b.md', expect.stringMatching(/^user:/)]);
  });

  it('answers a claims request for a fn without the hook with no claims', async () => {
    kit = await testHub(files, impl);
    const request = kit.hub.request('files/read', { path: 'a.md' });
    expect(await kit.hub.claims({ fn: 'read', args: { path: 'a.md' }, user: request.run.user, caller: request.run.id })).toEqual({ claims: [] });
  });
});
