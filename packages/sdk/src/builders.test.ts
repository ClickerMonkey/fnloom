import { describe, expect, it } from 'vitest';
import { action, arg, context, hook, kind, sectionKeys, setting, type } from './declare.ts';
import { fn, handler, linear, steps } from './fn.ts';
import { g, json } from './gin.ts';
import { hub } from './hub.ts';
import { agent } from './agent.ts';
import { system } from './system.ts';
import { orDefault } from './util.ts';
import type { Deps } from './fn.ts';

describe('fn', () => {
  it('fills the defaults a native fn has when the author leaves them out', () => {
    const ping = fn({ description: 'Ping.', args: g.obj({}), returns: g.text() });
    expect(ping.kind).toBe('native');
    expect(ping.deps).toEqual({});
    expect(ping.handlers).toEqual({});
    expect(ping.progress).toEqual({ type: 'none' });
    expect(ping.display).toBe('card');
    expect(ping.visibility).toBe('both');
    expect(ping.tags).toEqual([]);
    expect(ping.operations).toEqual({ cancel: true, background: true, pause: false, undo: false });
  });

  it('makes a fn pausable and undoable exactly when it declares resume and undo types', () => {
    const f = fn({ description: 'x', args: g.obj({}), returns: g.bool(), resume: g.obj({ at: g.num() }), undo: g.text(), operations: { cancel: false } });
    expect(f.operations).toEqual({ cancel: false, background: true, pause: true, undo: true });
  });

  it('keeps declared progress, handlers and deps', () => {
    const confirm = handler({ description: 'Sure?', args: g.obj({}), returns: g.bool(), required: true });
    const read = system('reader', { description: 'r' }).with({ fns: { read: fn({ description: 'r', args: g.obj({}), returns: g.text() }) } });
    const f = fn({ description: 'x', args: g.obj({}), returns: g.text(), progress: steps({ a: 'A' }), handlers: { confirm }, deps: { read: read.fns.read } });
    expect(f.progress).toEqual({ type: 'steps', steps: { a: 'A' } });
    expect(f.handlers.confirm.required).toBe(true);
    expect(f.deps.read.name).toBe('reader/read');
    expect(fn({ description: 'y', args: g.obj({}), returns: g.text(), progress: linear }).progress).toEqual({ type: 'linear' });
  });
});

describe('declarations', () => {
  it('fills defaults for args, hooks, kinds, settings and actions', () => {
    expect(arg('Which')).toEqual({ hint: 'Which', required: true });
    expect(arg('Which', { required: false })).toEqual({ hint: 'Which', required: false });
    expect(hook({ description: 'h' })).toEqual({ description: 'h', order: 100, timeout: 1000 });
    expect(kind({ description: 'k', applicability: 'a', payload: g.text() }).approveChanges).toBe(true);
    expect(setting({ description: 's', type: g.bool(), appliesTo: ['user'], merge: 'user-wins' }).editableBy).toEqual([]);
    const a = action({ description: 'a', input: g.obj({}) });
    expect(a.returns.name).toBe('void');
    expect(a.state).toBeUndefined();
  });

  it('marks context without content as dynamic', () => {
    expect(context({ description: 'd', content: 'text' }).dynamic).toBe(false);
    expect(context({ description: 'd', command: { name: 'tree', args: { root: arg('r', { required: false }) } } }).dynamic).toBe(true);
  });

  it('copies a type display', () => {
    const t = type({ description: 'T', shape: g.obj({ name: g.text() }), display: { label: 'T', title: 'name' } });
    expect(t.display).toEqual({ label: 'T', title: 'name' });
    expect(t.methods).toEqual({});
  });

  it('makes section keys from structure, numbering repeats', () => {
    expect(sectionKeys([['Intro'], ['Usage', 'CLI'], ['Intro'], []])).toEqual(['Intro', 'Usage > CLI', 'Intro ~2', '(root)']);
  });
});

