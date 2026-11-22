/**
 * Parallel claims in the agent loop: an agent's calls of one step run together, except that a call whose claims
 * conflict with an earlier call's (in the model's order) waits until that call has settled. Through the real loop, run
 * service and queues, with a fake fs over the real system link.
 */
import { agent, fn, g, system } from '@harness/sdk';
import { isSettled, JsonObject, type Json, type LlmMessage, type OutcomeWire, type Run, type RunId, type RunRequest } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { settle } from '../testing.ts';
import { heldReply, stateOf } from './agent.ts';
import { AGENT_KIND, type AgentKind, type RunInput } from './index.ts';
import { AGENT, ALICE, ALICE_INFO, calls, executionRig, says, SESSION, testSettings, until, type ExecutionRig, type TestSystem } from './testing.ts';

/** The default policy lets a fn tagged `read` run without asking, so every call here starts as soon as it may. */
const FREE = ['read'];
const writeDef = fn({ description: 'Write a file.', args: g.obj({ path: g.text(), text: g.text() }), returns: g.bool(), tags: FREE, parallelClaims: ['file:{args.path}'] });
const readDef = fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: FREE });
const moveDef = fn({ description: 'Move a file.', args: g.obj({ from: g.text(), to: g.text() }), returns: g.bool(), tags: FREE, dynamicClaims: true });
const restartDef = fn({ description: 'Restart the system.', args: g.obj({}), returns: g.bool(), tags: FREE, parallelClaims: ['*'] });
const lockDef = fn({ description: 'Lock a vault.', args: g.obj({ vault: g.text() }), returns: g.bool(), tags: FREE, dynamicClaims: true });

const files = system('fs', { description: 'Files.' }).with({ fns: { write: writeDef, read: readDef, move: moveDef, restart: restartDef } });
const vault = system('vault', { description: 'Vaults.' }).with({ fns: { lock: lockDef } });
const tools = [files.fns.write, files.fns.read, files.fns.move, files.fns.restart, vault.fns.lock];
const editor = agent({ description: 'Edits files.', args: g.obj({}), returns: g.text(), instructions: 'Edit.', tools, maxIterations: 4 });
const careful = agent({ description: 'Edits files, one call at a time.', args: g.obj({}), returns: g.text(), instructions: 'Edit.', tools, maxIterations: 4, toolExecution: 'sequential' });

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(options: Parameters<typeof executionRig>[0] = {}): Promise<ExecutionRig> {
  rig = await executionRig(options);
  rig.catalog.add('fs', 'write', writeDef);
  rig.catalog.add('fs', 'read', readDef);
  rig.catalog.add('fs', 'move', moveDef);
  rig.catalog.add('fs', 'restart', restartDef);
  rig.catalog.add('vault', 'lock', lockDef);
  rig.catalog.add('tools', 'editor', editor);
  rig.catalog.add('tools', 'careful', careful);
  await rig.module.start();
  await rig.session({ agent: 'tools/editor' });
  return rig;
}

/** A fake fs whose runs each wait until the test finishes them, by label: a write's text, else `fn:path`. */
function gated(fs: TestSystem): { started: string[]; finish: (label: string, outcome?: OutcomeWire) => void } {
  const begun: string[] = [];
  const gates = new Map<string, (outcome: OutcomeWire) => void>();
  fs.behaviour.run = (request) => new Promise((resolve) => {
    const label = labelOf(request);
    begun.push(label);
    gates.set(label, resolve);
  });
  return { started: begun, finish: (label, outcome = { status: 'done', result: true }) => { gates.get(label)?.(outcome); } };
}

function labelOf(request: RunRequest): string {
  const args = JsonObject.parse(request.args);
  return request.fn === 'write' ? text(args['text']) : `${request.fn}:${text(args['path'] ?? args['from'])}`;
}

/** An arg as text (empty when it isn't text). */
function text(value: Json | undefined): string {
  return typeof value === 'string' ? value : '';
}

