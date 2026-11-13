/**
 * The fleet over a scripted Claude and a recording hub: what a session reports reaches its record (debounced), a tool
 * use and a question become proposals for the owner whose key the record names first, approval and decline settle
 * them, an interrupt withdraws them, and a session that ends tells whoever waits on its turn.
 */
import { ActorId, InstanceName, RunId, mintId, type ClaudeSession, type RecordId } from '@harness/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeClaudeDriver } from './fake-driver.ts';
import { SessionFleet, mergeTask, type FleetHub, type Proposal } from './fleet.ts';

const OWNER = ActorId.parse('act_owner');
const SESSION = '0b7c3c56-2f7e-4d2a-9d55-5c1f0f4e8a21';
const RECORD: RecordId = mintId('record');
const CHAT = mintId('session');

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function value(): ClaudeSession {
  return {
    instance: InstanceName.parse('main'), session: SESSION, folder: 'C:/code/shop', title: 'Fix the test', status: 'starting', owner: OWNER, chat: CHAT,
    permissionMode: 'default', waiting: [], asking: [], tasks: [], turns: 0, costUsd: 0, startedAt: 1, updatedAt: 1,
  };
}

/** A hub that records saves and proposals; each proposal gets a fresh run. */
function recordingHub(): FleetHub & { saves: ClaudeSession[]; proposals: Proposal[] } {
  const saves: ClaudeSession[] = [];
  const proposals: Proposal[] = [];
  return {
    saves, proposals,
    saveSession: (_id, saved) => { saves.push(saved); return Promise.resolve(); },
    propose: (proposal) => {
      proposals.push(proposal);
      return Promise.resolve(RunId.parse(mintId('run')));
    },
  };
}

function setup() {
  const driver = new FakeClaudeDriver();
  const hub = recordingHub();
  const fleet = new SessionFleet(driver, () => hub, { instance: 'main', debounce: 0, lastTextMax: 40, previewMax: 500, now: () => 5, log: silent });
  fleet.open(RECORD, value(), { session: SESSION, resume: false, folder: 'C:/code/shop', permissionMode: 'default' }, 'Fix the test', 60_000);
  return { driver, hub, fleet, live: driver.live(SESSION) };
}

