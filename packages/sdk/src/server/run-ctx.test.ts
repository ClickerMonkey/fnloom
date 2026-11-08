/**
 * What a running fn reaches through the hub, end to end against the in-memory hub: another system's named types and
 * what they reference (`ctx.types`, parsed with `loadTypes`), its caller's handlers when they refuse or answer with
 * the wrong type (`HandlerFailed`), and the context a system kind's fns run with (untyped child calls, handlers and
 * both shapes of progress).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GinTypeDef, QualifiedName, SystemName, type FnError, type RunSettled, type TypeDefinitions, type TypeRecord } from '@harness/core';
import { HandlerFailed } from '../ctx.ts';
import { kind } from '../declare.ts';
import { fn, handler } from '../fn.ts';
import { encodeValue, g, json, loadTypes, parseValue, wireType } from '../gin.ts';
import { system } from '../system.ts';
import { serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';

const confirm = handler({ description: 'Go ahead?', args: g.obj({ q: g.text() }), returns: g.bool(), required: true });

const cards = system('cards', { description: 'Works with another system\'s cards.' }).with({
  kinds: {
    relay: kind({ description: 'Calls one fn, asks first.', applicability: 'Relayed calls.', payload: g.obj({ target: g.text() }) }),
  },
  fns: {
    read: fn({ description: 'Check a value of other/Card and give it back as JSON.', args: g.obj({ value: json() }), returns: json() }),
    nothing: fn({ description: 'Ask for no types.', args: g.obj({}), returns: g.num() }),
    stall: fn({ description: 'Wait on the type definitions.', args: g.obj({}), returns: g.num() }),
    ask: fn({ description: 'Ask the caller, and let a refusal end the run.', args: g.obj({}), returns: g.bool(), handlers: { confirm } }),
    askSafe: fn({ description: 'Ask the caller, and report a refusal.', args: g.obj({}), returns: g.text(), handlers: { confirm } }),
  },
});

const DEPS: readonly QualifiedName[] = ['other/greet'];

/** The stored record of another system's type, as the hub sends it. */
function record(name: QualifiedName, def: GinTypeDef, references: QualifiedName[]): TypeRecord {
  return { name, system: SystemName.parse('other'), description: name, def, display: { label: name }, references, updatedAt: 1 };
}

const SUIT = record('other/Suit', wireType(g.enum(['hearts', 'spades'])), []);
const CARD = record('other/Card', GinTypeDef.parse({
  name: 'obj',
  props: { suit: { type: { name: 'other/Suit' } }, rank: { type: wireType(g.num({ min: 1, whole: true })) } },
}), ['other/Suit']);

/** The hub's answer for `other/Card`: its closure, dependencies first. */
function cardDefinitions(names: readonly QualifiedName[]): Promise<TypeDefinitions> {
  return Promise.resolve({ types: names.includes('other/Card') ? [SUIT, CARD] : [], missing: names.filter((n) => n !== 'other/Card') });
}

let running: RunningSystem<'cards'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function start(hub: FakeHub): Promise<void> {
  running = await serve(cards, {
    fns: {
      read: {
        async run(args, ctx) {
          const loaded = loadTypes(await ctx.types.definitions(['other/Card', 'other/Gone']));
          const card = loaded.get('other/Card');
          if (card === undefined) { return ctx.fail('fatal', 'other/Card did not load'); }
          return ctx.done({ card: encodeValue(card, parseValue(card, args.value)), missing: [...loaded.missing] });
        },
      },
      nothing: { async run(_a, ctx) { const found = await ctx.types.definitions([]); return ctx.done(found.types.length + found.missing.length); } },
      stall: { async run(_a, ctx) { return ctx.done((await ctx.types.definitions(['other/Card'])).types.length); } },
      ask: { async run(_a, ctx) { return ctx.done(await ctx.handlers.confirm({ q: 'Delete it?' })); } },
      askSafe: {
        async run(_a, ctx) {
          try {
            return ctx.done(`answered ${await ctx.handlers.confirm({ q: 'Delete it?' })}`);
          } catch (error) {
            if (error instanceof HandlerFailed) { return ctx.done(`${error.handler} ${error.error.class}: ${error.error.message}`); }
            throw error;
          }
        },
      },
    },
    kinds: {
      relay: {
        async check() { return []; },
        async describe() { return { args: { name: 'any' }, returns: { name: 'any' }, deps: [...DEPS], operations: { cancel: true, pause: false, undo: false, background: false } }; },
        async run(payload, args, ctx) {
          ctx.progress({ fraction: 0.25, message: 'starting' });
          ctx.progress({ step: 'call', status: 'active', detail: 'calling' });
          const result = await ctx.call(QualifiedName.parse(payload.target), args, { key: 'the-call' });
          const ok = await ctx.handler('confirm', { q: 'Keep it?' });
          ctx.progress({ step: 'call', status: 'done' });
          ctx.progress({ fraction: 2 });
          return ctx.done({ result, ok });
        },
      },
    },
  }, { hub: 'ws://hub.test/link', state: 'unused', version: '1' }, hub.host());
  await running.ready();
}

/** What the real hub does with a kind's child calls: it refuses any fn outside the payload's described deps. */
function hubWithDeps(): FakeHub {
  const hub = new FakeHub();
  hub.onCall = (call): Promise<RunSettled> => Promise.resolve(DEPS.includes(call.fn)
    ? { status: 'done', result: { hello: call.args } }
    : { status: 'failed', error: { class: 'fatal', message: `cards/flow doesn't declare ${call.fn} as a dep, so it can't call it.`, code: 'not-a-dep' } });
  return hub;
}