async function startAgent(r: ExecutionRig, fnName: RunInput['fn'] = 'tools/editor'): Promise<RunId> {
  const turn = await r.turn({ session: SESSION, text: 'Edit the files.' });
  const input: RunInput & { kind: AgentKind } = {
    kind: AGENT_KIND, fn: fnName, args: {}, turn: turn.id, key: 'answer', actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [], session: SESSION,
  };
  return (await r.module.agents.start(input)).run;
}

async function agentRun(r: ExecutionRig, run: RunId): Promise<Run> {
  const row = await r.module.runs.get(run);
  if (row === undefined) throw new Error('no agent run');
  return row;
}

/** The agent's child runs by their key (`<iteration>:<tool call id>`). */
async function children(r: ExecutionRig, run: RunId): Promise<Map<string, Run>> {
  const rows = (await r.store.table('runs').find({ where: { parent: run }, limit: 50 })).items;
  return new Map(rows.map((row) => [row.key, row]));
}

/** The tool replies in the session transcript, by tool call id. */
async function replies(r: ExecutionRig): Promise<Map<string, string>> {
  const transcript: LlmMessage[] = (await r.store.table('sessions').get(SESSION))?.transcript ?? [];
  return new Map(transcript.flatMap((message): Array<[string, string]> => (message.role === 'tool' && message.toolCallId !== undefined
    ? [[message.toolCallId, typeof message.content === 'string' ? message.content : JSON.stringify(message.content)]]
    : [])));
}

/** Wait a little, so a call that should not start would have. */
const pause = (): Promise<void> => settle(40);

