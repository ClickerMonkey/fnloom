/**
 * The Claude pages' logic: the fleet's URL and hub query (searched, filtered and sorted in the hub's database), how a
 * status looks, the tasks as a tree, a new session's args, and a transcript as the chat's conversation.
 */
import { Json } from '@harness/core';
import { describe, expect, it } from 'vitest';
import type { ClaudeTask, ClaudeTranscriptItem } from '../shared/session.ts';
import { sessionRecord as record, sessionValue, T0 } from './fakes.ts';
import { choicesOf, fleetQuery, fleetUrl, folderName, sessionsOf, startArgs, startDraft, statusLook, taskTree, tasksLine, transcriptEntries } from './logic.ts';

function task(overrides: Partial<ClaudeTask> & Pick<ClaudeTask, 'id'>): ClaudeTask {
  return { kind: 'agent', description: 'A task', status: 'done', startedAt: T0, updatedAt: T0, ...overrides };
}

describe('the fleet', () => {
  it('reads its URL, leaving out what does not fit', () => {
    expect(fleetUrl({ q: 'checkout', status: 'waiting', machine: 'laptop', new: '1', other: 'x' })).toEqual({ q: 'checkout', status: 'waiting', machine: 'laptop', new: '1' });
    expect(fleetUrl({ status: 'sleeping', new: 'yes', folder: '' })).toEqual({});
  });

  it('filters by machine, folder and status, searches the words and sorts newest first, all in the hub', () => {
    expect(fleetQuery({ q: ' checkout ', machine: 'main', folder: 'C:/code/shop', status: 'waiting' }, 'c2')).toEqual({
      type: 'claude/Session', search: 'checkout',
      query: {
        limit: 30, cursor: 'c2', sort: [{ field: 'updatedAt', dir: 'desc' }],
        filters: [{ field: 'instance', op: 'is', value: 'main' }, { field: 'folder', op: 'is', value: 'C:/code/shop' }, { field: 'status', op: 'is', value: 'waiting' }],
      },
    });
    expect(fleetQuery({})).toEqual({ type: 'claude/Session', query: { limit: 30, sort: [{ field: 'updatedAt', dir: 'desc' }] } });
  });

  it('keeps only records that are sessions, and offers their machines and folders', () => {
    const found = sessionsOf([record(Json.parse(sessionValue())), record({ title: 'not a session' }, 'rec_01JABCDEFGHJKMNPQRSTVWXYZ1')]);
    expect(found.map((s) => s.value.title)).toEqual(['Fix checkout']);
    expect(choicesOf(found, 'instance', 'laptop')).toEqual(['laptop', 'main']);
    expect(folderName('C:\\code\\shop\\')).toBe('shop');
  });

  it('says how many things wait on the person before its status', () => {
    expect(statusLook(sessionValue({ waiting: [] }))).toEqual({ tone: 'warn', word: 'Waiting for you', live: false });
    expect(statusLook(sessionValue({ status: 'working', waiting: [] }))).toMatchObject({ word: 'Working', live: true });
    expect(statusLook(sessionValue({ status: 'working' })).word).toBe('1 waiting for you');
  });

  it('nests tasks under the one that started them, running first', () => {
    const tasks = [
      task({ id: 'w', kind: 'workflow', name: 'release', status: 'done', startedAt: T0 + 3 }),
      task({ id: 'a', parent: 'w', startedAt: T0 + 1 }),
      task({ id: 'b', parent: 'w', status: 'running', startedAt: T0 }),
      task({ id: 's', kind: 'shell', status: 'running', parent: 'gone' }),
    ];
    const tree = taskTree(tasks);
    expect(tree.map((n) => n.task.id)).toEqual(['s', 'w']);
    expect(tree[1]?.children.map((n) => n.task.id)).toEqual(['b', 'a']);
    expect(tasksLine(tasks)).toBe('2 tasks running');
    expect(tasksLine([task({ id: 'x' })])).toBe('1 task');
  });

  it('checks a new session and says what is missing', () => {
    expect(startArgs({ ...startDraft(), prompt: '  ' })).toEqual({ ok: false, problems: { folder: 'Pick the folder it works in.', prompt: 'Say what Claude should do.' } });
    expect(startArgs({ machine: '', folder: 'C:/code/shop', prompt: 'Fix it', title: '', mode: 'plan' })).toEqual({ ok: true, args: { folder: 'C:/code/shop', prompt: 'Fix it', permissionMode: 'plan', wait: false } });
    expect(startArgs({ ...startDraft('C:/code/shop', 'laptop'), prompt: 'Fix it', mode: 'nonsense' })).toEqual({ ok: true, args: { folder: 'C:/code/shop', prompt: 'Fix it', wait: false }, on: 'laptop' });
  });
});

describe('a transcript as the chat’s conversation', () => {
  const items: ClaudeTranscriptItem[] = [
    { type: 'user', uuid: 'u1', text: 'Fix the test' },
    { type: 'thinking', uuid: 't1', text: 'Run it first.' },
    { type: 'thinking', uuid: 't0', text: '  ' },
    { type: 'tool-use', uuid: 'a1', id: 'tu1', tool: 'Bash', input: { command: 'npm test' } },
    { type: 'tool-result', uuid: 'r1', id: 'tu1', ok: false, text: '1 failed' },
    { type: 'tool-use', uuid: 'a3', id: 'tu3', tool: 'Read', input: { file_path: 'src/cart.ts' } },
    { type: 'tool-result', uuid: 'r3', id: 'tu3', ok: true, text: 'export const total' },
    { type: 'assistant', uuid: 'a2', text: 'Fixed.' },
    { type: 'tool-result', uuid: 'r2', id: 'tu9', ok: true, text: 'orphan' },
    { type: 'user', uuid: 'u2', text: 'Thanks. Add a test.' },
    { type: 'tool-use', uuid: 'a4', id: 'tu4', tool: 'Write', input: { file_path: 'cart.test.ts' } },
  ];

  it('makes each message the person wrote an entry, and what Claude did until the next one an answer in order', () => {
    expect(transcriptEntries(items, true)).toEqual([
      { kind: 'user', key: 'u1', text: 'Fix the test' },
      {
        kind: 'answer', key: 't1', pieces: [
          { kind: 'reasoning', text: 'Run it first.' },
          { kind: 'call', call: { key: 'a1', name: 'Bash', args: { command: 'npm test' }, status: 'failed', output: '1 failed' } },
          { kind: 'call', call: { key: 'a3', name: 'Read', args: { file_path: 'src/cart.ts' }, status: 'done', output: 'export const total' } },
          { kind: 'text', text: 'Fixed.' },
        ],
      },
      // a result whose use is on an earlier page stands as a note
      { kind: 'note', key: 'r2', text: 'orphan' },
      { kind: 'user', key: 'u2', text: 'Thanks. Add a test.' },
      // still at work: a use with no result yet runs
      { kind: 'answer', key: 'a4', pieces: [{ kind: 'call', call: { key: 'a4', name: 'Write', args: { file_path: 'cart.test.ts' }, status: 'running' } }] },
    ]);
  });

  it('says a use never finished once the session is no longer at work', () => {
    const last = transcriptEntries(items, false).at(-1);
    expect(last).toEqual({ kind: 'answer', key: 'a4', pieces: [{ kind: 'call', call: { key: 'a4', name: 'Write', args: { file_path: 'cart.test.ts' }, status: 'failed', output: 'It never finished.' } }] });
  });
});
