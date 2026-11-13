import { agent, fn, g, system } from '@harness/sdk';
import { MAIN_INSTANCE, RunId, SystemName, type ProposedRun, type Run, type RunSettled, type TableReading, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { backgroundReply, backgroundResult, INTERRUPTED, RunConversation, settledReply, stateOf } from './agent.ts';
import { AGENT_KIND, type AgentKind, type RunInput } from './index.ts';
import { AGENT, ALICE, calls, executionRig, OPEN_LIMITS, says, SESSION, testSettings, until, type ExecutionRig } from './testing.ts';

/** A run a person watches, reading five rows of a table. */
const SHOWN: TableReading = { rows: 5, watched: true };

const files = system('fs', { description: 'Files.' }).with({
  fns: {
    read: fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }),
    write: fn({ description: 'Write a file.', args: g.obj({ path: g.text(), text: g.text() }), returns: g.bool() }),
  },
});
const helper = agent({ description: 'Helps.', args: g.obj({}), returns: g.text(), instructions: 'Be helpful.', tools: [files.fns.read, files.fns.write], maxIterations: 4 });
/** A system's agent whose answer its system checks (`validate.output`); the fake system answers the hook. */
const checked = agent({
  description: 'Names a title.', args: g.obj({}), returns: g.obj({ title: g.text() }), instructions: 'Name a title.',
  validate: { output: () => ({ ok: true }) },
});
const summarizer = agent({
  description: 'Summarizes a topic.', args: g.obj({ topic: g.text() }), returns: g.obj({ title: g.text(), points: g.list(g.text()) }),
  instructions: 'Summarize {{args.topic}}.',
});

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(options: Parameters<typeof executionRig>[0] = {}): Promise<ExecutionRig> {
  rig = await executionRig(options);
  rig.catalog.add('fs', 'read', readDef);
  rig.catalog.add('fs', 'write', writeDef);
  rig.catalog.add('tools', 'helper', helper);
  rig.catalog.add('tools', 'summarize', summarizer);
  rig.catalog.add('tools', 'checked', checked);
  await rig.module.start();
  return rig;
}
const readDef = fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] });
const writeDef = fn({ description: 'Write a file.', args: g.obj({ path: g.text(), text: g.text() }), returns: g.bool() });

function agentInput(turn: Turn, fnName: RunInput['fn'] = 'tools/helper', args: RunInput['args'] = {}): RunInput & { kind: AgentKind } {
  return {
    kind: AGENT_KIND, fn: fnName, args, turn: turn.id, key: 'answer', actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [],
    ...(turn.session === undefined ? {} : { session: turn.session }),
  };
}

async function runTo(r: ExecutionRig, run: RunId): Promise<{ settled: RunSettled; row: Run }> {
  const settled = await r.module.runs.wait(run);
  const row = await r.module.runs.get(run);
  if (row === undefined) throw new Error('no run');
  return { settled, row };
}