describe('an agent whose calls claim the same things', () => {
  it('runs two writes to one path one after another in the model’s order, and a write to another path beside them', async () => {
    const r = await started();
    const fs = gated(r.connect('fs'));
    r.provider.script(calls([['fs__write', { path: 'a.md', text: 'first' }], ['fs__write', { path: 'a.md', text: 'second' }], ['fs__write', { path: 'b.md', text: 'other' }]]), says('All written.'));
    const run = await startAgent(r);

    await until(() => fs.started.length === 2, 'the two calls that clash with nothing earlier to start');
    await pause();
    expect([...fs.started].sort()).toEqual(['first', 'other']);
    const held = stateOf(await agentRun(r, run)).pending.find((call) => call.toolCallId === 'call_2');
    expect(held).toMatchObject({ fn: 'fs/write', held: { after: ['call_1'], args: { path: 'a.md', text: 'second' } } });
    expect(held?.run).toBeUndefined();
    expect((await children(r, run)).has('0:call_2')).toBe(false);

    fs.finish('other');
    await pause();
    expect(fs.started).not.toContain('second');
    fs.finish('first');
    await until(() => fs.started.includes('second'), 'the held write to start once the first settles');
    expect(fs.started).toEqual(expect.arrayContaining(['first', 'other', 'second']));
    expect(fs.started.indexOf('second')).toBe(2);
    expect(stateOf(await agentRun(r, run)).pending.find((call) => call.toolCallId === 'call_2')).toHaveProperty('run');
    expect(r.chat.tracked.flatMap((t) => t.calls.map((c) => c.fn))).toEqual(['fs/write', 'fs/write', 'fs/write']);

    fs.finish('second', { status: 'done', result: false });
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'All written.' });
    const kids = await children(r, run);
    expect([...kids.keys()].sort()).toEqual(['0:call_1', '0:call_2', '0:call_3']);
    expect(kids.get('0:call_2')?.llmCall).toBeDefined();
    expect([...(await replies(r)).entries()]).toEqual([['call_1', 'true'], ['call_2', 'false'], ['call_3', 'true']]);
    expect(r.provider.requests).toHaveLength(2);
  });

  it('asks a fn with dynamic claims for them from the args and the call’s context, and orders calls by its answer', async () => {
    const r = await started();
    const system = r.connect('fs');
    const fs = gated(system);
    system.behaviour.claims = (request) => {
      const args = JsonObject.parse(request.args);
      return { claims: [`file:${text(args['from'])}`, `file:${text(args['to'])}`] };
    };
    r.provider.script(calls([['fs__move', { from: 'a.md', to: 'b.md' }], ['fs__write', { path: 'b.md', text: 'into b' }], ['fs__write', { path: 'c.md', text: 'into c' }]]), says('Moved.'));
    const run = await startAgent(r);

    await until(() => fs.started.length === 2, 'the move and the unrelated write');
    await pause();
    expect([...fs.started].sort()).toEqual(['into c', 'move:a.md']);
    expect(system.claimed).toEqual([{ fn: 'move', args: { from: 'a.md', to: 'b.md' }, user: ALICE_INFO, caller: run, session: SESSION }]);
    fs.finish('move:a.md');
    await until(() => fs.started.includes('into b'), 'the write to the moved-to file');
    fs.finish('into b');
    fs.finish('into c');
    expect((await r.module.runs.wait(run)).status).toBe('done');
  });

  it('asks nothing for a step of one call, and nothing for a call refused before it ran', async () => {
    const r = await started();
    const system = r.connect('fs');
    system.behaviour.run = () => Promise.resolve({ status: 'done', result: true });
    r.provider.script(calls([['fs__move', { from: 'a.md', to: 'b.md' }]]), calls([['fs__move', { from: 'a.md' }], ['fs__write', { path: 'a.md', text: 'x' }]]), says('Done.'));
    const run = await startAgent(r);
    expect((await r.module.runs.wait(run)).status).toBe('done');
    expect(system.claimed).toEqual([]);
  });

  it('never holds a call behind invalid input, nor holds invalid input behind anyone', async () => {
    const r = await started();
    const system = r.connect('fs');
    const fs = gated(system);
    r.provider.script(calls([
      ['fs__write', { path: 'a.md', text: 'first' }], ['fs__write', { path: 7 }], ['fs__move', { from: 'a.md' }], ['fs__write', { path: 'a.md', text: 'second' }],
    ]), says('Fixed.'));
    const run = await startAgent(r);

    await until(() => fs.started.length === 1, 'the first write');
    const pending = stateOf(await agentRun(r, run)).pending;
    // the two refused calls were runs settled invalid-input at once; only the clashing write waits, for the first
    expect(pending.map((call) => [call.toolCallId, call.held?.after ?? null])).toEqual([['call_1', null], ['call_2', null], ['call_3', null], ['call_4', ['call_1']]]);
    const kids = await children(r, run);
    expect(kids.get('0:call_2')?.status).toBe('invalid-input');
    expect(kids.get('0:call_3')?.status).toBe('invalid-input');
    // a refused call's fn is never asked for its claims
    expect(system.claimed).toEqual([]);
    fs.finish('first');
    await until(() => fs.started.includes('second'), 'the second write');
    fs.finish('second');
    expect((await r.module.runs.wait(run)).status).toBe('done');
  });
});

describe('calls that run alone', () => {
  it('runs a call claiming * after every earlier call and before every later one', async () => {
    const r = await started();
    const fs = gated(r.connect('fs'));
    r.provider.script(calls([['fs__read', { path: 'a.md' }], ['fs__restart', {}], ['fs__read', { path: 'b.md' }]]), says('Restarted.'));
    const run = await startAgent(r);

    await until(() => fs.started.length === 1, 'the first read');
    await pause();
    expect(fs.started).toEqual(['read:a.md']);
    expect(stateOf(await agentRun(r, run)).pending.map((call) => call.held?.after ?? null)).toEqual([null, ['call_1'], ['call_2']]);
    fs.finish('read:a.md', { status: 'done', result: 'a' });
    await until(() => fs.started.length === 2, 'the restart');
    await pause();
    expect(fs.started).toEqual(['read:a.md', 'restart:']);
    fs.finish('restart:');
    await until(() => fs.started.length === 3, 'the last read');
    fs.finish('read:b.md', { status: 'done', result: 'b' });
    expect((await r.module.runs.wait(run)).status).toBe('done');
  });

  it('runs every call of a sequential agent one at a time, in order, without asking any system for claims', async () => {
    const r = await started();
    const system = r.connect('fs');
    const fs = gated(system);
    r.provider.script(calls([['fs__read', { path: 'a.md' }], ['fs__read', { path: 'b.md' }], ['fs__move', { from: 'c.md', to: 'd.md' }]]), says('One by one.'));
    const run = await startAgent(r, 'tools/careful');

    await until(() => fs.started.length === 1, 'the first call');
    await pause();
    expect(stateOf(await agentRun(r, run)).pending.map((call) => call.held?.after ?? null)).toEqual([null, ['call_1'], ['call_1', 'call_2']]);
    for (const [label, next] of [['read:a.md', 2], ['read:b.md', 3]] as const) {
      fs.finish(label, { status: 'done', result: label });
      await until(() => fs.started.length === next, `call ${String(next)}`);
      await pause();
      expect(fs.started).toHaveLength(next);
    }
    expect(fs.started).toEqual(['read:a.md', 'read:b.md', 'move:c.md']);
    fs.finish('move:c.md');
    expect((await r.module.runs.wait(run)).status).toBe('done');
    expect(system.claimed).toEqual([]);
  });
});

