/**
 * The code system with the SDK test kit and a scripted model: `make_code`'s forced workflow (search first, then the
 * inspect tools, set only after them, return only after a clean check), a failed check fixed, the clean draft run with
 * its sample and saved; reusing a code fn and changing it into version 2; and the `program` kind: its check (rules in
 * words), its describe (the fns it calls are its deps) and a run that calls another fn through the hub.
 */
import { CODE_KIND, Json, QualifiedName, mintId, type CodeFnSpec, type LlmForward, type RunSettled } from '@harness/core';
import { encodeValue, hub, sampleArgs } from '@harness/sdk';
import { mockModel, testHub, toolCall, type ScriptStep, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { code, CodePayload } from '../shared/index.ts';
import { CODE_EXAMPLES } from './authoring.ts';
import { codeEnv } from './env.ts';
import { createCodeImpl } from './impl.ts';

type Kit = TestSystem<'code', typeof code.defs>;

const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();
const done = (result: Json): RunSettled => ({ status: 'done', result });

const PRICE: CodeFnSpec = { ...CODE_EXAMPLES.priceWithTax.signature, program: CODE_EXAMPLES.priceWithTax.program };
const STATUS_FN = { args: { name: 'obj', props: { ticket: { type: { name: 'text' } } } }, returns: { name: 'obj', props: { summary: { type: { name: 'text' } } } } };

let kit: Kit | undefined;
afterEach(async () => { await kit?.stop(); kit = undefined; });

async function start(script: readonly ScriptStep[]): Promise<Kit> {
  kit = await testHub(code, createCodeImpl({ settings: codeEnv.parse() }), { config: {}, model: mockModel(script) });
  return kit;
}

/** Answer child calls as the hub does: `hub/fns_get` of tickets/status with its signature, the status itself, else the kit's fns. */
function scriptHub(running: Kit): Array<{ fn: string; args: Json }> {
  const seen: Array<{ fn: string; args: Json }> = [];
  running.hub.onFnShape = (name) => Promise.resolve(name === 'tickets/status' ? { fn: { ...STATUS_FN, description: 'The status of a ticket.', mode: 'read' as const } } : {});
  running.hub.onCall = async (call) => {
    seen.push({ fn: call.fn, args: call.args });
    await running.hub.peer().call('child', { parent: call.parent, key: call.key, run: mintId('run') });
    if (call.fn === hub.fns.fns_get.name && JSON.stringify(call.args).includes('tickets/status')) {
      return done(Json.parse({ fn: 'tickets/status', kind: 'native', description: 'The status of a ticket.', version: 1, available: true, ...STATUS_FN }));
    }
    if (call.fn === 'tickets/status') return done({ summary: 'Open' });
    return running.hub.fns.settle(call) ?? done(null);
  };
  return seen;
}

describe('make_code', () => {
  it('works through the forced workflow, fixes a failed check, runs the clean draft with its sample and saves it', async () => {
    const bad = { name: 'price_with_tax', description: 'The amount with tax.', program: CODE_EXAMPLES.priceWithTax.program.value.total, sample: { amount: 100, rate: 8.25 } };
    const good = { ...bad, description: 'The amount with tax at a percentage rate, and a note.', program: CODE_EXAMPLES.priceWithTax.program };
    const running = await start([
      toolCall('search', { text: 'price with tax' }),
      toolCall('examples', {}),
      toolCall('signature', CODE_EXAMPLES.priceWithTax.signature),
      toolCall('set', { draft: bad }),
      toolCall('set', { draft: good }),
      toolCall('return', {}),
      'Saved code/price_with_tax.',
    ]);
    const fake = running.hub;
    const { result } = await running.call('make_code', { request: 'A price with tax: amount and rate (a percentage); 100 at 8.25 gives 108.25.' });
    expect(result).toMatchObject({ fn: 'code/price_with_tax', version: 1, reused: false, signature: 'code/price_with_tax(amount: num, rate: num) → obj{total: num, note: text}' });
    expect(result.preview).toMatchObject({ note: '100 at 8.25%' });
    expect(fake.fns.kept.get('code/price_with_tax')?.saved).toMatchObject({ kind: CODE_KIND, examples: [{ args: { amount: 100, rate: 8.25 } }], payload: { args: PRICE.args } });
    // the forced workflow: search alone first; set only after an inspect tool; return only after a clean check
    expect(offered(fake.forwards[0])).toEqual(['search']);
    expect(offered(fake.forwards[1])).not.toContain('set');
    expect(offered(fake.forwards[2])).toContain('set');
    expect(offered(fake.forwards[4])).not.toContain('return');
    expect(offered(fake.forwards[5])).toEqual(expect.arrayContaining(['return', 'test']));
    // the wrong result type was a problem the model read; the clean draft showed its preview
    expect(JSON.stringify(fake.forwards[4]?.request.messages)).toContain('is expected');
    expect(JSON.stringify(fake.forwards[5]?.request.messages)).toContain('Preview');
  });

  it('reuses a code fn that already does it, and changes it into version 2', async () => {
    const changed = { ...CODE_EXAMPLES.withLocal.program };
    const running = await start([
      toolCall('search', { text: 'price with tax' }), toolCall('reuse', { fn: 'code/price_with_tax' }), 'Reused.',
      toolCall('search', { text: 'price with tax' }), toolCall('examples', {}),
      toolCall('set', { draft: { name: 'renamed', description: 'The amount with tax, its note the total.', program: changed, sample: { amount: 10, rate: 10 } } }),
      toolCall('set', { draft: { name: 'price_with_tax', description: 'The amount with tax, its note the total.', program: changed, sample: { amount: 10, rate: 10 } } }),
      toolCall('return', {}), 'Changed.',
    ]);
    const fake = running.hub;
    fake.fns.save({ kind: CODE_KIND, name: 'price_with_tax', description: 'A price with tax at a percentage rate.', payload: encodeValue(CodePayload, PRICE) });
    const reused = await running.call('make_code', { request: 'Price with tax.' });
    expect(reused.result).toMatchObject({ fn: 'code/price_with_tax', reused: true, version: 1 });
    const edited = await running.call('make_code', { request: 'Use the total as the note.', fn: 'code/price_with_tax' });
    expect(edited.result).toMatchObject({ fn: 'code/price_with_tax', version: 2, reused: false });
    expect(fake.fns.kept.get('code/price_with_tax')?.history).toHaveLength(1);
    expect(JSON.stringify(fake.forwards.at(-3)?.request.messages)).toContain('Keep the name');
  });
});

describe('make_code over another fn', () => {
  it('loads only fns search listed, with their signatures from the hub, then saves a program that calls one', async () => {
    const total = { kind: 'get', path: [{ prop: 'fns' }, { prop: 'code' }, { prop: 'price_with_tax' }, { args: { amount: { kind: 'get', path: [{ prop: 'args' }, { prop: 'amount' }] }, rate: { kind: 'get', path: [{ prop: 'args' }, { prop: 'rate' }] } } }, { prop: 'total' }] };
    const signature = { args: CODE_EXAMPLES.priceWithTax.signature.args, returns: { name: 'num' } };
    const running = await start([
      toolCall('search', { text: 'price with tax' }),
      // a name search never listed is refused in words; the listed one loads with its signature
      toolCall('load', { fns: ['code/price_with_tax', 'shop/discount'] }),
      toolCall('load', { fns: ['code/price_with_tax'] }),
      toolCall('signature', signature),
      toolCall('set', { draft: { name: 'total_with_tax', description: 'Only the total of an amount with tax.', program: total, sample: { amount: 100, rate: 8.25 } } }),
      toolCall('return', {}),
      'Saved code/total_with_tax.',
    ]);
    const seen = scriptHub(running);
    const fake = running.hub;
    fake.fns.save({ kind: CODE_KIND, name: 'price_with_tax', description: 'A price with tax at a percentage rate.', payload: encodeValue(CodePayload, PRICE) });
    // the hub's declaration of the saved fn (`hub/fns_get`), and its answer when the sample runs
    const inner = running.hub.onCall;
    running.hub.onCall = async (call) => {
      const getsPrice = call.fn === hub.fns.fns_get.name && JSON.stringify(call.args).includes('code/price_with_tax');
      if (call.fn !== 'code/price_with_tax' && !getsPrice) { return inner(call); }
      seen.push({ fn: call.fn, args: call.args });
      await running.hub.peer().call('child', { parent: call.parent, key: call.key, run: mintId('run') });
      return getsPrice
        ? done(Json.parse({ fn: 'code/price_with_tax', kind: CODE_KIND, description: 'A price with tax at a percentage rate.', version: 1, available: true, args: PRICE.args, returns: PRICE.returns }))
        : done({ total: 108.25, note: '100 at 8.25%' });
    };
    const { result } = await running.call('make_code', { request: 'Just the total of a price with tax.' });
    expect(result).toMatchObject({ fn: 'code/total_with_tax', version: 1, reused: false });
    // the refused load named what search never listed; the second load showed how a program calls the fn
    expect(JSON.stringify(fake.forwards[2]?.request.messages)).toContain('shop/discount was not listed');
    expect(JSON.stringify(fake.forwards[3]?.request.messages)).toContain('code/price_with_tax');
    // the hub was asked for the callee's declaration, and the saved program calls it
    expect(seen.some((call) => call.fn === hub.fns.fns_get.name && JSON.stringify(call.args).includes('code/price_with_tax'))).toBe(true);
    expect(JSON.stringify(fake.fns.kept.get('code/total_with_tax')?.saved.payload)).toContain('price_with_tax');
  });
});

describe('the program kind', () => {
  const CALLS: CodeFnSpec = { ...CODE_EXAMPLES.callsFn.signature, program: CODE_EXAMPLES.callsFn.program };

  it('describes the fns a program calls as its deps and lists what breaks the rules', async () => {
    const running = await start([]);
    scriptHub(running);
    const props = await running.kindProps('program', CALLS);
    expect(props.problems).toEqual([]);
    expect(props.description).toMatchObject({ deps: ['tickets/status', hub.fns.fns_get.name], args: CALLS.args, returns: CALLS.returns, readable: { language: 'ts' }, effects: { mode: 'read' } });
    expect(props.description?.examples).toEqual([{ args: sampleArgs(CALLS.args), note: 'Runs the program with sample values: use real ones.' }]);
    const loop: CodeFnSpec = { ...CALLS, program: { kind: 'loop', over: { kind: 'new', type: { name: 'bool' }, value: true }, body: { kind: 'get', path: [{ prop: 'args' }] } } };
    expect((await running.kindProps('program', loop)).problems.join('\n')).toContain('while-loop');
  });

  it('runs a program that calls another fn through the hub', async () => {
    const running = await start([]);
    const seen = scriptHub(running);
    const outcome = await running.hub.run(QualifiedName.parse('code/ticket_line'), { ticket: 'T-12' }, { kind: CODE_KIND, payload: encodeValue(CodePayload, CALLS) });
    expect(outcome).toMatchObject({ status: 'done', result: 'T-12: Open' });
    expect(seen.map((call) => call.fn)).toEqual([hub.fns.fns_get.name, 'tickets/status']);
  });
});
