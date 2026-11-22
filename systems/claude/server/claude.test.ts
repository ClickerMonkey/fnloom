/**
 * The claude system with the SDK test kit and a scripted Claude (no session ever starts): starting a session makes the
 * person's record and opens it in a configured folder only; `send` follows the turn with progress; a tool use is a
 * proposal for the owner that the approved `permit` run settles, and a question is one with a form that a decline
 * answers; transcripts and Claude's store page; imports make skill context and agent fns. The SDK mappings (messages,
 * transcript items, forms, MCP configs) are checked on their own.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ActorId, jsonOf, McpServerConfig, mintId, qualify, SystemView, type DataRecord } from '@harness/core';
import type { ClaudeInstanceConfig, ClaudeTranscriptItem } from '../shared/session.ts';
import { TEST_USER, testHub, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { claude } from '../shared/index.ts';
import { bodyOf, eventsOf, mcpConfigOf } from './agent-sdk.ts';
import { claudeEnv, sessionEnv } from './env.ts';
import { FakeClaudeDriver } from './fake-driver.ts';
import { allowedFolder, createClaudeImpl, type ClaudeRuntime } from './impl.ts';
import { askUserQuestionForm, elicitationForm } from './questions.ts';
import { itemsOf } from './transcript.ts';

claudeEnv.set({ CLAUDE_RECORD_DEBOUNCE: '0' });

const ROOT = resolve('.harness-test/claude-folders');
const FOLDER = resolve(ROOT, 'shop');
const MEMBER = { ...TEST_USER, role: 'member' as const };

let kit: TestSystem<'claude', typeof claude.defs> | undefined;
afterEach(async () => { await kit?.stop(); kit = undefined; });

async function setup(records: readonly DataRecord[] = [], extra: Partial<ClaudeInstanceConfig> = {}) {
  const driver = new FakeClaudeDriver();
  const patches: Parameters<ClaudeRuntime['patch']>[0][] = [];
  const runtime: ClaudeRuntime = { patch: (change) => { patches.push(change); return Promise.resolve({ added: [], updated: [], removed: [], refused: [] }); } };
  const server = createClaudeImpl({ settings: claudeEnv.parse(), driver, runtime: () => Promise.resolve(runtime) });
  kit = await testHub(claude, server.impl, { config: { folders: [{ path: ROOT, label: 'Code' }], maxLive: 2, ...extra }, records });
  return { kit, driver, patches, fleet: server.fleet };
}

describe('claude system', () => {
  it('starts a session in a configured folder as the person\'s record, and refuses any other folder', async () => {
    const { kit, driver } = await setup();
    const started = await kit.call('start_session', { folder: FOLDER, prompt: 'Fix the failing checkout test.' });
    expect(started.result).toMatchObject({ instance: 'main', status: 'working' });
    const live = driver.live(started.result.session);
    expect(live.open).toMatchObject({ resume: false, folder: FOLDER, permissionMode: 'default' });
    expect(live.sent).toEqual(['Fix the failing checkout test.']);
    const [record] = kit.records('Session');
    expect(record?.owner).toBe(TEST_USER.id);
    expect(record?.value).toMatchObject({ session: started.result.session, folder: FOLDER, title: 'Fix the failing checkout test.', owner: TEST_USER.id });

    const outside = await kit.run('start_session', { folder: resolve('..'), prompt: 'Hi.' });
    expect(outside.outcome.status).toBe('invalid-input');
    // a model learns where sessions may start from claude/folders
    expect((await kit.call('folders', {})).result).toEqual({ instance: 'main', folders: [{ path: ROOT, label: 'Code' }] });
  });

  it('never lets a run switch a session to a mode that asks less: control asks the person on a card, every time', async () => {
    const { kit, driver } = await setup();
    const { result } = await kit.call('start_session', { folder: FOLDER, prompt: 'Look at the tests.' });
    // an injected agent's control call (write, free) switches nothing by itself
    const asked = await kit.call('control', { instance: 'main', session: result.session, action: 'mode', mode: 'acceptEdits' });
    expect(driver.live(result.session).modes).toEqual([]);
    expect(asked.result.modeAsked).toMatchObject({ mode: 'acceptEdits' });
    const proposal = kit.hub.proposals.at(-1);
    expect(proposal).toMatchObject({ fn: 'allow_mode', approver: 'person', args: { instance: 'main', session: result.session, mode: 'acceptEdits' }, preview: { title: 'Let Claude work in acceptEdits mode?' } });
    expect(JSON.stringify(proposal?.preview)).toContain('edits files');
    // a direct allow_mode run (not the approved proposal) switches nothing either
    expect((await kit.run('allow_mode', { instance: 'main', session: result.session, mode: 'auto' })).outcome.status).toBe('failed');
    expect((await kit.approve(proposal?.run ?? '')).status).toBe('done');
    expect(driver.live(result.session).modes).toEqual(['acceptEdits']);
    // its approvals are never remembered as a policy: the hub asks every time
    expect(claude.defs.fns.allow_mode.approval).toEqual({ preview: true, remember: false });
  });

  it('starts a session asked for in auto mode in default, asking the person for auto', async () => {
    const { kit, driver } = await setup();
    const { result } = await kit.call('start_session', { folder: FOLDER, prompt: 'Refactor it all.', permissionMode: 'auto' });
    expect(driver.live(result.session).open).toMatchObject({ permissionMode: 'default' });
    expect(kit.records('Session')[0]?.value).toMatchObject({ permissionMode: 'default' });
    expect(result.modeAsked).toMatchObject({ mode: 'auto' });
    expect(kit.hub.proposals.at(-1)).toMatchObject({ fn: 'allow_mode', args: { mode: 'auto' }, preview: { title: 'Let Claude work in auto mode?' } });
    // plan asks no one
    const planned = await kit.call('start_session', { folder: FOLDER, prompt: 'Plan it.', permissionMode: 'plan' });
    expect(driver.live(planned.result.session).open).toMatchObject({ permissionMode: 'plan' });
    expect(planned.result.modeAsked).toBeUndefined();
  });

  it('refuses a folder that a link inside a configured folder leads out of', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'claude-outside-'));
    try {
      symlinkSync(outside, join(root, 'escape'), 'junction');
      mkdirSync(join(root, 'inside'));
      const config = { folders: [{ path: root }], permissionMode: 'default' as const, maxLive: 2, idleClose: 3_600_000 };
      expect(allowedFolder(join(root, 'escape'), config)).toBeUndefined();
      expect(allowedFolder(join(root, 'escape', 'deeper'), config)).toBeUndefined();
      expect(allowedFolder(join(root, 'inside'), config)).toBe(join(realpathSync.native(root), 'inside'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses an admin's send to a member's session, whose questions only that member answers", async () => {
    const { kit, driver } = await setup();
    const member = { ...MEMBER, id: ActorId.parse('act_member') };
    const asMember = (fn: string) => ({ run: kit.hub.runInfo(qualify('claude', fn), { user: member }) });
    const started = await kit.run('start_session', { folder: FOLDER, prompt: 'Look at the tests.' }, asMember('start_session'));
    const session = z.object({ session: z.string() }).parse(started.outcome.status === 'done' ? started.outcome.result : {}).session;
    const sent = await kit.run('send', { instance: 'main', session, text: 'Delete everything.' });
    expect(sent.outcome.status).toBe('invalid-input');
    expect(driver.live(session).sent).toEqual(['Look at the tests.']);
    // nor may the admin change what the session does without asking its member
    expect((await kit.run('control', { instance: 'main', session, action: 'mode', mode: 'acceptEdits' })).outcome.status).toBe('invalid-input');
    expect(driver.live(session).open).toMatchObject({ permissionMode: 'default' });
    expect(kit.records('Session')[0]?.value).toMatchObject({ owner: member.id, permissionMode: 'default' });
  });

  it("gives the hub MCP only to its person's sessions, since the hub runs its calls as that person", async () => {
    const hubMcp = { url: 'http://127.0.0.1:4720/mcp/claude', secret: 'mcp-secret', person: TEST_USER.id };
    const { kit, driver } = await setup([], { hubMcp });
    const own = await kit.call('start_session', { folder: FOLDER, prompt: 'Use the harness.' });
    expect(driver.live(own.result.session).open.hubMcp).toEqual({ url: hubMcp.url, secret: hubMcp.secret });
    const member = { ...MEMBER, id: ActorId.parse('act_member') };
    const started = await kit.run('start_session', { folder: FOLDER, prompt: 'Use the harness.' }, { run: kit.hub.runInfo(qualify('claude', 'start_session'), { user: member }) });
    const session = z.object({ session: z.string() }).parse(started.outcome.status === 'done' ? started.outcome.result : {}).session;
    expect(driver.live(session).open.hubMcp).toBeUndefined();
  });

  it('sends with wait, following the turn as progress and answering with Claude\'s reply', async () => {
    const { kit, driver } = await setup();
    const { result } = await kit.call('start_session', { folder: FOLDER, prompt: 'Look at the tests.' });
    const live = driver.live(result.session);
    const sent = kit.call('send', { instance: 'main', session: result.session, text: 'Run them.', wait: true });
    await vi.waitFor(() => { expect(live.sent).toEqual(['Look at the tests.', 'Run them.']); });
    live.emit({ type: 'tool', tool: 'Bash', line: 'Bash: npm test' });
    live.emit({ type: 'result', ok: true, text: '12 tests pass.', costUsd: 0.04, turns: 2 });
    const answered = await sent;
    expect(answered.result).toEqual({ instance: 'main', session: result.session, status: 'idle', text: '12 tests pass.', costUsd: 0.04 });
    expect(JSON.stringify(answered.progress)).toContain('Bash: npm test');

    const elsewhere = await kit.run('send', { instance: 'laptop', session: result.session, text: 'Hi.' });
    expect(elsewhere.outcome.status).toBe('invalid-input');
  });

  it('proposes a tool use for the owner and lets Claude use it when the permit run is approved', async () => {
    const { kit, driver } = await setup();
    const { result } = await kit.call('start_session', { folder: FOLDER, prompt: 'Clean the build.' });
    const decided = driver.live(result.session).permit({ tool: 'Bash', input: { command: 'rm -rf dist' }, canAlways: true });
    await vi.waitFor(() => { expect(kit.hub.proposals).toHaveLength(1); });
    const proposal = kit.hub.proposals[0];
    expect(proposal).toMatchObject({ fn: 'permit', approver: 'person', for: TEST_USER.id, ask: { into: 'always' }, preview: { title: 'Claude wants to use Bash' } });
    const args = z.object({ request: z.string() }).parse(proposal?.args);
    // a run naming another session (or another machine) settles nothing
    const misnamed = await kit.run('permit', { instance: 'main', session: '6f1d7a0e-3b8c-4c2e-9a1f-2d4b6c8e0a13', request: args.request, tool: 'Bash', input: {}, always: true });
    expect(misnamed.outcome.status).toBe('failed');
    // a direct run naming the waiting request (an admin's, say) is not the proposed run, so it settles nothing
    const direct = await kit.run('permit', { instance: 'main', session: result.session, request: args.request, tool: 'Bash', input: {}, always: true });
    expect(direct.outcome.status).toBe('failed');
    // the hub runs the approved proposal with the person's form value set at args.always
    const permitted = await kit.approve(proposal?.key ?? '', true);
    expect(permitted).toMatchObject({ status: 'done', result: { allowed: true, always: true } });
    await expect(decided).resolves.toEqual({ allow: true, always: true });

    const again = await kit.run('permit', { instance: 'main', session: result.session, request: args.request, tool: 'Bash', input: {}, always: false });
    expect(again.outcome).toMatchObject({ status: 'failed' });
  });

  it('proposes a question with its form, and a declined run tells Claude the person did not answer', async () => {
    const { kit, driver } = await setup();
    const { result } = await kit.call('start_session', { folder: FOLDER, prompt: 'Add a database.' });
    const form = askUserQuestionForm({ questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false }] });
    const replied = driver.live(result.session).question({ from: 'question', title: form.title, text: form.text, form: form.form });
    await vi.waitFor(() => { expect(kit.hub.proposals).toHaveLength(1); });
    const proposal = kit.hub.proposals[0];
    expect(proposal).toMatchObject({ fn: 'answer', ask: { into: 'answer', type: form.form }, preview: { title: 'Claude asks: Which database?' } });
    // Claude hears who declined and why, in the hub's words
    await kit.hub.declineProposal(proposal?.run ?? mintId('run'), 'use what we have');
    await expect(replied).resolves.toEqual({ declined: `Declined by ${TEST_USER.name}: use what we have` });
  });

  it('closes, on start, the busy records of sessions a restart left without a live handle', async () => {
    const waiting = mintId('run');
    const stuck = {
      id: mintId('record'), type: qualify('claude', 'Session'), owner: TEST_USER.id, title: 'Old work', version: 3, createdAt: 1, updatedAt: 1, updatedBy: TEST_USER.id,
      value: {
        instance: 'main', session: '6f1d7a52-9a3e-4a6e-8f0a-0c1b2d3e4f50', folder: FOLDER, title: 'Old work', status: 'waiting', permissionMode: 'default',
        owner: TEST_USER.id, waiting: [waiting], asking: ['x'], tasks: [], turns: 1, costUsd: 0, startedAt: 1, updatedAt: 1,
      },
    };
    const { kit } = await setup([stuck]);
    await vi.waitFor(() => { expect(kit.hub.data.records.get(stuck.id)?.value).toMatchObject({ status: 'closed', waiting: [], asking: [] }); });
    expect(kit.hub.data.records.get(stuck.id)?.owner).toBe(TEST_USER.id);
  });

  it('pages a transcript, interrupts and stops a session, and lists Claude\'s store for admins only', async () => {
    const { kit, driver, fleet } = await setup();
    const { result } = await kit.call('start_session', { folder: FOLDER, prompt: 'Hello.' });
    const items: ClaudeTranscriptItem[] = [{ type: 'user', uuid: 'u1', text: 'Hello.' }, { type: 'assistant', uuid: 'a1', text: 'Hi!' }, { type: 'assistant', uuid: 'a2', text: 'Ready.' }];
    driver.transcripts.set(result.session, items);
    const page = await kit.call('transcript', { instance: 'main', session: result.session, offset: 0, limit: 2 });
    expect(page.result).toEqual({ items: items.slice(0, 2), offset: 0, end: 2, next: 2 });
    // the newest page first: two back from the end
    const latest = await kit.call('transcript', { instance: 'main', session: result.session, offset: 0, limit: 2, fromEnd: true });
    expect(latest.result).toEqual({ items: items.slice(1), offset: 1, end: 3 });

    await kit.call('control', { instance: 'main', session: result.session, action: 'interrupt', mode: 'plan' });
    expect(driver.live(result.session)).toMatchObject({ interrupts: 1, modes: ['plan'] });
    // a mode switch alone leaves the turn running
    await kit.call('control', { instance: 'main', session: result.session, action: 'mode', mode: 'default' });
    expect(driver.live(result.session)).toMatchObject({ interrupts: 1, modes: ['plan', 'default'] });
    expect((await kit.run('control', { instance: 'main', session: result.session, action: 'mode' })).outcome.status).toBe('invalid-input');
    const stopped = await kit.call('control', { instance: 'main', session: result.session, action: 'stop' });
    expect(stopped.result.status).toBe('closed');
    expect(fleet.isLive(result.session)).toBe(false);
    // a closed session can't be interrupted, and keeps a mode switch for its next resume
    expect((await kit.run('control', { instance: 'main', session: result.session, action: 'interrupt' })).outcome.status).toBe('invalid-input');
    expect((await kit.call('control', { instance: 'main', session: result.session, action: 'mode', mode: 'plan' })).result.status).toBe('closed');
    expect(kit.records('Session')[0]?.value).toMatchObject({ permissionMode: 'plan' });

    driver.stored.push({ session: result.session, folder: FOLDER, title: 'Hello.', updatedAt: 7 });
    const listed = await kit.call('disk_sessions', { offset: 0, limit: 10 });
    expect(listed.result.items).toEqual([{ session: result.session, folder: FOLDER, title: 'Hello.', updatedAt: 7, live: false }]);
    const member = await kit.run('disk_sessions', { offset: 0, limit: 10 }, { run: kit.hub.runInfo(qualify('claude', 'disk_sessions'), { user: MEMBER }) });
    expect(member.outcome.status).toBe('failed');
  });

  it('imports a skill as context with its /command, an agent as a claude/agent fn and an MCP server as an mcp instance', async () => {
    const { kit, driver, patches } = await setup();
    driver.found = [
      { kind: 'skill', name: 'release-notes', description: 'Write release notes.', scope: 'project', folder: FOLDER },
      { kind: 'agent', name: 'code-reviewer', description: 'Reviews a change.', scope: 'user' },
      { kind: 'mcp-server', name: 'linear', description: 'Linear', scope: 'user', server: McpServerConfig.parse({ label: 'linear', transport: { type: 'http', url: 'https://mcp.linear.app/mcp' } }) },
      { kind: 'mcp-server', name: 'github', description: 'GitHub', scope: 'user', server: McpServerConfig.parse({ label: 'github', transport: { type: 'stdio', command: 'npx', args: ['--token', 'ghp_arg'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret' } } }) },
    ];
    driver.skills.set('release-notes', 'Read the merged changes and write notes.');
    const fallback = kit.hub.onCall;
    const added: unknown[] = [];
    kit.hub.onCall = (call) => {
      if (call.fn === 'hub/system_get') { return Promise.resolve({ status: 'done', result: jsonOf(mcpSystem(added.map((args) => z.object({ instance: z.string() }).parse(args).instance))) }); }
      if (call.fn !== 'hub/add_instance') { return fallback(call); }
      added.push(call.args);
      return Promise.resolve({ status: 'done', result: { system: 'mcp', instance: 'linear' } });
    };
    const items = [{ kind: 'skill', name: 'release-notes', folder: FOLDER }, { kind: 'agent', name: 'code-reviewer', folder: FOLDER }, { kind: 'mcp-server', name: 'linear', folder: FOLDER }] as const;
    const card = await kit.hub.preview({ run: mintId('run'), fn: 'import', args: jsonOf({ items }), user: TEST_USER });
    if (!('preview' in card)) throw new Error('no preview');
    // an import the hub sent with no approval imports nothing
    expect((await kit.run('import', { items: [...items] })).outcome).toMatchObject({ status: 'failed', error: { message: 'An import needs an admin to approve it first.' } });
    const imported = await kit.call('import', { items: [...items] }, { approved: { by: TEST_USER.id, preview: card.preview } });
    expect(imported.result.imported).toEqual([
      { kind: 'skill', name: 'release-notes', as: 'claude/skill_release_notes' },
      { kind: 'agent', name: 'code-reviewer', as: 'claude/agent_code_reviewer' },
      { kind: 'mcp-server', name: 'linear', as: 'mcp instance linear' },
    ]);
    expect(imported.result.refused).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ system: 'mcp', instance: 'linear', description: 'Linear', config: { label: 'linear', transport: { type: 'http', url: 'https://mcp.linear.app/mcp' } } });
    expect(patches.at(-1)?.upsert?.context?.[0]).toMatchObject({ name: 'skill_release_notes', content: 'Read the merged changes and write notes.', command: { name: 'release-notes', args: [] } });
    expect(kit.records('Skill')[0]?.value).toMatchObject({ name: 'release-notes', folder: FOLDER });
    expect(imported.hubCalls.calls.map((call) => call.fn)).toContain('hub/fns_save');

    const listed = await kit.call('importables', { folder: FOLDER });
    expect(listed.result.items.map((item) => [item.name, item.imported])).toEqual([['release-notes', true], ['code-reviewer', true], ['linear', true], ['github', false]]);
    // a list never carries a server's secrets: only how it is reached and their names
    expect(listed.result.items[3]).toMatchObject({ server: { transport: 'stdio', where: 'npx', secrets: ['GITHUB_PERSONAL_ACCESS_TOKEN'] } });
    expect(JSON.stringify(listed.result)).not.toContain('ghp_');
  });

  it('shows an MCP server import on the admin card as its command, args, folder and env names, and imports only what the card showed', async () => {
    const { kit, driver } = await setup();
    const github = (command: string) => ({
      kind: 'mcp-server' as const, name: 'github', description: 'GitHub', scope: 'project' as const, folder: FOLDER,
      server: McpServerConfig.parse({ label: 'github', transport: { type: 'stdio', command, args: ['server.js'], cwd: FOLDER, env: { GITHUB_TOKEN: 'ghp_secret' } } }),
    });
    driver.found = [github('node')];
    const items = [{ kind: 'mcp-server' as const, name: 'github', folder: FOLDER }];
    const card = await kit.hub.preview({ run: mintId('run'), fn: 'import', args: jsonOf({ items }), user: TEST_USER });
    if (!('preview' in card)) throw new Error('no preview');
    const shown = JSON.stringify(card.preview);
    expect(shown).toContain('command: node');
    expect(shown).toContain('args: [\\"server.js\\"]');
    expect(shown).toContain(`folder: ${FOLDER}`.replace(/\\/g, '\\\\'));
    expect(shown).toContain('env: GITHUB_TOKEN');
    expect(shown).not.toContain('ghp_secret');
    // the folder's .mcp.json changed after the card was approved: nothing is imported
    driver.found = [github('evil.exe')];
    expect((await kit.run('import', { items }, { approved: { by: TEST_USER.id, preview: card.preview } })).outcome).toMatchObject({ status: 'failed', error: { message: 'What Claude has changed since the import was approved: ask again.' } });
    // nor when only an env value changed, which the card never shows
    driver.found = [{ ...github('node'), server: McpServerConfig.parse({ label: 'github', transport: { type: 'stdio', command: 'node', args: ['server.js'], cwd: FOLDER, env: { GITHUB_TOKEN: 'ghp_other' } } }) }];
    expect((await kit.run('import', { items }, { approved: { by: TEST_USER.id, preview: card.preview } })).outcome).toMatchObject({ status: 'failed', error: { message: 'What Claude has changed since the import was approved: ask again.' } });
  });

  it('describes an imported agent with an example: a task in its own words', async () => {
    const { kit } = await setup();
    const props = await kit.kindProps('agent', { instance: 'main', agent: 'code-reviewer', folder: FOLDER, description: 'Review the staged changes.' });
    expect(props.description?.examples).toEqual([{ args: { prompt: 'Review the staged changes.' }, note: `A task for Claude's code-reviewer agent, in ${FOLDER}.` }]);
  });
});

/** The mcp system as hub/system_get shows it, with these instances. */
function mcpSystem(instances: readonly string[]): SystemView {
  const instance = { system: 'mcp', description: '', status: 'connected', keyFingerprint: '', version: '0.1.0', manifestHash: 'h' };
  return SystemView.parse({
    name: 'mcp', description: 'MCP servers.', status: 'connected', enabled: { functions: true, renderers: true }, keyFingerprint: '', version: '0.1.0', manifestHash: 'h',
    actor: 'act_mcp', counts: { fns: 0, context: 0, types: 0, parts: 0, instances: instances.length, pending: 0, refusals: 0 }, instanceMode: 'many', needsConfig: false, instances: instances.map((name) => ({ ...instance, instance: name })),
  });
}