describe('a session agent', () => {
  it('answers through a tool call: the call becomes a run, and the next iteration continues from the transcript', async () => {
    const r = await started();
    const fs = r.connect('fs');
    fs.behaviour.run = () => Promise.resolve({ status: 'done', result: 'hello from a.txt' });
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'What is in a.txt?' });
    r.provider.script(calls([['fs__read', { path: 'a.txt' }]]), says('It says hello.'));

    const { run } = await r.module.agents.start(agentInput(turn));
    const { settled, row } = await runTo(r, run);

    expect(settled).toEqual({ status: 'done', result: 'It says hello.' });
    expect(fs.requests).toHaveLength(1);
    expect(fs.requests[0]).toMatchObject({ fn: 'read', args: { path: 'a.txt' }, run: { parent: run, caller: AGENT } });
    const session = await r.store.table('sessions').get(SESSION);
    expect(session?.transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(session?.transcript[0]?.content).toBe('What is in a.txt?');
    expect(session?.transcript[2]).toMatchObject({ role: 'tool', content: 'hello from a.txt', toolCallId: 'call_1' });
    expect(r.provider.requests[1]?.messages.find((m) => m.role === 'tool')).toMatchObject({ content: 'hello from a.txt' });
    expect(r.provider.requests[0]?.messages[0]).toMatchObject({ role: 'system' });
    expect(r.provider.requests[0]?.tools?.map((t) => t.name).sort()).toEqual(['fs__read', 'fs__write']);

    const child = (await r.store.table('runs').find({ where: { parent: run }, limit: 10 })).items[0];
    expect(child).toMatchObject({ fn: 'fs/read', key: '0:call_1', toolCallId: 'call_1', status: 'done' });
    expect(child?.llmCall).toBeDefined();

    expect(r.chat.begun).toHaveLength(1);
    expect(r.chat.streamed.map((s) => s.text).join('')).toBe('It says hello.');
    expect(r.chat.finished).toEqual([{ message: r.chat.begun[0]?.id, parts: [{ type: 'text', text: 'It says hello.' }], status: 'done' }]);
    expect(r.chat.settled).toEqual([{ turn: turn.id, status: 'done' }]);

    const interactions = (await r.store.table('llmInteractions').find({ where: { run }, order: [['iteration', 'asc']], limit: 10 })).items;
    expect(interactions.map((i) => [i.iteration, i.status, i.model])).toEqual([[0, 'done', 'test-model'], [1, 'done', 'test-model']]);
    // each call keeps what its prompt held: build 1's prompt (plain), within the model's window
    expect(interactions.map((i) => [i.selection?.contextor, i.selection?.mode])).toEqual([['plain', 'tools'], ['plain', 'tools']]);
    expect(interactions[0]?.response?.toolCalls?.[0]).toMatchObject({ name: 'fs__read' });
    expect(interactions[1]?.response?.content).toBe('It says hello.');
    expect(row.cost).toBeCloseTo(0.003);
    expect((await r.store.table('turns').get(turn.id))?.cost).toBeCloseTo(0.003);
    expect((await r.store.table('ledger').find({ where: { run }, limit: 10 })).items).toHaveLength(2);
    expect(stateOf(row)).toMatchObject({ iteration: 1, pending: [], seeded: true });
  });

  it('answers a tool call it could not start with the reason, and the model can recover', async () => {
    const r = await started();
    r.connect('fs');
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'go' });
    r.provider.script(calls([['fs__read', { path: 3 }]]), calls([['fs__read', { path: 'b' }]]), says('done'));
    const { run } = await r.module.agents.start(agentInput(turn));
    expect((await runTo(r, run)).settled).toEqual({ status: 'done', result: 'done' });
    const transcript = (await r.store.table('sessions').get(SESSION))?.transcript ?? [];
    expect(transcript.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('asks before a tool that writes, and continues once the person approves', async () => {
    const r = await started();
    r.connect('fs');
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'write it' });
    r.provider.script(calls([['fs__write', { path: 'a', text: 'b' }]]), says('written'));
    const { run } = await r.module.agents.start(agentInput(turn));
    await until(() => r.bus.of('approval').length > 0, 'the approval');
    const approval = r.bus.of('approval')[0]?.approval;
    if (approval === undefined) throw new Error('no approval');
    await r.module.policies.answer(approval.id, { by: ALICE, approve: true, remember: 'once' });
    expect((await runTo(r, run)).settled).toEqual({ status: 'done', result: 'written' });
  });

  it('stops waiting on slow tools after the timeout while the person is there, and says they still run', async () => {
    const r = await started({ settings: testSettings({ HARNESS_TOOL_TIMEOUT: 30 }), active: true });
    r.connect('fs').behaviour.run = () => new Promise(() => undefined);
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'read slowly' });
    r.provider.script(calls([['fs__read', { path: 'big' }]]), says('still going'));
    const { run } = await r.module.agents.start(agentInput(turn));
    expect((await runTo(r, run)).settled).toEqual({ status: 'done', result: 'still going' });
    const child = (await r.store.table('runs').find({ where: { parent: run }, limit: 1 })).items[0];
    expect(child?.background).toBe(true);
    expect(r.provider.requests[1]?.messages.find((m) => m.role === 'tool')?.content).toBe(backgroundReply(child?.id ?? RunId.parse('run_x')));
  });

  it('keeps waiting on a slow tool past the timeout while the person is away', async () => {
    const r = await started({ settings: testSettings({ HARNESS_TOOL_TIMEOUT: 20 }), active: false });
    let release: (o: { status: 'done'; result: string }) => void = () => undefined;
    r.connect('fs').behaviour.run = () => new Promise((resolve) => { release = resolve; });
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'read slowly' });
    r.provider.script(calls([['fs__read', { path: 'big' }]]), says('read it all'));
    const { run } = await r.module.agents.start(agentInput(turn));
    await until(async () => (await r.module.runs.get(run))?.status === 'waiting', 'the agent to wait for its tool');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const child = (await r.store.table('runs').find({ where: { parent: run }, limit: 1 })).items[0];
    expect(child?.background).toBe(false);
    expect((await r.module.runs.get(run))?.status).toBe('waiting');
    release({ status: 'done', result: 'all of it' });
    expect((await runTo(r, run)).settled).toEqual({ status: 'done', result: 'read it all' });
    expect(r.provider.requests[1]?.messages.find((m) => m.role === 'tool')?.content).toBe('all of it');
  });

  it('puts a background tool run’s result in the transcript when it finishes and wakes the agent to follow up, posting nothing itself', async () => {
    const r = await started();
    const tool: { release?: (o: { status: 'done'; result: string }) => void } = {};
    r.connect('fs').behaviour.run = () => new Promise((resolve) => { tool.release = resolve; });
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'first' });
    r.provider.script(calls([['fs__read', { path: 'big' }]]));
    const { run } = await r.module.agents.start(agentInput(turn));
    await until(async () => (await r.module.runs.get(run))?.status === 'waiting', 'the agent to wait for its tool');
    await r.module.agents.interrupt(run);
    await runTo(r, run);
    const child = (await r.store.table('runs').find({ where: { parent: run }, limit: 1 })).items[0];
    if (child === undefined) throw new Error('no tool run');
    expect(child.background).toBe(true);
    const [finished, tracked] = [r.chat.finished.length, r.chat.tracked.length];
    await until(() => tool.release !== undefined, 'the tool run to reach its system');
    tool.release?.({ status: 'done', result: 'the big file' });
    await until(() => r.chat.followUps.length > 0, 'the agent to be woken');
    expect(r.chat.followUps).toEqual([{ turn: turn.id, agent: AGENT }]);
    const transcript = (await r.store.table('sessions').get(SESSION))?.transcript ?? [];
    const note = transcript.at(-1);
    expect(note).toEqual({ role: 'user', content: backgroundResult(child, { status: 'done', result: 'the big file' }, SHOWN) });
    expect(note?.content).toContain('<background-result fn="fs/read" status="done">\nthe big file\n</background-result>');
    expect(note?.content).not.toContain(child.id);
    expect([r.chat.finished.length, r.chat.tracked.length]).toEqual([finished, tracked]);
  });

  it.each([
    { approve: true, outcome: 'approved', says: '1' },
    { approve: false, outcome: 'declined', says: 'Declined by the approver: not that table' },
  ])('tells the agent how a write its tool proposed ended ($outcome) once the person answers, after its call returned', async ({ approve, outcome, says: reply }) => {
    const r = await started();
    const fs = r.connect('fs');
    const seen: { proposed?: ProposedRun } = {};
    fs.behaviour.run = async (request) => {
      if (request.fn === 'write') return { status: 'done', result: 1 };
      seen.proposed = await r.module.runs.propose({
        fn: 'write', args: { path: 'b', text: 'x' }, key: 'p1', parent: request.run.id, approver: 'person',
        preview: { title: 'Write b', parts: [], irreversible: false }, system: SystemName.parse('fs'), instance: MAIN_INSTANCE,
      });
      return { status: 'done', result: 'waiting for approval' };
    };
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'write b' });
    r.provider.script(calls([['fs__read', { path: 'b' }]]), says('It waits for your approval.'));
    const { run } = await r.module.agents.start(agentInput(turn));
    expect((await runTo(r, run)).settled).toEqual({ status: 'done', result: 'It waits for your approval.' });
    expect(r.chat.followUps).toEqual([]);
    const proposed = seen.proposed;
    if (proposed === undefined) throw new Error('nothing was proposed');
    await r.module.policies.answer(proposed.approval, { by: ALICE, approve, remember: 'once', ...(approve ? {} : { reason: 'not that table' }) });
    await until(() => r.chat.followUps.length > 0, 'the agent to be woken');
    expect(r.chat.followUps).toEqual([{ turn: turn.id, agent: AGENT }]);
    const note = (await r.store.table('sessions').get(SESSION))?.transcript.at(-1);
    expect(note?.role).toBe('user');
    expect(note?.content).toContain(`<approval-result fn="fs/write" outcome="${outcome}">\n${reply}\n</approval-result>`);
  });

  it('hands over to a new message: tool calls go to the background and the run ends', async () => {
    const r = await started();
    r.connect('fs').behaviour.run = () => new Promise(() => undefined);
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'first' });
    r.provider.script(calls([['fs__read', { path: 'big' }]]));
    const { run } = await r.module.agents.start(agentInput(turn));
    await until(async () => (await r.module.runs.get(run))?.status === 'waiting', 'the agent to wait for its tool');
    await r.module.agents.interrupt(run);
    expect((await runTo(r, run)).settled).toEqual({ status: 'done', result: INTERRUPTED });
    const transcript = (await r.store.table('sessions').get(SESSION))?.transcript ?? [];
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(transcript[2]?.content).toMatch(/^Running in the background as run /);
  });

  it('cancels its tool runs and its answer when cancelled', async () => {
    const r = await started();
    const fs = r.connect('fs');
    let release: (o: { status: 'cancelled' }) => void = () => undefined;
    fs.behaviour.run = () => new Promise((resolve) => { release = resolve; });
    fs.behaviour.control = () => { release({ status: 'cancelled' }); return { accepted: true }; };
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'go' });
    r.provider.script(calls([['fs__read', { path: 'big' }]]));
    const { run } = await r.module.agents.start(agentInput(turn));
    await until(async () => (await r.module.runs.get(run))?.status === 'waiting' && fs.requests.length === 1, 'the agent to wait on its tool');
    expect(await r.module.runs.cancel(run, ALICE)).toEqual({ accepted: true });
    expect((await runTo(r, run)).settled).toEqual({ status: 'cancelled' });
    const child = (await r.store.table('runs').find({ where: { parent: run }, limit: 1 })).items[0];
    await until(async () => (await r.module.runs.get(child?.id ?? RunId.parse('run_x')))?.status === 'cancelled', 'the tool run to cancel');
    expect(r.chat.finished[0]?.status).toBe('failed');
    expect(r.chat.settled).toEqual([{ turn: turn.id, status: 'cancelled' }]);
  });

  it('pauses between iterations and picks up where it was on resume', async () => {
    const r = await started();
    const fs = r.connect('fs');
    let release: (o: { status: 'done'; result: string }) => void = () => undefined;
    fs.behaviour.run = () => new Promise((resolve) => { release = resolve; });
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'go' });
    r.provider.script(calls([['fs__read', { path: 'a' }]]), says('resumed fine'));
    const { run } = await r.module.agents.start(agentInput(turn));
    await until(async () => (await r.module.runs.get(run))?.status === 'waiting' && fs.requests.length === 1, 'the agent to wait on its tool');
    r.catalog.set('tools/helper', { decl: { ...helperDecl(r), operations: { cancel: true, pause: true, undo: false, background: false } } });
    await r.store.table('runs').update(run, { allowed: { cancel: true, pause: true, background: false } });
    expect(await r.module.runs.pause(run, ALICE)).toEqual({ accepted: true });
    expect((await r.module.runs.get(run))?.status).toBe('paused');
    release({ status: 'done', result: 'the text' });
    await r.module.runs.resume(run, ALICE);
    expect((await runTo(r, run)).settled).toEqual({ status: 'done', result: 'resumed fine' });
    expect(r.provider.requests[1]?.messages.find((m) => m.role === 'tool')).toMatchObject({ content: 'the text' });
  });

  it('fails when a budget would go over, telling the person', async () => {
    const r = await started();
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'go', limits: { priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 0, time: 600_000 }, budgets: [] } });
    r.provider.script(says('never sent'));
    const { run } = await r.module.agents.start(agentInput(turn));
    const { settled } = await runTo(r, run);
    if (settled.status !== 'failed') throw new Error('expected a failure');
    expect(settled.error.message).toContain("this message's budget");
    expect(r.provider.requests).toHaveLength(0);
    expect(r.chat.finished[0]).toMatchObject({ status: 'failed' });
    expect(r.chat.settled).toEqual([{ turn: turn.id, status: 'failed' }]);
  });

  it('stops after its iteration limit', async () => {
    const r = await started();
    r.connect('fs');
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'loop' });
    r.provider.script(...[1, 2, 3, 4].map((i) => calls([['fs__read', { path: `f${i}` }]])));
    const { run } = await r.module.agents.start(agentInput(turn));
    expect((await runTo(r, run)).settled).toMatchObject({ status: 'failed', error: { code: 'max-iterations' } });
  });
});