describe('SessionFleet', () => {
  it('opens a session, sends its first message and mirrors what it reports', async () => {
    const { hub, fleet, live } = setup();
    expect(live.sent).toEqual(['Fix the test']);
    live.emit({ type: 'text', text: 'Looking at the checkout test now, it fails because the cart total is rounded twice.' });
    live.emit({ type: 'task', change: { id: 't1', kind: 'workflow', name: 'review', description: 'Review the change', status: 'running' } });
    live.emit({ type: 'task', change: { id: 't1', progress: '2 of 3 steps' } });
    live.emit({ type: 'result', ok: true, text: 'Fixed.', costUsd: 0.12, turns: 3 });
    await vi.waitFor(() => { expect(hub.saves.at(-1)?.status).toBe('idle'); });
    const saved = hub.saves.at(-1);
    expect(saved).toMatchObject({ turns: 3, costUsd: 0.12, lastText: 'Fixed.' });
    expect(saved?.tasks).toEqual([{ id: 't1', kind: 'workflow', name: 'review', description: 'Review the change', status: 'running', progress: '2 of 3 steps', startedAt: 5, updatedAt: 5 }]);
    expect(fleet.size).toBe(1);
  });

  it('asks the owner for a tool use under a key naming the session record, and lets Claude use it once approved', async () => {
    const { hub, fleet, live } = setup();
    const decided = live.permit({ tool: 'Bash', input: { command: 'npm test' }, canAlways: true });
    await vi.waitFor(() => { expect(hub.proposals).toHaveLength(1); });
    const [proposal] = hub.proposals;
    expect(proposal).toMatchObject({ fn: 'permit', for: OWNER, chat: CHAT, ask: { into: 'always', type: { name: 'optional', generic: { T: { name: 'bool' } } } } });
    expect(proposal?.key.startsWith(`${RECORD}:permit:`)).toBe(true);
    expect(proposal?.preview.parts).toContainEqual({ type: 'code', language: 'bash', code: 'npm test' });
    await vi.waitFor(() => { expect(fleet.value(SESSION)?.status).toBe('waiting'); });
    const request = z.object({ request: z.string() }).parse(proposal?.args);
    const run = RunId.parse(fleet.value(SESSION)?.waiting[0]);
    expect(fleet.permit('6f1d7a0e-3b8c-4c2e-9a1f-2d4b6c8e0a13', request.request, run, true)).toBe(false);
    // only the run proposed for the request settles it
    expect(fleet.permit(SESSION, request.request, mintId('run'), true)).toBe(false);
    expect(fleet.permit(SESSION, request.request, run, true)).toBe(true);
    await expect(decided).resolves.toEqual({ allow: true, always: true });
    expect(fleet.value(SESSION)).toMatchObject({ waiting: [], asking: [], status: 'working' });
    expect(fleet.permit(SESSION, request.request, run, true)).toBe(false);
  });

  it('declines a question when its run is cancelled, and withdraws what an interrupt cancels', async () => {
    const { hub, fleet, live } = setup();
    const replied = live.question({ from: 'question', title: 'Which database?', text: 'Postgres or SQLite?', form: { name: 'text' } });
    await vi.waitFor(() => { expect(fleet.value(SESSION)?.waiting).toHaveLength(1); });
    const run = fleet.value(SESSION)?.waiting[0];
    expect(hub.proposals[0]).toMatchObject({ fn: 'answer', ask: { into: 'answer', type: { name: 'text' } } });
    fleet.declined(RunId.parse(run), 'Not now.');
    await expect(replied).resolves.toEqual({ declined: 'Not now.' });

    const withdrawn = live.permit({ tool: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, canAlways: false });
    await vi.waitFor(() => { expect(hub.proposals).toHaveLength(2); });
    expect(hub.proposals[1]?.ask).toBeUndefined();
    expect(hub.proposals[1]?.preview.parts).toContainEqual({ type: 'code', language: 'diff', title: 'a.ts', code: '--- a.ts\n+++ a.ts\n@@\n-a\n+b' });
    await fleet.interrupt(SESSION);
    await expect(withdrawn).resolves.toEqual({ allow: false, reason: 'Claude withdrew the request.' });
  });

  it('follows a turn with progress lines, and tells a waiting run when the session ends', async () => {
    const { fleet, live } = setup();
    const lines: string[] = [];
    const turn = fleet.turn(SESSION, (line) => { lines.push(line); }, new AbortController().signal);
    live.emit({ type: 'tool', tool: 'Bash', line: 'Bash: npm test' });
    live.emit({ type: 'result', ok: true, text: 'All green.', costUsd: 0.01, turns: 1 });
    await expect(turn).resolves.toEqual({ ok: true, text: 'All green.', costUsd: 0.01 });
    expect(lines).toEqual(['Bash: npm test']);

    const pending = live.permit({ tool: 'Bash', input: { command: 'rm -rf dist' }, canAlways: false });
    const next = fleet.turn(SESSION, () => undefined, new AbortController().signal);
    live.emit({ type: 'ended', problem: 'the process exited' });
    await expect(next).resolves.toEqual({ ended: true, problem: 'the process exited' });
    await expect(pending).resolves.toEqual({ allow: false, reason: 'The session ended.' });
    expect(fleet.isLive(SESSION)).toBe(false);
  });

  it('stops a session and closes it after it idles', async () => {
    vi.useFakeTimers();
    try {
      const { fleet, live } = setup();
      live.emit({ type: 'result', ok: true, text: 'Done.', costUsd: 0, turns: 1 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(live.closed).toBe(true);
      expect(fleet.isLive(SESSION)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges task changes, starting a task it has not seen', () => {
    expect(mergeTask(undefined, { id: 'x', status: 'done' }, 9)).toEqual({ id: 'x', kind: 'other', description: '', status: 'done', startedAt: 9, updatedAt: 9 });
  });
});
