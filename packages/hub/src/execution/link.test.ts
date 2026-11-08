import { agent, fn, g, handler, hub, system } from '@harness/sdk';
import { ActorId, HandlerCallId, LinkSession, hubLinkSpec, type RunId, type LlmForwardChunk, type LlmRequest, type QualifiedName, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { linkPayload } from '../testing.ts';
import { EXECUTION_LINK_SPEC } from './create.ts';
import type { RunInput } from './index.ts';
import { AGENT, ALICE, calls, executionRig, says, SESSION, until, type ExecutionRig } from './testing.ts';

const confirm = handler({ description: 'Sure?', args: g.obj({ path: g.text() }), returns: g.bool(), required: false });
const files = system('fs', { description: 'Files.' }).with({
  fns: {
    read: fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }),
    remove: fn({ description: 'Remove.', args: g.obj({ path: g.text() }), returns: g.bool(), tags: ['read'], handlers: { confirm } }),
  },
});
const remover = agent({ description: 'Removes files.', args: g.obj({}), returns: g.text(), instructions: 'Remove what you are asked to.', tools: [files.fns.remove] });
const copy = fn({ description: 'Copy.', args: g.obj({ from: g.text() }), returns: g.text(), tags: ['read'], deps: { read: files.fns.read, remove: files.fns.remove } });

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(): Promise<ExecutionRig> {
  rig = await executionRig();
  rig.catalog.add('fs', 'read', fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }));
  rig.catalog.add('fs', 'remove', fn({ description: 'Remove.', args: g.obj({ path: g.text() }), returns: g.bool(), tags: ['read'], handlers: { confirm } }));
  rig.catalog.add('fs', 'copy', copy);
  rig.catalog.add('tools', 'remover', remover);
  rig.catalog.add('hub', 'run_status', fn({ description: 'Status.', args: hub.fns.run_status.args, returns: hub.fns.run_status.returns, tags: ['read'] }));
  rig.catalog.add('hub', 'run_wait', fn({ description: 'Wait.', args: hub.fns.run_wait.args, returns: hub.fns.run_wait.returns, tags: ['read'] }));
  await rig.module.start();
  return rig;
}

const input = (turn: Turn, name: QualifiedName, args: RunInput['args']): RunInput => ({
  fn: name, args, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
});
const fsLink = LinkSession.parse({ system: 'fs', instance: 'main', boot: 'test-1' });
const otherLink = LinkSession.parse({ system: 'other', instance: 'main', boot: 'o-1' });

/** A running fs run the link calls can belong to. */
async function parentRun(r: ExecutionRig): Promise<{ turn: Turn; run: RunId }> {
  const fs = r.connect('fs');
  fs.behaviour.run = () => new Promise(() => undefined);
  const turn = await r.turn();
  const { run } = await r.module.runs.start(input(turn, 'fs/copy', { from: 'a' }));
  await until(async () => (await r.module.runs.get(run))?.status === 'running', 'the parent to run');
  return { turn, run };
}

/** Call a link handler the way the link server does, as the fs system unless told otherwise. */
const payload = <D>(data: D, link: LinkSession = fsLink) => linkPayload(data, link);

async function collect(stream: AsyncIterable<LlmForwardChunk> | Promise<AsyncIterable<LlmForwardChunk>>): Promise<LlmForwardChunk[]> {
  const out: LlmForwardChunk[] = [];
  for await (const chunk of await stream) out.push(chunk);
  return out;
}

