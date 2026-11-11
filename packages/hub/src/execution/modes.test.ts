/**
 * Build 5 feedback, through the run service: a chat's fn mode in front of the policies for its agent's calls (refused,
 * asked with the classifier's reason, or let through in auto mode), approving a run answers its own "go ahead?"
 * question, and an agent's message keeps its reasoning, text and fn calls in the order the model made them.
 */
import { fn, g, handler, system, agent } from '@harness/sdk';
import { LinkSession, type Approval } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { linkPayload } from '../testing.ts';
import type { FnModeGate, ModeVerdict } from '../fns/index.ts';
import { AGENT, ALICE, calls, executionRig, says, SESSION, until, type ExecutionRig } from './testing.ts';

const confirm = handler({ description: 'Run this command?', args: g.obj({ command: g.text() }), returns: g.bool(), required: false });
const bash = fn({ description: 'Run a command.', args: g.obj({ command: g.text() }), returns: g.text(), handlers: { confirm } });
const files = system('fs', { description: 'Files.' }).with({ fns: { bash } });
const shell = agent({ description: 'Runs commands.', args: g.obj({}), returns: g.text(), instructions: 'Run what you are asked to.', tools: [files.fns.bash] });
const fsLink = LinkSession.parse({ system: 'fs', instance: 'main', boot: 'test-1' });

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(): Promise<ExecutionRig> {
  rig = await executionRig();
  rig.catalog.add('fs', 'bash', bash);
  rig.catalog.add('tools', 'shell', shell);
  await rig.module.start();
  await rig.session();
  return rig;
}

/** Start the shell agent on a turn whose model calls bash once, then answers. */
async function agentCallsBash(r: ExecutionRig, text = 'List the files.') {
  const turn = await r.turn({ session: SESSION, text });
  r.provider.script(calls([['fs__bash', { command: 'ls' }]]), says('Done.'));
  return r.module.agents.start({
    kind: 'hub/llm', fn: 'tools/shell', args: {}, turn: turn.id, session: SESSION, key: 'answer', actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [],
  });
}

/** A gate that answers with one verdict and remembers what it was asked. */
function gate(verdict: ModeVerdict): FnModeGate & { asked: string[] } {
  const asked: string[] = [];
  return { asked, check: (input) => { asked.push(input.fn.name); return Promise.resolve(verdict); } };
}

const lastApproval = (r: ExecutionRig): Approval => {
  const approval = r.bus.of('approval').at(-1)?.approval;
  if (approval === undefined) throw new Error('no approval');
  return approval;
};

describe('chat fn mode in front of the policies', () => {
  it('refuses an agent\'s call the mode doesn\'t allow, and the agent reads why', async () => {
    const r = await started();
    const refusing = gate({ effect: 'refuse', reason: 'This chat is set to read mode.' });
    r.module.runs.gateWith(refusing);
    const { run } = await agentCallsBash(r);
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'Done.' });
    expect(refusing.asked).toEqual(['fs/bash']);
    const child = (await r.store.table('runs').find({ where: { parent: run }, limit: 5 })).items[0];
    expect(child).toMatchObject({ status: 'failed', outcome: { status: 'failed', error: { code: 'chat-mode', message: 'This chat is set to read mode.' } } });
  });

  it('in auto mode, lets a call the classifier allows go ahead without asking, and asks with its reason otherwise', async () => {
    const r = await started();
    const fs = r.connect('fs');
    fs.behaviour.run = () => Promise.resolve({ status: 'done', result: 'a b' });
    r.module.runs.gateWith(gate({ effect: 'allow', reason: 'You asked for it.' }));
    const first = await agentCallsBash(r);
    expect(await r.module.runs.wait(first.run)).toEqual({ status: 'done', result: 'Done.' });
    expect(r.bus.of('approval')).toHaveLength(0);

    r.module.runs.gateWith(gate({ effect: 'ask', reason: 'Deleting was not asked for.' }));
    const second = await agentCallsBash(r, 'Again.');
    await until(() => r.bus.of('approval').length > 0, 'the approval');
    expect(lastApproval(r).preview).toMatchObject({ parts: [{ type: 'text', text: 'Deleting was not asked for.' }] });
    await r.module.policies.answer(lastApproval(r).id, { by: ALICE, approve: true, remember: 'once' });
    expect(await r.module.runs.wait(second.run)).toEqual({ status: 'done', result: 'Done.' });
  });
});

describe('approving a run', () => {
  it('answers its own "go ahead?" question, so the person is asked once', async () => {
    const r = await started();
    const fs = r.connect('fs');
    let answer: unknown;
    fs.behaviour.run = async (request) => {
      answer = await r.module.linkHandlers.handle(linkPayload({ run: request.run.id, handler: 'confirm', args: { command: 'rm x' } }, fsLink));
      return { status: 'done', result: 'removed' };
    };
    const { run } = await agentCallsBash(r);
    await until(() => r.bus.of('approval').length > 0, 'the approval');
    await r.module.policies.answer(lastApproval(r).id, { by: ALICE, approve: true, remember: 'once' });
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'Done.' });
    expect(answer).toEqual({ ok: true, value: true });
    // the question was recorded as answered, never shown as waiting
    expect(r.bus.of('handler').map((e) => e.call.status)).toEqual(['answered']);
  });
});

describe('an agent\'s message', () => {
  it('keeps reasoning, text and fn calls in the order the model made them', async () => {
    const r = await started();
    const fs = r.connect('fs');
    fs.behaviour.run = () => Promise.resolve({ status: 'done', result: 'a b' });
    r.module.runs.gateWith(gate({ effect: 'allow', reason: 'ok' }));
    const { run } = await agentCallsBash(r);
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'Done.' });
    const finished = r.chat.finished.at(-1);
    expect(finished?.parts.map((p) => p.type)).toEqual(['text']);
    const anyRun: unknown = expect.any(String);
    expect(r.chat.tracked.at(-1)?.calls).toEqual([{ run: anyRun, fn: 'fs/bash' }]);
  });
});