describe('the Agent SDK mappings', () => {
  it('reads stored messages as transcript items, cutting long text', () => {
    const items = itemsOf({ type: 'assistant', uuid: 'm1', message: { content: [
      { type: 'thinking', thinking: 'Check the tests.' }, { type: 'text', text: 'Running them.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }, { type: 'image', source: {} },
    ] } }, 200);
    expect(items).toEqual([
      { type: 'thinking', uuid: 'm1', text: 'Check the tests.' }, { type: 'assistant', uuid: 'm1#2', text: 'Running them.' }, { type: 'tool-use', uuid: 'm1#3', id: 'tu1', tool: 'Bash', input: { command: 'npm test' } },
    ]);
    const result = itemsOf({ type: 'user', uuid: 'm2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'x'.repeat(300) }] }] } }, 200);
    expect(result[0]).toMatchObject({ type: 'tool-result', id: 'tu1', ok: false });
    expect(result[0]?.type === 'tool-result' ? result[0].text : '').toContain('(100 more characters)');
  });

  it('reads task messages as task changes', () => {
    expect(eventsOf({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'Review', task_type: 'local_workflow', workflow_name: 'review', uuid: '0b7c3c56-2f7e-4d2a-9d55-5c1f0f4e8a21', session_id: 's' })).toEqual([
      { type: 'task', change: { id: 't1', kind: 'workflow', name: 'review', description: 'Review', status: 'running' } },
    ]);
    expect(eventsOf({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' }, uuid: '0b7c3c56-2f7e-4d2a-9d55-5c1f0f4e8a21', session_id: 's' })).toEqual([
      { type: 'task', change: { id: 't1', status: 'stopped' } },
    ]);
  });

  it('makes forms of questions and elicitations and reads their answers back', () => {
    const asked = askUserQuestionForm({ questions: [
      { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false },
      { question: 'Which features?', options: [{ label: 'Auth' }, { label: 'Search' }], multiSelect: true },
    ] });
    expect(asked.form).toMatchObject({ name: 'obj', props: { q1: { docs: 'Which database?' }, q2: { docs: 'Which features?' } } });
    expect(asked.answer({ q1: 'SQLite', q2: ['Auth', 'Search'] })).toEqual({ 'Which database?': 'SQLite', 'Which features?': 'Auth, Search' });
    expect(asked.answer('SQLite')).toBeUndefined();

    const elicited = elicitationForm('github', 'Pick a repo', { type: 'object', properties: { repo: { type: 'string', title: 'Repository' }, private: { type: 'boolean' } }, required: ['repo'] });
    expect(elicited.form).toMatchObject({ name: 'obj', props: { repo: { type: { name: 'text' }, docs: 'Repository' }, private: { type: { name: 'optional' } } } });
    expect(elicited.answer({ repo: 'shop', private: true })).toEqual({ repo: 'shop', private: true });
  });

  it('maps Claude\'s MCP servers to mcp instance configs, and reads a skill file\'s body', () => {
    expect(mcpConfigOf({ name: 'files', status: 'connected', config: { type: 'stdio', command: 'npx', args: ['server-files'] } })?.transport).toEqual({ type: 'stdio', command: 'npx', args: ['server-files'] });
    expect(mcpConfigOf({ name: 'api', status: 'connected', config: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-Key': 'k' } } })?.auth).toEqual({ kind: 'headers', per: 'shared', names: ['X-Key'], values: { 'X-Key': 'k' } });
    expect(mcpConfigOf({ name: 'sdk', status: 'connected', config: { type: 'sdk', name: 'sdk' } })).toBeUndefined();
    expect(bodyOf('---\nname: notes\ndescription: x\n---\n\nWrite the notes.\n')).toBe('Write the notes.');
  });
});

describe('sessionEnv', () => {
  it("keeps what Claude Code needs and its own settings, never the harness's keys", () => {
    const parent = { Path: 'C:/bin', USERPROFILE: 'C:/Users/me', ANTHROPIC_MODEL: 'opus', OPENAI_API_KEY: 'k1', OPENROUTER_API_KEY: 'k2', HARNESS_PAIRING_TOKEN: 't', GIT_AUTHOR_NAME: 'Me' };
    expect(sessionEnv(parent, { CLAUDE_ENV_PASS: '' })).toEqual({ Path: 'C:/bin', USERPROFILE: 'C:/Users/me', ANTHROPIC_MODEL: 'opus' });
    expect(sessionEnv(parent, { CLAUDE_ENV_PASS: 'git_author_name' })).toMatchObject({ GIT_AUTHOR_NAME: 'Me' });
  });
});