describe('an agent that runs out of time', () => {
  it('is stopped by the hub when its turn runs out of time while it waits for a tool: the tool is cancelled and the answer says so', async () => {
    const r = await started();
    const system = r.connect('fs');
    const controls: string[] = [];
    system.behaviour.run = () => new Promise(() => undefined);
    system.behaviour.control = (c) => { controls.push(c.action); return { accepted: true }; };
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'read it', limits: { ...OPEN_LIMITS, turn: { cost: 1, time: 150 } } });
    r.provider.script(calls([['fs__read', { path: 'big' }]]));
    const { run } = await r.module.agents.start(agentInput(turn));
    const { settled, row } = await runTo(r, run);
    expect(settled).toMatchObject({ status: 'failed', error: { class: 'fatal', code: 'timeout' } });
    expect(row.status).toBe('failed');
    const child = async () => (await r.store.table('runs').find({ where: { parent: run }, limit: 1 })).items[0];
    // the tool ignores the cancel, so its own deadline (the same turn's) stops it too
    await until(async () => (await child())?.status === 'failed', 'the tool run to be stopped');
    expect((await child())?.outcome).toMatchObject({ error: { code: 'timeout' } });
    expect(controls).toContain('cancel');
    const answer = r.chat.finished.at(-1);
    expect(answer?.status).toBe('failed');
    expect(answer?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).toContain('ran out of time');
  });
});