describe('system().with()', () => {
  const contract = system('demo', { description: 'Demo.' })
    .with({
      config: g.obj({ url: g.text() }),
      types: {
        Item: type({
          description: 'An item.',
          shape: g.obj({ id: g.text(), size: g.num() }),
          display: { label: 'Item', title: 'id' },
          methods: { open: fn({ description: 'Open it.', args: g.obj({ tab: g.bool() }), returns: g.bool() }) },
        }),
      },
      fns: { get: fn({ description: 'Get.', args: g.obj({ id: g.text() }), returns: g.text() }) },
      kinds: { api: kind({ description: 'API.', applicability: 'REST.', payload: g.obj({ url: g.text() }) }) },
    })
    .with(({ fns, kinds }) => ({
      context: { guide: context({ description: 'Guide.', content: 'Use get.', fns: [fns.get] }) },
      fns: { weather: kinds.api.fn({ description: 'Weather.', payload: { url: 'https://example.com' } }) },
    }));

  it('qualifies every ref by the system name', () => {
    expect(contract.name).toBe('demo');
    expect(contract.fns.get.name).toBe('demo/get');
    expect(contract.fns.weather.name).toBe('demo/weather');
    expect(contract.kinds.api.name).toBe('demo/api');
    expect(contract.context.guide.name).toBe('demo/guide');
    expect(contract.types.Item.name).toBe('demo/Item');
    expect(contract.types.Item.methods.open.name).toBe('demo/Item.open');
  });

  it('keeps everything declared across with() calls', () => {
    expect(Object.keys(contract.defs.fns)).toEqual(['get', 'weather']);
    expect(contract.defs.context.guide.fns.map((f) => f.name)).toEqual(['demo/get']);
    expect(contract.defs.fns.weather.kind).toBe(contract.kinds.api);
  });

  it('makes a type ref a real gin type registered under its name, usable as a field', () => {
    expect(g.lookup('demo/Item')).toBe(contract.types.Item);
    const holder = g.obj({ item: contract.types.Item });
    expect(holder.parse({ item: { id: 'a', size: 2 } }).toLogical()).toEqual({ item: { id: 'a', size: 2 } });
    expect(() => holder.parse({ item: { id: 'a' } })).toThrow();
  });

  it('gives a method args that hold the value as self', () => {
    const args = contract.types.Item.methods.open.args;
    expect(args.parse({ self: { id: 'a', size: 1 }, tab: true }).toLogical()).toEqual({ self: { id: 'a', size: 1 }, tab: true });
    expect(() => args.parse({ tab: true })).toThrow();
  });

  it('refuses a name declared twice', () => {
    expect(() => contract.with({ fns: { get: fn({ description: 'again', args: g.obj({}), returns: g.text() }) } })).toThrow(/fns\.get is declared twice/);
  });

  it('refuses a bad system name', () => {
    expect(() => system('Bad Name', { description: 'x' })).toThrow();
  });

  it('types a kind fn without args as JSON', () => {
    expect(contract.defs.fns.weather.args.name).toBe('any');
    expect(json().name).toBe('any');
  });
});

describe('agent', () => {
  it('builds a hub/llm fn whose payload names its tools and context', () => {
    const tools = system('tools', { description: 't' }).with({ fns: { look: fn({ description: 'Look.', args: g.obj({}), returns: g.text() }) } });
    const a = agent({ description: 'A.', args: g.obj({ q: g.text() }), returns: g.text(), instructions: 'Answer {{args.q}}.', tools: [tools.fns.look] });
    expect(a.kind).toBe(hub.kinds.llm);
    expect(a.payload).toEqual({ instructions: 'Answer {{args.q}}.', tools: ['tools/look'], canLoad: 'none', maxTools: 32, context: [], hooks: [], toolExecution: 'parallel', maxIterations: 16 });
    expect(hub.kinds.llm.payload.parse(a.payload).toLogical()).toEqual(a.payload);
  });
});

describe('orDefault', () => {
  it('gives the value when there is one and the fallback otherwise, and refuses a fallback of an unrelated type', () => {
    /** Deps as a builder sees them: maybe given (typed, not narrowed by the compiler). */
    const depsOf = (deps?: Deps): Deps | undefined => deps;
    const given = {};
    expect(orDefault(depsOf(given), {})).toBe(given);
    expect(orDefault(depsOf(), {})).toEqual({});
    // @ts-expect-error a number is not a value of the deps' type
    expect(orDefault(depsOf(), 42)).toBe(42);
  });
});
