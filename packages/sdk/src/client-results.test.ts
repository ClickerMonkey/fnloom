/**
 * The result-renderer slot (`client({ results })`, item 9): a fn's own result renderer gets its run decoded with the
 * fn's gin types, a kind's gets the JSON as it is with its own system's client, a fn renderer is a separate slot, and
 * a result that doesn't fit its fn's type gets no renderer (the app draws its default).
 */
import { mintId, QualifiedName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { h } from 'vue';
import { client, type FnViewOf, type ResultView, type ResultViewOf, type WithSystem } from './client.ts';
import { ClientRuntime, type ClientBridge } from './client-runtime.ts';
import { kind } from './declare.ts';
import { fn, type UntypedFn } from './fn.ts';
import { g } from './gin.ts';
import { system } from './system.ts';

const log = system('log', { description: 'A log.' }).with({
  kinds: { tail: kind({ description: 'A tail.', applicability: 'Reads.', payload: g.obj({}) }) },
  fns: {
    stamp: fn({ description: 'Stamp.', args: g.obj({ at: g.timestamp() }), returns: g.obj({ at: g.timestamp() }) }),
    shout: fn({ description: 'Shout.', args: g.obj({ text: g.text() }), returns: g.text() }),
  },
});

const bridge: ClientBridge = {
  online: () => true,
  act: () => Promise.resolve(mintId('delivery')),
  submit: () => Promise.resolve(mintId('delivery')),
  invoke: () => Promise.resolve(mintId('run')),
  follow: () => Promise.resolve(true),
};

const Stamped = (view: ResultViewOf<typeof log, 'stamp'>) => h('time', `${view.title}: ${view.result.at.toISOString()}`);
const Tailed = (view: ResultView<UntypedFn> & WithSystem<(typeof log)['defs']>) => h('pre', JSON.stringify(view.result));
const Shouting = (view: FnViewOf<typeof log, 'shout'>) => h('b', view.args.text);
const at = '2026-11-19T10:00:00.000Z';

function runtime(): ClientRuntime {
  const loaded = new ClientRuntime(bridge);
  loaded.register(client(log, { fns: { shout: Shouting }, results: { fns: { stamp: Stamped }, kinds: { tail: Tailed } } }));
  return loaded;
}

describe('client({ results })', () => {
  it("gives a fn's own result renderer its run decoded with the fn's types, titled as the app names it", () => {
    const run = mintId('run');
    const view = runtime().resultView({ fn: QualifiedName.parse('log/stamp'), kind: undefined, run, args: { at }, result: { at }, title: 'Stamp' });
    expect(view?.component).toBe(Stamped);
    expect(view?.props).toMatchObject({ run, fn: 'log/stamp', title: 'Stamp', args: { at: new Date(at) }, result: { at: new Date(at) } });
    expect(Object.keys(view?.props.system.run ?? {})).toEqual(['stamp', 'shout']);
  });

  it("falls back to its kind's result renderer with the JSON as it is, and to nothing without one", () => {
    const loaded = runtime();
    const other = { fn: QualifiedName.parse('other/report'), run: mintId('run'), args: { a: 1 }, result: { rows: 2 }, title: 'Report' };
    const view = loaded.resultView({ ...other, kind: QualifiedName.parse('log/tail') });
    expect(view?.component).toBe(Tailed);
    expect(view?.props.result).toEqual({ rows: 2 });
    expect(loaded.resultView({ ...other, kind: undefined })).toBeUndefined();
    expect(loaded.resultView({ ...other, kind: QualifiedName.parse('log/none') })).toBeUndefined();
  });

  it('keeps fn renderers and result renderers apart, and gives no view to a result that does not fit its type', () => {
    const loaded = runtime();
    expect(loaded.resultView({ fn: QualifiedName.parse('log/shout'), kind: undefined, run: mintId('run'), args: { text: 'hi' }, result: 'HI', title: 'Shout' })).toBeUndefined();
    expect(loaded.fnRenderer(QualifiedName.parse('log/shout'))).toBe(Shouting);
    expect(loaded.fnRenderer(QualifiedName.parse('log/stamp'))).toBeUndefined();
    expect(loaded.resultView({ fn: QualifiedName.parse('log/stamp'), kind: undefined, run: mintId('run'), args: { at }, result: { at: 'not a time' }, title: 'Stamp' })).toBeUndefined();
  });
});