describe('an agent and fns that change under it', () => {
  it('answers a call to a fn switched off after its tools were offered with the refusal, and carries on', async () => {
    const r = await started();
    const fs = r.connect('fs');
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'read a' });
    r.provider.script(() => { r.catalog.set('fs/read', { disabled: true }); return calls([['fs__read', { path: 'a' }]]); }, says('It is switched off.'));
    const { run } = await r.module.agents.start(agentInput(turn));
    expect((await runTo(r, run)).settled).toEqual({ status: 'done', result: 'It is switched off.' });
    expect(fs.requests).toEqual([]);
    const tool = (await r.store.table('sessions').get(SESSION))?.transcript.find((m) => m.role === 'tool');
    expect(tool?.content).toBe('Error: fs/read is turned off.');
    expect(r.provider.requests[1]?.tools?.map((t) => t.name)).toEqual(['fs__write']);
  });

  it('cancels an agent whose iteration still waits for an LLM slot, without ever asking the model', async () => {
    const r = await started({ settings: testSettings({ HARNESS_LLM_CONCURRENCY: 1 }) });
    let release: () => void = () => undefined;
    const busy = new Promise<void>((resolve) => { release = resolve; });
    r.provider.script(async () => { await busy; return says('{"title":"A","points":[]}'); });
    const first = await r.module.agents.start(agentInput(await r.turn(), 'tools/summarize', { topic: 'a' }));
    await until(() => r.provider.requests.length === 1, 'the first agent to ask the model');
    const second = await r.module.agents.start({ ...agentInput(await r.turn(), 'tools/summarize', { topic: 'b' }), key: 'second' });
    await until(async () => (await r.module.runs.get(second.run))?.status === 'running', 'the second agent to queue its iteration');
    expect(await r.module.runs.cancel(second.run, ALICE)).toEqual({ accepted: true });
    expect((await runTo(r, second.run)).settled).toEqual({ status: 'cancelled' });
    release();
    expect((await runTo(r, first.run)).settled).toEqual({ status: 'done', result: { title: 'A', points: [] } });
    expect(JSON.stringify(r.provider.requests)).not.toContain('Summarize b.');
  });
});