describe('a system that can’t say what a call claims', () => {
  it('runs the call alone when its claims hook fails, and logs why', async () => {
    const r = await started();
    const system = r.connect('fs');
    const fs = gated(system);
    system.behaviour.claims = () => { throw new Error('no idea'); };
    r.provider.script(calls([['fs__read', { path: 'a.md' }], ['fs__move', { from: 'x', to: 'y' }], ['fs__read', { path: 'b.md' }]]), says('Moved.'));
    const run = await startAgent(r);

    await until(() => fs.started.length === 1, 'the first read');
    expect(stateOf(await agentRun(r, run)).pending.map((call) => call.held?.after ?? null)).toEqual([null, ['call_1'], ['call_2']]);
    expect(r.records.find((record) => record.msg === 'agent.claims-unknown')).toMatchObject({ level: 'warn' });
    fs.finish('read:a.md');
    await until(() => fs.started.length === 2, 'the move');
    fs.finish('move:x');
    await until(() => fs.started.length === 3, 'the last read');
    fs.finish('read:b.md');
    expect((await r.module.runs.wait(run)).status).toBe('done');
    expect(fs.started).toEqual(['read:a.md', 'move:x', 'read:b.md']);
  });

  it('runs the call alone when its system isn’t connected', async () => {
    const r = await started();
    const fs = gated(r.connect('fs'));
    r.provider.script(calls([['fs__read', { path: 'a.md' }], ['vault__lock', { vault: 'v1' }], ['fs__read', { path: 'b.md' }]]));
    const run = await startAgent(r);

    await until(() => fs.started.length === 1, 'the first read');
    await pause();
    expect(stateOf(await agentRun(r, run)).pending.map((call) => call.held?.after ?? null)).toEqual([null, ['call_1'], ['call_2']]);
    expect(r.records.find((record) => record.msg === 'agent.claims-unknown')).toMatchObject({ level: 'warn', fn: 'vault/lock', error: { message: 'vault is not connected' } });
  });
});

