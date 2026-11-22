import { ActorId, modelFnName, QualifiedName, SessionId, type LlmMessage } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { memoryLog, testStore } from '../testing.ts';
import { migratedCall, migrateFnNames, storedCallFn, type FnNameMigrationStep } from './migrate-fn-names.ts';

const q = (name: string) => QualifiedName.parse(name);
const SESSION = SessionId.parse('ses_old');
const ALICE = ActorId.parse('act_alice');
const RENAMES = new Map([['hub/load_context', q('hub/ctx_load')]]);

/** A transcript of the old spelling: a method's `--`, a renamed hub fn, a static `run` naming a fn, and a static tool. */
const OLD: LlmMessage[] = [
  { role: 'user', content: 'hi' },
  {
    role: 'assistant', content: '', toolCalls: [
      { id: 't1', name: 'fs__Entry--reveal', arguments: '{"path":"a"}' },
      { id: 't2', name: 'hub__load_context', arguments: '{"context":["fs/guide"]}' },
      { id: 't3', name: 'run', arguments: '{"fn":"database/main.expenses_create","args":{}}' },
      { id: 't4', name: 'find', arguments: '{"text":"x"}' },
      { id: 't5', name: 'database__main--expenses_create', arguments: '{}' },
    ],
  },
  { role: 'tool', toolCallId: 't1', content: 'ok' },
];

describe('the store migration of fn names', () => {
  it('reads an old call name back by the old rule and writes it by the new one, renamed', () => {
    const renamed = (name: QualifiedName) => RENAMES.get(name) ?? name;
    expect(storedCallFn('fs__Entry--reveal')).toBe('fs/Entry.reveal');
    expect(storedCallFn('fs__Entry__reveal')).toBe('fs/Entry.reveal');
    expect(storedCallFn('find')).toBeUndefined();
    expect(migratedCall({ id: 'a', name: 'hub__load_context', arguments: '{}' }, renamed).name).toBe('hub__ctx_load');
    const run = migratedCall({ id: 'b', name: 'run', arguments: '{"fn":"fs/Entry.reveal","args":{"x":1}}' }, renamed);
    expect(JSON.parse(run.arguments)).toEqual({ fn: 'fs__Entry__reveal', args: { x: 1 } });
    // a call already in the new form is the same call
    const current = { id: 'c', name: 'fs__Entry__reveal', arguments: '{}' };
    expect(migratedCall(current, renamed)).toBe(current);
  });

  it('rewrites stored transcripts and renamed fns in sessions, runs the steps added to it, and is idempotent', async () => {
    const store = await testStore();
    const { log } = memoryLog();
    await store.table('sessions').insert({
      id: SESSION, title: 'Old', owner: ALICE, agent: q('hub/chat'), participants: [], systems: 'all', tools: [q('hub/load_context'), q('fs/read')], context: [q('fs/guide')],
      suggested: [q('hub/load_context')], status: 'idle', transcript: OLD, createdAt: 0, updatedAt: 0, archived: false,
    });
    const ran: string[] = [];
    const step: FnNameMigrationStep = { name: 'extra', run: ({ renamed }) => { ran.push(renamed('hub/load_context')); return Promise.resolve(0); } };
    expect(await migrateFnNames(store, log, { renames: RENAMES, steps: [step] })).toEqual({ sessions: 1, extra: 0 });
    expect(ran).toEqual(['hub/ctx_load']);
    const session = await store.table('sessions').get(SESSION);
    expect(session?.tools).toEqual(['hub/ctx_load', 'fs/read']);
    expect(session?.suggested).toEqual(['hub/ctx_load']);
    expect(session?.context).toEqual(['fs/guide']);
    const calls = session?.transcript[1]?.toolCalls ?? [];
    expect(calls.map((call) => call.name)).toEqual(['fs__Entry__reveal', 'hub__ctx_load', 'run', 'find', 'database__main__expenses_create']);
    expect(JSON.parse(calls[2]?.arguments ?? '{}')).toEqual({ fn: modelFnName(q('database/main.expenses_create')), args: {} });
    // the rest of the transcript is as it was
    expect(session?.transcript[2]).toEqual(OLD[2]);
    // a second run finds nothing to do
    expect(await migrateFnNames(store, log, { renames: RENAMES, steps: [] })).toEqual({ sessions: 0 });
  });
});