describe('an agent whose tools keep failing', () => {
  it('stops after that many failed rounds in a row', async () => {
    const r = await started({ settings: testSettings({}, { HARNESS_AGENT_TOOL_FAILURES: 2 }) });
    r.connect('fs').behaviour.run = () => Promise.resolve({ status: 'failed', error: { class: 'caller', message: 'no such file' } });
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'read' });
    r.provider.script(calls([['fs__read', { path: 'a' }]]), calls([['fs__read', { path: 'b' }]]), says('never'));
    const { run } = await r.module.agents.start(agentInput(turn));
    expect((await runTo(r, run)).settled).toMatchObject({ status: 'failed', error: { code: 'tool-failures' } });
    expect(r.provider.requests).toHaveLength(2);
  });
});

describe('an agent called as a tool', () => {
  it('keeps its own conversation and answers with a structured value', async () => {
    const r = await started();
    const turn = await r.turn();
    r.provider.script([{ content: '{"title":"Cats","points":["soft"]}' }, { finishReason: 'stop', usage: { text: { input: 5, output: 5 }, cost: 0.001 } }]);
    const { run } = await r.module.agents.start(agentInput(turn, 'tools/summarize', { topic: 'cats' }));
    const { settled, row } = await runTo(r, run);
    expect(settled).toEqual({ status: 'done', result: { title: 'Cats', points: ['soft'] } });
    expect(r.provider.requests[0]?.messages[0]?.content).toContain('Summarize cats.');
    expect(stateOf(row).messages?.map((m) => m.role)).toEqual(['assistant']);
    expect(r.chat.begun).toHaveLength(0);
  });
});

