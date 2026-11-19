/**
 * Build 6 on the system side, against the in-memory hub: one runtime patch for every section (context by key, a
 * contract fn removed, lists replaced), fn examples while running, a kind's cost hook, and aeye through the hub with
 * the hub's real models in a run (`ctx.ai()`), outside one (`hubAi`) and over the test fake.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FleetInstance, type ContextDecl, type HubModelInfo } from '@harness/core';
import { context, kind } from '../declare.ts';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { manifestOf } from '../manifest.ts';
import { system } from '../system.ts';
import { hubAi, serve, type RunningSystem } from './index.ts';
import { FakeHub, FakeModelLink, fakeHubAi } from './testing.ts';

const notes = system('notes', { description: 'Notes for tests.' }).with({
  kinds: { query: kind({ description: 'A saved query.', applicability: 'Reads.', payload: g.obj({ sql: g.text() }), estimates: true }) },
  fns: {
    ask: fn({ description: 'Ask a model.', args: g.obj({ q: g.text() }), returns: g.text() }),
    old: fn({ description: 'Going away.', args: g.obj({}), returns: g.text() }),
  },
  context: { guide: context({ description: 'The guide.', content: 'v1' }) },
});

const SMALL: HubModelInfo = {
  id: 'small', provider: 'openrouter', name: 'Small', capabilities: ['chat', 'streaming'], tier: 'efficient', pricing: { input: 0, output: 0 }, roles: ['chat'],
};

let running: RunningSystem<'notes'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function start(hub: FakeHub): Promise<RunningSystem<'notes'>> {
  running = await serve(notes, {
    fns: {
      ask: { async run(args, ctx) { return ctx.done((await (await ctx.ai()).chat.get({ messages: [{ role: 'user', content: args.q }] })).content); } },
      old: { async run(_args, ctx) { return ctx.done('old'); } },
    },
    kinds: {
      query: {
        async check() { return []; },
        async describe() { return { args: { name: 'obj' }, returns: { name: 'num' }, deps: [], operations: { cancel: true, pause: false, undo: false, background: true }, examples: [{ args: {} }] }; },
        async run(_payload, _args, ctx) { return ctx.done(1); },
        async estimate(payload, input) {
          return { min: 0, typical: payload.sql.length / 1000, max: 1, basis: 'payload', runs: input.history?.runs ?? 0 };
        },
      },
    },
  }, { hub: 'ws://hub.test/link', state: 'unused', version: '1.0.0' }, hub.host());
  await running.ready();
  return running;
}

const guide = (content: string): ContextDecl => ({
  name: 'guide', title: 'The guide', description: 'The guide.', content, imports: [], fns: ['notes/ask'], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [],
});

describe('runtime patches', () => {
  it('replaces context by key, removes a contract fn so it stops running, and replaces the lists, with the hash of the result', async () => {
    const hub = new FakeHub();
    const system = await start(hub);
    await system.patch({
      upsert: { context: [guide('v2'), { ...guide('new'), name: 'extra' }], settings: [{ name: 'tone', description: 'Tone.', type: { name: 'text' }, appliesTo: ['user'], merge: 'user-wins', editableBy: ['self'] }] },
      remove: { fns: ['old'] },
      lists: { contributes: [{ registry: 'notes/views', name: 'list', label: 'List' }] },
      roots: true,
    });
    const sent = hub.patches.at(-1);
    expect(sent?.upsert.context?.map((c) => c.name)).toEqual(['guide', 'extra']);
    expect(sent?.remove.fns).toEqual(['old']);
    expect(sent?.roots).toBe(true);
    const run = await hub.run('notes/old', {});
    expect(run.status).not.toBe('done');

    await expect(system.patch({ upsert: { hooks: [{ name: 'nope', description: 'No code.', order: 1, timeout: 1_000 }] } })).rejects.toThrow(/no implementation/);
    await expect(system.patch({ remove: { context: ['missing'] } })).rejects.toThrow(/no context entry missing/);
    const native = (await manifestOf(notes, { version: '1' })).fns.find((decl) => decl.name === 'ask');
    if (native === undefined) { throw new Error('the contract lost ask'); }
    await expect(system.patch({ upsert: { fns: [{ ...native, name: 'brand_new' }] } })).rejects.toThrow(/add it with its implementation/);
  });

  it('sends fn examples to the hub by key', async () => {
    const hub = new FakeHub();
    const system = await start(hub);
    expect(await system.examples('ask', { upsert: [{ key: 'weather', args: { q: 'Weather?' }, note: 'A plain question.' }], remove: ['stale'] })).toEqual({ added: 1, removed: 1 });
    expect(hub.exampleChanges).toEqual([{ fn: 'ask', upsert: [{ key: 'weather', args: { q: 'Weather?' }, note: 'A plain question.' }], remove: ['stale'] }]);
    await expect(system.examples('nothing', {})).rejects.toThrow(/no fn nothing/);
  });

  it('lists its fleet as the system itself', async () => {
    const hub = new FakeHub();
    hub.onFleet = () => Promise.resolve([FleetInstance.parse({ instance: 'main', description: 'The main notes.', online: true, config: {}, types: [] })]);
    const system = await start(hub);
    expect((await system.fleet()).map((f) => f.instance)).toEqual(['main']);
  });
});

describe('kind cost hook', () => {
  it('declares estimates and answers estimate from the payload', async () => {
    expect((await manifestOf(notes, { version: '1' })).kinds[0]?.estimates).toBe(true);
    const hub = new FakeHub();
    await start(hub);
    expect(await hub.estimate({ kind: 'notes/query', payload: { sql: 'select 1' } })).toEqual({ estimate: { min: 0, typical: 0.008, max: 1, basis: 'payload', runs: 0 } });
  });

  it('refuses a kind that says it estimates without the hook', async () => {
    const hub = new FakeHub();
    const bad = system('bad', { description: 'Bad.' }).with({ kinds: { k: kind({ description: 'K.', applicability: 'K.', payload: g.obj({}), estimates: true }) } });
    await expect(serve(bad, { kinds: { k: { async check() { return []; }, async describe() { throw new Error('unused'); }, async run(_p, _a, ctx) { return ctx.done(null); } } } }, { hub: 'ws://hub.test/link', state: 'unused' }, hub.host()))
      .rejects.toThrow(/needs an estimate/);
  });
});

describe('aeye through the hub', () => {
  it('gives a run the hub\'s models, forwarding the model aeye picks on the run\'s budget, and the system its own outside runs', async () => {
    const hub = new FakeHub();
    hub.onModels = () => Promise.resolve([SMALL]);
    const system = await start(hub);
    const outcome = await hub.run('notes/ask', { q: 'hi' });
    expect(outcome).toMatchObject({ status: 'done', result: 'ok' });
    expect(hub.forwards[0]).toMatchObject({ model: { model: 'openrouter/small' } });
    expect(hub.forwards[0]?.run).toBeDefined();

    const ai = await hubAi(system);
    expect([...new Set(ai.models.list().map((m) => m.id))].sort()).toEqual(['openrouter/small', 'role/chat']);
    await ai.chat.get({ messages: [{ role: 'user', content: 'tick' }] }, { metadata: { model: 'role/chat' } });
    expect(hub.forwards[1]?.run).toBeUndefined();
    expect(hub.forwards[1]?.model).toEqual({ model: 'openrouter/small' });
  });

  it('has a fake of the same type for unit tests', async () => {
    const link = new FakeModelLink({ models: [SMALL], reply: (forward) => `echo ${forward.request.messages.length}` });
    const ai = await fakeHubAi(link);
    expect((await ai.chat.get({ messages: [{ role: 'user', content: 'x' }] })).content).toBe('echo 1');
    expect(link.forwards[0]?.model).toEqual({ model: 'openrouter/small' });
  });
});
