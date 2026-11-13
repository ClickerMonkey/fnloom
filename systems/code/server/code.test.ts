/**
 * The code system with the SDK test kit and a scripted model: `make_code`'s forced workflow (search first, then the
 * inspect tools, set only after them, return only after a clean check), a failed check fixed, the clean draft run with
 * its sample and saved; reusing a code fn and changing it into version 2; and the `program` kind: its check (rules in
 * words), its describe (the fns it calls are its deps) and a run that calls another fn through the hub.
 */
import { CODE_KIND, Json, QualifiedName, mintId, type CodeFnSpec, type LlmForward, type RunSettled } from '@harness/core';
import { encodeValue, hub } from '@harness/sdk';
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
const FORECAST = { args: { name: 'obj', props: { city: { type: { name: 'text' } } } }, returns: { name: 'obj', props: { summary: { type: { name: 'text' } } } } };

let kit: Kit | undefined;
afterEach(async () => { await kit?.stop(); kit = undefined; });

async function start(script: readonly ScriptStep[]): Promise<Kit> {
  kit = await testHub(code, createCodeImpl({ settings: codeEnv.parse() }), { config: {}, model: mockModel(script) });
  return kit;
}

/** Answer child calls as the hub does: `hub/fn_get` of weather/forecast with its signature, the forecast itself, else the kit's fns. */
function scriptHub(running: Kit): Array<{ fn: string; args: Json }> {
  const seen: Array<{ fn: string; args: Json }> = [];
  running.hub.onFnShape = (name) => Promise.resolve(name === 'weather/forecast' ? { fn: { ...FORECAST, description: 'The forecast for a city.' } } : {});
  running.hub.onCall = async (call) => {
    seen.push({ fn: call.fn, args: call.args });
    await running.hub.peer().call('child', { parent: call.parent, key: call.key, run: mintId('run') });
    if (call.fn === hub.fns.fn_get.name && JSON.stringify(call.args).includes('weather/forecast')) {
      return done(Json.parse({ fn: 'weather/forecast', kind: 'native', description: 'The forecast for a city.', version: 1, available: true, ...FORECAST }));
    }
    if (call.fn === 'weather/forecast') return done({ summary: 'Sunny' });
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

describe('the program kind', () => {
  const CALLS: CodeFnSpec = { ...CODE_EXAMPLES.callsFn.signature, program: CODE_EXAMPLES.callsFn.program };

  it('describes the fns a program calls as its deps and lists what breaks the rules', async () => {
    const running = await start([]);
    scriptHub(running);
    const props = await running.kindProps('program', CALLS);
    expect(props.problems).toEqual([]);
    expect(props.description).toMatchObject({ deps: ['weather/forecast', hub.fns.fn_get.name], args: CALLS.args, returns: CALLS.returns, readable: { language: 'ts' } });
    const loop: CodeFnSpec = { ...CALLS, program: { kind: 'loop', over: { kind: 'new', type: { name: 'bool' }, value: true }, body: { kind: 'get', path: [{ prop: 'args' }] } } };
    expect((await running.kindProps('program', loop)).problems.join('\n')).toContain('while-loop');
  });

  it('runs a program that calls another fn through the hub', async () => {
    const running = await start([]);
    const seen = scriptHub(running);
    const outcome = await running.hub.run(QualifiedName.parse('code/city_forecast'), { city: 'Paris' }, { kind: CODE_KIND, payload: encodeValue(CodePayload, CALLS) });
    expect(outcome).toMatchObject({ status: 'done', result: 'Paris: Sunny' });
    expect(seen.map((call) => call.fn)).toEqual([hub.fns.fn_get.name, 'weather/forecast']);
  });
});
