/**
 * Build 8: the sensitive-files gate in front of the mode gate and the policies. A fn that declares `flags` asks its
 * system which sensitive files the call would touch; a refusal stops it as invalid input, an ask makes it wait for the
 * person every time (no auto mode, no remembered answer), and in auto mode the classifier reads the flags it is given.
 */
import { agent, fn, g, system } from '@harness/sdk';
import type { Approval, SensitivityFlag } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionModeGate } from '../fns/gate.ts';
import type { ClassifyInput } from '../fns/index.ts';
import { AGENT, ALICE, calls, executionRig, says, SESSION, until, type ExecutionRig, type TestSystem } from './testing.ts';

const read = fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), flags: true });
const files = system('fs', { description: 'Files.' }).with({ fns: { read } });
const reader = agent({ description: 'Reads files.', args: g.obj({}), returns: g.text(), instructions: 'Read what you are asked to.', tools: [files.fns.read] });

const flag = (over: Partial<SensitivityFlag>): SensitivityFlag => ({
  path: '.env', kind: 'env', rule: 'env-files', access: 'read', action: 'ask', why: 'Env files hold keys and passwords.', certain: true, ...over,
});

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(): Promise<{ r: ExecutionRig; fs: TestSystem }> {
  rig = await executionRig();
  rig.catalog.add('fs', 'read', read);
  rig.catalog.add('tools', 'reader', reader);
  await rig.module.start();
  await rig.session();
  const fs = rig.connect('fs');
  fs.behaviour.run = () => Promise.resolve({ status: 'done', result: 'KEY=1' });
  return { r: rig, fs };
}

/** Start the reader agent on a turn whose model reads `.env` once, then answers. */
async function agentReads(r: ExecutionRig, text = 'Show me .env.') {
  const turn = await r.turn({ session: SESSION, text });
  r.provider.script(calls([['fs__read', { path: '.env' }]]), says('Done.'));
  return r.module.agents.start({
    kind: 'hub/llm', fn: 'tools/reader', args: {}, turn: turn.id, session: SESSION, key: `answer-${text}`, actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [],
  });
}

const lastApproval = (r: ExecutionRig): Approval => {
  const approval = r.bus.of('approval').at(-1)?.approval;
  if (approval === undefined) throw new Error('no approval');
  return approval;
};

const child = async (r: ExecutionRig, parent: string) => (await r.store.table('runs').find({ where: { parent }, limit: 5 })).items[0];

/** The real mode gate over a session in auto mode, with a classifier that allows and records what it read. */
async function autoGate(r: ExecutionRig): Promise<ClassifyInput[]> {
  const seen: ClassifyInput[] = [];
  r.module.runs.gateWith(new SessionModeGate(
    () => ({ modes: (names) => Promise.resolve(new Map(names.map((name) => [name, 'write' as const]))), registry: () => Promise.resolve(new Map()) }),
    () => ({ classify: (input) => { seen.push(input); return Promise.resolve({ allow: true, reason: 'You asked for it.' }); } }),
  ));
  await r.store.table('sessions').update(SESSION, { fnMode: 'auto' });
  return seen;
}

describe('the sensitive-files gate', () => {
  it('refuses a call a rule refuses as invalid input with the rule\'s words, before the fn runs', async () => {
    const { r, fs } = await started();
    fs.behaviour.flags = () => ({ flags: [flag({ path: 'id_rsa', kind: 'key', action: 'refuse', why: 'Private keys never leave the machine.' })] });
    const { run } = await agentReads(r);
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'Done.' });
    expect(fs.flagged.map((request) => request.fn)).toEqual(['read']);
    expect(fs.requests).toHaveLength(0);
    expect(await child(r, run)).toMatchObject({ status: 'invalid-input' });
    expect(JSON.stringify((await child(r, run))?.outcome)).toContain('Reads id_rsa (key: Private keys never leave the machine.)');
  });

  it('makes a flagged call wait for the person even when auto mode allows it, never asks the classifier, and never remembers', async () => {
    const { r, fs } = await started();
    const seen = await autoGate(r);
    fs.behaviour.flags = () => ({ flags: [flag({})] });
    const first = await agentReads(r);
    await until(() => r.bus.of('approval').length > 0, 'the approval');
    expect(seen).toHaveLength(0);
    expect(lastApproval(r).preview).toMatchObject({ title: 'fs/read touches sensitive files', parts: [{ type: 'flags', flags: [{ path: '.env' }] }] });
    const answered = await r.module.policies.answer(lastApproval(r).id, { by: ALICE, approve: true, remember: 'session' });
    expect(answered.decisions.at(-1)?.remember).toBe('once');
    expect(await r.module.runs.wait(first.run)).toEqual({ status: 'done', result: 'Done.' });

    // the same call again in the same session is asked about again
    await agentReads(r, 'Once more.');
    await until(() => r.bus.of('approval').length > 1, 'the second approval');
  });

  it('gives the classifier the flags the rules let through, one line each', async () => {
    const { r, fs } = await started();
    const seen = await autoGate(r);
    fs.behaviour.flags = () => ({ flags: [flag({ path: 'dist/out.log', kind: 'gitignored', action: 'allow', why: 'Git ignores it.' })] });
    const { run } = await agentReads(r);
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'Done.' });
    expect(seen.map((input) => input.flags?.map((f) => f.path))).toEqual([['dist/out.log']]);
    expect(r.bus.of('approval')).toHaveLength(0);
  });

  it('fails a flagged fn as retryable when its system can\'t be asked', async () => {
    const { r, fs } = await started();
    fs.behaviour.flags = () => { throw new Error('rules not loaded'); };
    const { run } = await agentReads(r);
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'Done.' });
    expect(await child(r, run)).toMatchObject({ status: 'failed', outcome: { error: { class: 'retry', code: 'unavailable' } } });
    expect(fs.requests).toHaveLength(0);
  });
});
