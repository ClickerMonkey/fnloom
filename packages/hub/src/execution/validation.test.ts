/**
 * Fn validation hooks on the hub side: a fn that declares them is checked by its system before it runs (a refusal
 * settles it as "not available now", without running it) and after it is done (a refused result asks for another try,
 * a few times a turn, then stops the run; `stop` fails it at once).
 */
import { fn, g } from '@harness/sdk';
import type { QualifiedName, Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { invalidReply } from './agent.ts';
import { OUTPUT_REFUSED } from './executors.ts';
import type { RunInput } from './index.ts';
import { ALICE, executionRig, type ExecutionRig } from './testing.ts';

const buy = fn({
  description: 'Buy an item.',
  args: g.obj({ count: g.num({ whole: true }) }),
  returns: g.obj({ total: g.num() }),
  // the hub only reads which hooks exist; the fake system answers them
  validate: { input: () => ({ ok: true }), output: () => ({ ok: true }) },
});
const plain = fn({ description: 'No hooks.', args: g.obj({}), returns: g.text() });

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(): Promise<ExecutionRig> {
  rig = await executionRig();
  rig.catalog.add('shop', 'buy', buy);
  rig.catalog.add('shop', 'plain', plain);
  await rig.module.start();
  return rig;
}

/** Start a run and wait for it: its outcome as the run keeps it (code callers see refused input as `failed`). */
async function outcomeOf(r: ExecutionRig, run: RunInput) {
  const started = await r.module.runs.start(run);
  await started.settled;
  return (await r.module.runs.get(started.run))?.outcome;
}

const input = (turn: Turn, name: QualifiedName, args: RunInput['args'], key = 'k'): RunInput => ({
  fn: name, args, turn: turn.id, key, actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
});

describe('fn validation hooks', () => {
  it('refuse a run its input hook refuses, without running it, as not available now', async () => {
    const r = await started();
    const shop = r.connect('shop');
    shop.behaviour.validate = (request) => (request.phase === 'input' ? { ok: false, reason: 'The shop is closed.' } : { ok: true });
    const outcome = await outcomeOf(r, input(await r.turn(), 'shop/buy', { count: 1 }));
    expect(outcome).toEqual({ status: 'invalid-input', invalid: { source: 'unavailable', problems: [{ path: '', message: 'The shop is closed.' }] } });
    expect(shop.requests).toHaveLength(0);
    expect(shop.validations).toMatchObject([{ phase: 'input', fn: 'buy', args: { count: 1 } }]);
    if (outcome?.status === 'invalid-input') expect(invalidReply(outcome.invalid)).toBe('Not available now: The shop is closed.');
  });

  it('keep a result its output hook accepts, and never ask about a fn without hooks', async () => {
    const r = await started();
    const shop = r.connect('shop');
    const turn = await r.turn();
    expect(await outcomeOf(r, input(turn, 'shop/buy', { count: 2 }))).toMatchObject({ status: 'done', result: { echo: { count: 2 } } });
    expect(shop.validations.map((v) => v.phase)).toEqual(['input', 'output']);
    await (await r.module.runs.start(input(turn, 'shop/plain', {}, 'k2'))).settled;
    expect(shop.validations).toHaveLength(2);
  });

  it('ask for another try while tries are left, then stop the run', async () => {
    const r = await started();
    const shop = r.connect('shop');
    shop.behaviour.validate = (request) => (request.phase === 'output' ? { ok: false, action: 'retry', reason: 'Too expensive' } : { ok: true });
    const turn = await r.turn();
    const tries = [];
    for (const key of ['a', 'b', 'c']) tries.push(await outcomeOf(r, input(turn, 'shop/buy', { count: 9 }, key)));
    const retry = { status: 'invalid-input', invalid: { source: 'result', problems: [{ path: '', message: 'The result was refused: Too expensive. Try again.' }] } };
    // the default allows two tries again in a turn (HARNESS_VALIDATE_RETRIES)
    expect(tries.slice(0, 2)).toEqual([retry, retry]);
    expect(tries[2]).toMatchObject({ status: 'failed', error: { class: 'fatal', code: OUTPUT_REFUSED, message: 'Too expensive' } });
    expect(shop.validations.filter((v) => v.phase === 'output').map((v) => ('attempt' in v ? v.attempt : 0))).toEqual([1, 2, 3]);
  });

  it('stop the run at once when the output hook says stop', async () => {
    const r = await started();
    const shop = r.connect('shop');
    shop.behaviour.validate = (request) => (request.phase === 'output' ? { ok: false, action: 'stop', reason: 'Card declined' } : { ok: true });
    expect(await outcomeOf(r, input(await r.turn(), 'shop/buy', { count: 1 }))).toMatchObject({ status: 'failed', error: { class: 'fatal', code: OUTPUT_REFUSED, message: 'Card declined' } });
  });
});
