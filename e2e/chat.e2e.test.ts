/**
 * The whole harness, end to end, against a real hub with the real fs and embedder systems and a free OpenRouter
 * model: sign in, start a session, have the chat agent read and summarise a file and run a shell command, and check
 * what the hub records and streams along the way. Tests share one session and run in order.
 */
import { QualifiedName, SystemName, type RunId, type SessionId, type TreeNode, type TurnId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { admin, Approver, ask as askAgent, clientInfo, finished, SessionWatch, settings, settle, statusOf, textOf } from './kit.ts';

const TURN = settings.HARNESS_E2E_TURN_TIMEOUT;
const FS = SystemName.parse('fs');
const fsFn = (name: string) => QualifiedName.parse(`fs/${name}`);

/** Every run in a turn's tree, depth first. */
function runsOf(node: TreeNode): TreeNode[] {
  return [node, ...node.children.flatMap(runsOf)];
}

let me: SignedIn;
let other: SignedIn;
let watch: SessionWatch;
let watcher: SessionWatch;
let approver: Approver;
let session: SessionId;
const id = () => watch.session;

/** Approve every approval the session asks for while `work` runs. */
const approving = <T>(work: Promise<T>) => approver.during(work);

/** Send a message and wait for the agent's finished answer. */
const ask = (text: string) => askAgent(me, watch, text, TURN);

beforeAll(async () => {
  me = await admin();
  other = await admin();
  await Promise.all([settle(me), settle(other)]);
  const created = await me.hub.call('createSession', { title: 'e2e' });
  session = created.id;
  watch = new SessionWatch(me, created.id);
  watcher = new SessionWatch(other, created.id);
  approver = new Approver(me, watch);
  await settle(me);
});

afterAll(() => {
  watch.stop();
  watcher.stop();
  me.close();
  other.close();
});

describe('signing in and the systems', () => {
  it('signs in as the single admin account', async () => {
    const user = await me.hub.call('me');
    expect(user.role).toBe('admin');
    expect(user.email).toBe(settings.HARNESS_E2E_EMAIL);
  });

  it('has fs and the embedder connected, with fs configured and its fns in the catalog', async () => {
    const systems = await me.hub.call('systems');
    expect(systems.find((s) => s.name === FS)).toMatchObject({ status: 'connected', needsConfig: false });
    expect(systems.find((s) => s.name === SystemName.parse('embedder'))).toMatchObject({ status: 'connected' });
    const fns = await me.hub.call('systemFns', { system: FS });
    expect(fns.map((f) => f.name)).toEqual(expect.arrayContaining([fsFn('read'), fsFn('bash'), fsFn('cd')]));
  });

  it('started the session the admin owns', () => {
    expect(session).toMatch(/^ses_/);
  });
});

describe('finding things', () => {
  it('suggests fns from the embedding of a draft message', async () => {
    const suggestions = await waitFor('fs/read to be indexed', async () => {
      const found = await me.hub.call('suggest', { session: id(), text: 'show me what is inside a text file', limit: 8 });
      return found.some((s) => s.kind === 'fn' && s.name === fsFn('read')) ? found : undefined;
    }, { timeout: 60_000, every: 1_000 });
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('mentions files by name and shows a hover card for one', async () => {
    const provider = QualifiedName.parse('fs/files');
    const options = await me.hub.call('mentions', { session: id(), provider, query: 'README' });
    const readme = options.find((o) => o.label.endsWith('README.md'));
    expect(readme).toBeDefined();
    if (readme === undefined) { return; }
    const { hover } = await me.hub.call('mentionHover', { session: id(), provider, target: readme.target });
    expect(hover).toBeDefined();
  });
});

describe('the chat agent', () => {
  let readTurn: TurnId;
  let bashRun: RunId;

  it('reads a file and summarises it, streaming its answer', async () => {
    const { turn, answer } = await ask('Use the fs/read tool to read README.md, then summarise it in two sentences. Do not run shell commands.');
    readTurn = turn;
    expect(answer.status).toBe('done');
    expect(textOf(answer).length).toBeGreaterThan(40);
    expect(watch.of('token').length + watch.of('reasoning').length).toBeGreaterThan(0);
  });

  it('reported live statuses for the agent and for fs/read', async () => {
    await watch.next('run', (e) => e.fn === QualifiedName.parse('hub/chat') && statusOf(e.update) === 'done', 30_000);
    const statuses = (fn: QualifiedName) => watch.of('run').filter((e) => e.fn === fn).map((e) => statusOf(e.update));
    expect(statuses(QualifiedName.parse('hub/chat'))).toEqual(expect.arrayContaining(['queued', 'running', 'done']));
    expect(statuses(fsFn('read'))).toContain('done');
  });

  it('keeps the fn tree of the turn, with its LLM calls', async () => {
    const tree = await me.hub.call('tree', { turn: readTurn });
    expect(tree.run.fn).toBe('hub/chat');
    expect(runsOf(tree).some((node) => node.run.fn === fsFn('read') && node.run.status === 'done')).toBe(true);
    expect(tree.llmCalls.length).toBeGreaterThan(0);
  });

  it('saved every LLM interaction with its request and response', async () => {
    const page = await me.hub.call('llmCalls', { session: id() });
    const done = page.items.find((call) => call.status === 'done');
    expect(done).toBeDefined();
    if (done === undefined) { return; }
    const call = await me.hub.call('llmCall', { id: done.id });
    expect(call.request.messages.length).toBeGreaterThan(0);
    expect(call.response).toBeDefined();
    expect(call.model).toBe(done.model);
  });

  it('records spend against the budgets that apply', async () => {
    const { id: budget } = await me.hub.call('setBudget', { target: { scope: 'session', session: id() }, period: 'all-time', maxCost: 5, onLimit: 'refuse' });
    const limits = await me.hub.call('limits', { session: id() });
    expect(limits.budgets.map((b) => b.rule)).toContain(budget);
    const budgets = await me.hub.call('budgets', {});
    const mine = budgets.find((b) => b.id === budget);
    expect(mine?.spent).toBeGreaterThanOrEqual(0);
    const runs = await me.hub.call('runs', { session: id() });
    expect(runs.items.every((run) => run.cost >= 0)).toBe(true);
  });

  it('asks before a fn that is not read-only, then runs the command and shows its card', async () => {
    const { result, approvals } = await approving(ask('Use the fs/bash tool to run exactly this command: echo harness-e2e-ok. Then tell me what it printed.'));
    expect(approvals.map((a) => a.fn)).toContain(fsFn('bash'));
    expect(result.answer.status).toBe('done');
    const tree = await me.hub.call('tree', { turn: result.turn });
    const bash = runsOf(tree).find((node) => node.run.fn === fsFn('bash'));
    expect(bash?.run.status).toBe('done');
    expect(bash).toBeDefined();
    if (bash === undefined) { return; }
    const run = await me.hub.call('run', { run: bash.run.id });
    expect(JSON.stringify(run.outcome)).toContain('harness-e2e-ok');
    bashRun = run.id;
  });

  it('runs the command again from the bash card', async () => {
    const { delivery } = await me.hub.call('act', { session: id(), system: FS, action: 'rerun', input: { command: 'echo harness-e2e-ok' }, run: bashRun, client: clientInfo() });
    const done = await watch.next('delivery', (e) => e.delivery.id === delivery && (e.delivery.status === 'done' || e.delivery.status === 'failed'), 60_000);
    expect(done.delivery.status).toBe('done');
    expect(JSON.stringify(done.delivery.result)).toContain('harness-e2e-ok');
  });
});

describe('session state and realtime', () => {
  it('keeps the working folder cd sets, for later commands', async () => {
    const { result: cd } = await approving((async () => {
      const invoked = await me.hub.call('invoke', { session: id(), fn: fsFn('cd'), args: { path: 'packages' }, client: clientInfo() });
      await watch.next('run', (e) => e.run === invoked.run && finished(e.update), 60_000);
      return invoked;
    })());
    const run = await me.hub.call('run', { run: cd.run });
    expect(run.status).toBe('done');
    const state = await me.hub.call('state', { run: cd.run });
    expect(JSON.stringify(state.values)).toContain('packages');

    const { result: pwd } = await approving((async () => {
      const invoked = await me.hub.call('invoke', { session: id(), fn: fsFn('bash'), args: { command: 'pwd' }, client: clientInfo() });
      await watch.next('run', (e) => e.run === invoked.run && finished(e.update), 60_000);
      return invoked;
    })());
    expect(JSON.stringify((await me.hub.call('run', { run: pwd.run })).outcome)).toContain('packages');
  });

  it('streams the same session to a second signed-in browser as it happens', () => {
    const mine = watch.of('message').map((e) => e.message.id);
    const theirs = new Set(watcher.of('message').map((e) => e.message.id));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((message) => theirs.has(message))).toBe(true);
    expect(watcher.of('run').length).toBeGreaterThan(0);
  });
});