describe('another system\'s types', () => {
  it('loads a type with what it references and parses a value with it', async () => {
    const hub = new FakeHub();
    hub.onTypes = cardDefinitions;
    await start(hub);
    const outcome = await hub.run('cards/read', { value: { suit: 'hearts', rank: 3 } });
    expect(outcome).toEqual({ status: 'done', result: { card: { suit: 'hearts', rank: 3 }, missing: ['other/Gone'] } });
    expect(hub.typeRequests).toEqual([['other/Card', 'other/Gone']]);
  });

  it('fails a value that does not fit the loaded type, down to a referenced type', async () => {
    const hub = new FakeHub();
    hub.onTypes = cardDefinitions;
    await start(hub);
    const outcome = await hub.run('cards/read', { value: { suit: 'clubs', rank: 3 } });
    expect(outcome).toMatchObject({ status: 'failed', error: { class: 'fatal', code: 'threw' } });
    expect(JSON.stringify(outcome)).toMatch(/clubs|suit/);
  });

  it('asks the hub nothing for no names', async () => {
    const hub = new FakeHub();
    await start(hub);
    expect(await hub.run('cards/nothing', {})).toEqual({ status: 'done', result: 0 });
    expect(hub.typeRequests).toEqual([]);
  });

  it('stops waiting on the hub when the run is cancelled', async () => {
    const hub = new FakeHub();
    hub.onTypes = () => new Promise<never>(() => undefined);
    await start(hub);
    const run = hub.runInfo('cards/stall');
    const outcome = hub.run('cards/stall', {}, { run });
    await expect.poll(() => hub.typeRequests.length).toBe(1);
    expect(await hub.peer().call('control', { run: run.id, action: 'cancel' })).toEqual({ accepted: true });
    expect(await outcome).toEqual({ status: 'cancelled' });
  });

  it('parses every definition into one overlay, registering nothing process-wide', () => {
    const loaded = loadTypes({ types: [SUIT, CARD], missing: [] });
    expect(loaded.get('other/Suit')).toBeDefined();
    expect(loaded.get('other/Unknown')).toBeUndefined();
    expect(g.scope().lookup('other/Card')).toBeUndefined();
  });
});

describe('a handler that gives no answer', () => {
  const refused: FnError = { class: 'caller', message: 'The person said no.', code: 'refused' };

  it('throws HandlerFailed with the hub\'s error, which the fn can catch', async () => {
    const hub = new FakeHub();
    hub.onHandle = () => Promise.resolve({ ok: false, error: refused });
    await start(hub);
    expect(await hub.run('cards/askSafe', {})).toEqual({ status: 'done', result: 'confirm caller: The person said no.' });
    expect(hub.handled).toMatchObject([{ handler: 'confirm', args: { q: 'Delete it?' } }]);
  });

  it('ends the run with the hub\'s error when the fn lets it through', async () => {
    const hub = new FakeHub();
    hub.onHandle = () => Promise.resolve({ ok: false, error: refused });
    await start(hub);
    expect(await hub.run('cards/ask', {})).toEqual({ status: 'failed', error: refused });
  });

  it('throws HandlerFailed when the answer does not fit the handler\'s return type', async () => {
    const hub = new FakeHub();
    hub.onHandle = () => Promise.resolve({ ok: true, value: 'yes' });
    await start(hub);
    const caught = await hub.run('cards/askSafe', {});
    expect(caught.status === 'done' ? caught.result : caught).toMatch(/^confirm caller: The answer of handler confirm does not fit its type/);
    expect(await hub.run('cards/ask', {})).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'bad-value' } });
  });
});

describe('a system kind\'s fns', () => {
  it('make untyped child calls, ask handlers and report both shapes of progress', async () => {
    const hub = hubWithDeps();
    hub.onHandle = () => Promise.resolve({ ok: true, value: true });
    await start(hub);
    const run = hub.runInfo('cards/flow');
    const outcome = await hub.run('cards/flow', { name: 'Ann' }, { run, kind: 'cards/relay', payload: { target: 'other/greet' } });
    expect(outcome).toEqual({ status: 'done', result: { result: { hello: { name: 'Ann' } }, ok: true } });
    expect(hub.calls).toMatchObject([{ parent: run.id, fn: 'other/greet', args: { name: 'Ann' }, key: 'the-call', handlers: [], background: false }]);
    expect(hub.handled).toMatchObject([{ run: run.id, handler: 'confirm', args: { q: 'Keep it?' } }]);
    expect(hub.progress.map((p) => p.progress)).toEqual([
      { fraction: 0.25, message: 'starting' },
      { step: 'call', status: 'active', detail: 'calling' },
      { step: 'call', status: 'done' },
      { fraction: 1 },
    ]);
  });

  it('fail with the hub\'s refusal when they call outside the described deps', async () => {
    const hub = hubWithDeps();
    await start(hub);
    const outcome = await hub.run('cards/flow', {}, { kind: 'cards/relay', payload: { target: 'other/secret' } });
    expect(outcome).toMatchObject({ status: 'failed', error: { class: 'fatal', code: 'not-a-dep' } });
    expect(hub.calls.map((c) => c.fn)).toEqual(['other/secret']);
    expect(hub.handled).toEqual([]);
  });

  it('fail with the hub\'s error when a handler refuses', async () => {
    const hub = hubWithDeps();
    hub.onHandle = () => Promise.resolve({ ok: false, error: { class: 'caller', message: 'Timed out.', code: 'timeout' } });
    await start(hub);
    const outcome = await hub.run('cards/flow', {}, { kind: 'cards/relay', payload: { target: 'other/greet' } });
    expect(outcome).toEqual({ status: 'failed', error: { class: 'caller', message: 'Timed out.', code: 'timeout' } });
  });
});