describe('held calls and the agent run around them', () => {
  it('starts a held call once, after a hub restart, when the call it waited for settles', async () => {
    const r = await started();
    const fs = gated(r.connect('fs'));
    r.provider.script(calls([['fs__write', { path: 'a.md', text: 'first' }], ['fs__write', { path: 'a.md', text: 'second' }]]), says('Both, after the restart.'));
    const run = await startAgent(r);
    await until(() => fs.started.length === 1, 'the first write');
    await until(async () => stateOf(await agentRun(r, run)).pending.some((call) => call.held !== undefined), 'the second write to be held');
    const first = (await children(r, run)).get('0:call_1');
    if (first === undefined) throw new Error('no first write');

    // the hub restarts while the second write is held; the first write's result arrives afterwards
    await r.restart();
    expect((await agentRun(r, run)).status).toBe('waiting');
    await pause();
    expect(fs.started).toEqual(['first']);
    await r.module.runs.settle(first.id, { status: 'done', result: true });
    await until(() => fs.started.includes('second'), 'the held write to start after the restart');
    fs.finish('second');
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'Both, after the restart.' });
    expect(fs.started.filter((label) => label === 'second')).toHaveLength(1);
    expect([...(await children(r, run)).keys()].sort()).toEqual(['0:call_1', '0:call_2']);
  });

  it('keeps a call held while the call it waits for runs on in the background, and starts it once that one settles', async () => {
    const r = await started();
    const fs = gated(r.connect('fs'));
    r.provider.script(calls([['fs__write', { path: 'a.md', text: 'first' }], ['fs__write', { path: 'a.md', text: 'second' }]]), says('Done.'));
    const run = await startAgent(r);
    await until(async () => fs.started.length === 1 && stateOf(await agentRun(r, run)).pending.some((call) => call.held !== undefined), 'the second write to be held');
    const first = (await children(r, run)).get('0:call_1');
    if (first === undefined) throw new Error('no first write');

    expect(await r.module.runs.background(first.id)).toBe(true);
    await pause();
    expect(fs.started).toEqual(['first']);
    expect((await agentRun(r, run)).status).toBe('waiting');
    fs.finish('first');
    await until(() => fs.started.includes('second'), 'the held write to start once the first settles');
    fs.finish('second');
    expect((await r.module.runs.wait(run)).status).toBe('done');
  });

  it('never starts a held call once the agent is cancelled, nor when it is continued, and tells the model it did not run', async () => {
    const r = await started();
    const system = r.connect('fs');
    const fs = gated(system);
    system.behaviour.control = () => { fs.finish('first', { status: 'cancelled' }); return { accepted: true }; };
    r.provider.script(calls([['fs__write', { path: 'a.md', text: 'first' }], ['fs__write', { path: 'a.md', text: 'second' }]]), says('Carried on.'));
    const run = await startAgent(r);
    await until(async () => fs.started.length === 1 && stateOf(await agentRun(r, run)).pending.some((call) => call.held !== undefined), 'the second write to be held');

    expect(await r.module.runs.cancel(run, ALICE)).toEqual({ accepted: true });
    expect((await r.module.runs.wait(run)).status).toBe('cancelled');
    await until(async () => (await children(r, run)).get('0:call_1')?.status === 'cancelled', 'the first write to cancel');
    await pause();
    const state = stateOf(await agentRun(r, run));
    expect(state.pending.find((call) => call.toolCallId === 'call_2')).toMatchObject({ skipped: true, held: { after: ['call_1'] } });
    expect((await children(r, run)).has('0:call_2')).toBe(false);

    await r.module.agents.continue(run, ALICE);
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'Carried on.' });
    expect(fs.started).toEqual(['first']);
    expect((await children(r, run)).has('0:call_2')).toBe(false);
    const said = await replies(r);
    expect(said.get('call_2')).toMatch(/^Not run: it works on the same things as an earlier call \(fs__write\)/);
  });

  it('skips its held calls when the person is there and the tools take too long, and answers with what it has', async () => {
    const r = await started({ settings: testSettings({ HARNESS_TOOL_TIMEOUT: 30 }), active: true });
    const fs = gated(r.connect('fs'));
    r.provider.script(calls([['fs__write', { path: 'a.md', text: 'first' }], ['fs__write', { path: 'a.md', text: 'second' }]]), says('The first still runs.'));
    const run = await startAgent(r);

    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'The first still runs.' });
    const kids = await children(r, run);
    expect(kids.get('0:call_1')?.background).toBe(true);
    expect(kids.has('0:call_2')).toBe(false);
    const pending = stateOf(await agentRun(r, run));
    expect(pending.pending).toEqual([]);
    const said = await replies(r);
    // as the model reads it: the fn by its model name
    expect(said.get('call_2')).toBe(heldReply({ toolCallId: 'call_2', fn: 'fs/write', held: { after: ['call_1'], args: {} } }, [{ toolCallId: 'call_1', fn: 'fs/write' }]).replaceAll('fs/write', 'fs__write'));
    // the first write finishing later doesn't start the second
    fs.finish('first');
    await until(async () => isSettled((await children(r, run)).get('0:call_1')?.status ?? 'running'), 'the first write to settle');
    await pause();
    expect(fs.started).toEqual(['first']);
  });
});