describe('a system agent with an output hook', () => {
  it('sends a refused answer back to the model with why, and keeps the one its system accepts', async () => {
    const r = await started();
    const tools = r.connect('tools');
    tools.behaviour.validate = (request) => (request.phase === 'output' && request.attempt === 1 ? { ok: false, action: 'retry', reason: 'Name a real title.' } : { ok: true });
    const turn = await r.turn();
    r.provider.script([{ content: '{"title":""}' }, { finishReason: 'stop', usage: { text: { input: 5, output: 5 }, cost: 0.001 } }], [{ content: '{"title":"Cats"}' }, { finishReason: 'stop', usage: { text: { input: 5, output: 5 }, cost: 0.001 } }]);
    const { run } = await r.module.agents.start(agentInput(turn, 'tools/checked'));
    const { settled, row } = await runTo(r, run);
    expect(settled).toEqual({ status: 'done', result: { title: 'Cats' } });
    expect(tools.validations).toMatchObject([{ phase: 'output', fn: 'checked', result: { title: '' }, attempt: 1 }, { phase: 'output', result: { title: 'Cats' }, attempt: 2 }]);
    expect(stateOf(row).messages?.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(stateOf(row).messages?.[1]?.content).toBe('Your answer was not accepted: Name a real title.');
  });

  it('fails the run when its system says stop', async () => {
    const r = await started();
    r.connect('tools').behaviour.validate = () => ({ ok: false, action: 'stop', reason: 'No titles today.' });
    const turn = await r.turn();
    r.provider.script([{ content: '{"title":"Cats"}' }, { finishReason: 'stop', usage: { text: { input: 5, output: 5 }, cost: 0.001 } }]);
    const { run } = await r.module.agents.start(agentInput(turn, 'tools/checked'));
    const { settled } = await runTo(r, run);
    expect(settled).toMatchObject({ status: 'failed', error: { message: 'No titles today.', code: 'output-refused' } });
  });
});

describe('agent loop pieces', () => {
  it('reads settled tool runs the way the model should', () => {
    expect(settledReply({ status: 'done', result: { a: 1 } }, SHOWN)).toBe('{"a":1}');
    expect(settledReply({ status: 'done', result: 'text' }, SHOWN)).toBe('text');
    expect(settledReply({ status: 'failed', error: { class: 'caller', message: 'nope' } }, SHOWN)).toBe('Error: nope');
    expect(settledReply({ status: 'cancelled' }, SHOWN)).toMatch(/cancelled/);
    // a table result is drawn for the person: the model reads its summary and the first rows
    const table = { columns: [{ name: 'n', kind: 'integer', nullable: false }], rows: [[1], [2], [3]], offset: 0, truncated: false, sort: [] };
    expect(JSON.parse(settledReply({ status: 'done', result: table }, { rows: 2, watched: true }))).toEqual({ summary: 'A table of 3 rows, shown to the person', columns: ['n'], rows: [[1], [2]], more: 1 });
    // nobody watching (a nested agent, a background or scheduled run): never "shown to the person", and more rows to answer from
    const headless: unknown = JSON.parse(settledReply({ status: 'done', result: table }, { rows: 2, watched: false }));
    expect(headless).toEqual({
      summary: 'A table of 3 rows. Nobody is watching this run, so no one sees them: answer from the first 2, and say the answer covers only those',
      columns: ['n'], rows: [[1], [2]], more: 1,
    });
    expect(JSON.parse(settledReply({ status: 'done', result: table }, { rows: 50, watched: false }))).toMatchObject({ summary: 'A table of 3 rows. Nobody is watching this run, so no one sees them: answer from them', more: 0 });
  });

  it('answers tool calls right after their assistant message, before later user messages', async () => {
    const conversation = new RunConversation([{ role: 'user', content: 'a' }, { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 't', arguments: '{}' }] }]);
    await conversation.append([{ role: 'user', content: 'b' }]);
    await conversation.answer(1, [{ role: 'tool', toolCallId: '1', content: 'r' }]);
    expect((await conversation.messages()).map((m) => m.content)).toEqual(['a', '', 'r', 'b']);
  });
});

function helperDecl(r: ExecutionRig) {
  const record = r.catalog.records.get('tools/helper');
  if (record === undefined) throw new Error('no helper');
  return record.decl;
}