describe('the link endpoints', () => {
  it("serve the hub link endpoints themselves, so their types are the spec's", async () => {
    const r = await started();
    const served: Record<string, unknown> = hubLinkSpec.endpoints;
    for (const [name, endpoint] of Object.entries(EXECUTION_LINK_SPEC.endpoints)) expect(endpoint).toBe(served[name]);
    expect(Object.keys(r.module.linkHandlers).sort()).toEqual(Object.keys(EXECUTION_LINK_SPEC.endpoints).sort());
  });

  it('run a child call as a child of the calling run and answer when it settles', async () => {
    const r = await started();
    const { run } = await parentRun(r);
    r.connect('fs').behaviour.run = (request) => Promise.resolve({ status: 'done', result: `read ${JSON.stringify(request.args)}` });
    const settled = await r.module.linkHandlers.call(payload({ parent: run, fn: 'fs/read', args: { path: 'b' }, key: 'r1', handlers: [], background: false }));
    expect(settled).toEqual({ status: 'done', result: 'read {"path":"b"}' });
    const child = (await r.store.table('runs').find({ where: { parent: run }, limit: 5 })).items[0];
    expect(child).toMatchObject({ fn: 'fs/read', key: 'r1', root: run });
    const repeat = await r.module.linkHandlers.call(payload({ parent: run, fn: 'fs/read', args: { path: 'b' }, key: 'r1', handlers: [], background: false }));
    expect(repeat).toEqual(settled);
    expect((await r.store.table('runs').find({ where: { parent: run }, limit: 5 })).items).toHaveLength(1);
  });

  it('answer a refused child call as a failure, and refuse runs that are not the system\'s', async () => {
    const r = await started();
    const { run } = await parentRun(r);
    expect(await r.module.linkHandlers.call(payload({ parent: run, fn: 'fs/nope', args: {}, key: 'x', handlers: [], background: false }))).toMatchObject({ status: 'failed', error: { code: 'not-found' } });
    await expect(r.module.linkHandlers.call(payload({ parent: run, fn: 'fs/read', args: {}, key: 'x', handlers: [], background: false }, otherLink))).rejects.toThrow(/not other's/);
    await expect(r.module.linkHandlers.progress(payload({ run, progress: { fraction: 0.5 } }, otherLink))).rejects.toThrow();
  });

  it('take a run\'s progress, operations and undo payload', async () => {
    const r = await started();
    const { run } = await parentRun(r);
    await r.module.linkHandlers.progress(payload({ run, progress: { step: 'copy', status: 'active' } }));
    await r.module.linkHandlers.allow(payload({ run, operations: { cancel: false } }));
    await r.module.linkHandlers.undoWith(payload({ run, undo: { path: 'a' } }));
    expect(await r.module.runs.get(run)).toMatchObject({ progress: { steps: { copy: { status: 'active' } } }, allowed: { cancel: false }, undo: { path: 'a' } });
    expect(r.bus.of('run.update').map((u) => u.update.type)).toEqual(expect.arrayContaining(['progress', 'allowed']));
  });

  it('let a system cancel only the child calls it made, and tell it about them', async () => {
    const r = await started();
    const { run } = await parentRun(r);
    const fs = r.connect('fs');
    fs.behaviour.run = () => new Promise(() => undefined);
    void r.module.linkHandlers.call(payload({ parent: run, fn: 'fs/read', args: { path: 'b' }, key: 'r2', handlers: [], background: false }));
    await until(async () => (await r.store.table('runs').find({ where: { parent: run }, limit: 1 })).items[0]?.status === 'running', 'the child to run');
    const child = (await r.store.table('runs').find({ where: { parent: run }, limit: 1 })).items[0];
    if (child === undefined) throw new Error('no child');
    expect(await r.module.linkHandlers.control(payload({ run: child.id, action: 'cancel' }, otherLink))).toMatchObject({ accepted: false });
    fs.behaviour.control = () => ({ accepted: false, reason: 'busy' });
    expect(await r.module.linkHandlers.control(payload({ run: child.id, action: 'cancel' }))).toEqual({ accepted: false, reason: 'busy' });
    await until(() => fs.children.some((c) => c.run === child.id), 'the child notice');
    expect(fs.children.find((c) => c.run === child.id)).toMatchObject({ parent: run, key: 'r2' });
  });
});

describe('handlers', () => {
  it('relay a child run\'s handler call to the system whose run called it', async () => {
    const r = await started();
    const { run } = await parentRun(r);
    const fs = r.connect('fs');
    let answer: unknown;
    fs.behaviour.run = async (request) => {
      if (request.fn !== 'remove') return { status: 'done', result: '' };
      answer = await r.module.linkHandlers.handle(payload({ run: request.run.id, handler: 'confirm', args: { path: 'b' } }));
      return { status: 'done', result: true };
    };
    fs.behaviour.handler = (h) => ({ ok: true, value: h.key === 'del' && h.handler === 'confirm' });
    const settled = await r.module.linkHandlers.call(payload({ parent: run, fn: 'fs/remove', args: { path: 'b' }, key: 'del', handlers: ['confirm'], background: false }));
    expect(settled).toEqual({ status: 'done', result: true });
    expect(answer).toEqual({ ok: true, value: true });
    expect((await r.store.table('handlerCalls').find({ limit: 5 })).items).toMatchObject([{ handler: 'confirm', status: 'answered', result: true, answerer: { system: 'fs', run } }]);
  });

  it('ask the person who ran a fn themselves, and take only their answer', async () => {
    const r = await started();
    const fs = r.connect('fs');
    let answer: unknown;
    fs.behaviour.run = async (request) => {
      answer = await r.module.linkHandlers.handle(payload({ run: request.run.id, handler: 'confirm', args: { path: 'x' } }));
      return { status: 'done', result: true };
    };
    const turn = await r.turn();
    const { settled } = await r.module.runs.start(input(turn, 'fs/remove', { path: 'x' }));
    await until(() => r.bus.of('handler').length > 0, 'the handler call');
    const call = r.bus.of('handler')[0]?.call;
    if (call === undefined) throw new Error('no call');
    expect(call).toMatchObject({ status: 'pending', answerer: { user: ALICE }, decl: { description: 'Sure?' } });
    await expect(r.module.handlers.answer(call.id, true, ActorId.parse('act_bob'))).rejects.toThrow(/wasn't asked/);
    await r.module.handlers.answer(call.id, true, ALICE);
    await settled;
    expect(answer).toEqual({ ok: true, value: true });
    await expect(r.module.handlers.answer(call.id, true, ALICE)).rejects.toThrow(/already/);
    await expect(r.module.handlers.answer(HandlerCallId.parse('hcl_none'), true, ALICE)).rejects.toThrow(/no handler call/);
  });

  it("ask the turn's person for a run an agent called, since the agent can't answer a form", async () => {
    const r = await started();
    const fs = r.connect('fs');
    let answer: unknown;
    fs.behaviour.run = async (request) => {
      answer = await r.module.linkHandlers.handle(payload({ run: request.run.id, handler: 'confirm', args: { path: 'x' } }));
      return { status: 'done', result: true };
    };
    await r.session();
    const turn = await r.turn({ session: SESSION, text: 'Remove x.' });
    r.provider.script(calls([['fs__remove', { path: 'x' }]]), says('Removed.'));
    const { run } = await r.module.agents.start({
      kind: 'hub/llm', fn: 'tools/remover', args: {}, turn: turn.id, session: SESSION, key: 'answer', actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [],
    });
    await until(() => r.bus.of('handler').length > 0, 'the handler call');
    const call = r.bus.of('handler')[0]?.call;
    if (call === undefined) throw new Error('no call');
    expect(call).toMatchObject({ status: 'pending', answerer: { user: ALICE }, args: { path: 'x' } });
    await r.module.handlers.answer(call.id, true, ALICE);
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'Removed.' });
    expect(answer).toEqual({ ok: true, value: true });
  });

  it('refuse a handler the caller does not answer', async () => {
    const r = await started();
    const { run } = await parentRun(r);
    const fs = r.connect('fs');
    let answer: unknown;
    fs.behaviour.run = async (request) => {
      answer = await r.module.linkHandlers.handle(payload({ run: request.run.id, handler: 'confirm', args: {} }));
      return { status: 'done', result: true };
    };
    await r.module.linkHandlers.call(payload({ parent: run, fn: 'fs/remove', args: { path: 'b' }, key: 'del', handlers: [], background: false }));
    expect(answer).toMatchObject({ ok: false, error: { code: 'no-handler' } });
  });
});

describe('the LLM forward', () => {
  it('streams a system\'s call through the hub AI, saving it against the system\'s run', async () => {
    const r = await started();
    const { run } = await parentRun(r);
    r.provider.script(says('forwarded!', 0.002));
    const request: LlmRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] };
    const chunks = await collect(r.module.linkHandlers.llm(payload({ run, request, stream: true })));
    expect(chunks[0]).toEqual({ type: 'descriptors', tools: {} });
    expect(chunks.flatMap((c) => (c.type === 'chunk' ? [c.chunk.content ?? ''] : [])).join('')).toBe('forwarded!');
    const done = chunks.at(-1);
    expect(done).toMatchObject({ type: 'done', cost: 0.002, model: 'test-model', usage: { input: 10, output: 5 } });
    const saved = (await r.store.table('llmInteractions').find({ where: { run }, limit: 5 })).items[0];
    expect(saved).toMatchObject({ system: 'fs', status: 'done', request: { tools: [{ name: 'lookup' }] } });
    expect(r.provider.requests[0]?.tools?.[0]?.parameters.safeParse({ q: 'x' }).success).toBe(true);
    expect((await r.module.runs.get(run))?.cost).toBeCloseTo(0.002);
  });

  it('refuses calls outside a run, for another system\'s run, with bad schemas, or over budget', async () => {
    const r = await started();
    const { run, turn } = await parentRun(r);
    const request: LlmRequest = { messages: [{ role: 'user', content: 'hi' }] };
    expect(await collect(r.module.linkHandlers.llm(payload({ request, stream: true })))).toMatchObject([{ type: 'error', kind: 'limit' }]);
    expect(await collect(r.module.linkHandlers.llm(payload({ run, request, stream: true }, otherLink)))).toMatchObject([{ type: 'error', kind: 'limit' }]);
    expect(await collect(r.module.linkHandlers.llm(payload({ run, request: { ...request, tools: [{ name: 't', parameters: { type: 'string' } }] }, stream: true })))).toMatchObject([{ type: 'error', kind: 'tool' }]);
    await r.store.table('turns').update(turn.id, { cost: 5 });
    expect(await collect(r.module.linkHandlers.llm(payload({ run, request, stream: true })))).toEqual([{ type: 'error', kind: 'limit', message: "this message's budget of $1.00 is used up" }]);
    await r.module.runs.settle(run, { status: 'done', result: 'x' });
    expect(await collect(r.module.linkHandlers.llm(payload({ run, request, stream: true })))).toEqual([{ type: 'error', kind: 'limit', message: `Run ${run} has already finished.` }]);
  });

  it('reports a provider failure', async () => {
    const r = await started();
    const { run } = await parentRun(r);
    r.provider.script(new Error('upstream down'));
    const chunks = await collect(r.module.linkHandlers.llm(payload({ run, request: { messages: [{ role: 'user', content: 'hi' }] }, stream: true })));
    expect(chunks).toEqual([{ type: 'error', kind: 'provider', message: 'upstream down' }]);
  });
});

describe('the run fns', () => {
  it('report a run\'s status and wait for one', async () => {
    const r = await started();
    const fs = r.connect('fs');
    let release: (o: { status: 'done'; result: string }) => void = () => undefined;
    fs.behaviour.run = () => new Promise((resolve) => { release = resolve; });
    const turn = await r.turn();
    const target = await r.module.runs.start(input(turn, 'fs/read', { path: 'a' }));
    await until(() => fs.requests.length === 1, 'the target to run');
    const status = await r.module.runs.start({ ...input(turn, 'hub/run_status', { run: target.run }), key: 's' });
    expect(await status.settled).toEqual({ status: 'done', result: { status: 'running' } });
    const waiting = await r.module.runs.start({ ...input(turn, 'hub/run_wait', { run: target.run }), key: 'w' });
    release({ status: 'done', result: 'text' });
    expect(await waiting.settled).toEqual({ status: 'done', result: { status: 'done', result: 'text' } });
    const missing = await r.module.runs.start({ ...input(turn, 'hub/run_status', { run: 'run_none' }), key: 'm' });
    expect(await missing.settled).toMatchObject({ status: 'failed', error: { message: 'There is no run run_none.' } });
  });
});
