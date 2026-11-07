import { describe, expect, it } from 'vitest';
import {
  ACTIVE_RUN_STATUSES, DEFAULT_STATUS, HookBlock, MessagePart, RUN_STATUSES, RunText, RunUpdate, SETTLED_RUN_STATUSES, StatusTemplates,
  countedText, fnLabel, humanize, isSettled, isUnsettled, lowerFirst, phaseOf, resolveStatus, upperFirst,
  type ActiveRunStatus, type Json, type RunStatus, type SettledRunStatus,
} from './index.ts';

/** Compile-time: the two groups are disjoint and together are every status. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const covers: Exact<ActiveRunStatus | SettledRunStatus, RunStatus> = true;
const disjoint: Exact<Extract<ActiveRunStatus, SettledRunStatus>, never> = true;

describe('run status groups', () => {
  it('splits every status into active or settled, once', () => {
    expect([covers, disjoint]).toEqual([true, true]);
    expect([...ACTIVE_RUN_STATUSES, ...SETTLED_RUN_STATUSES].sort()).toEqual([...RUN_STATUSES].sort());
    expect(SETTLED_RUN_STATUSES).toEqual(['done', 'failed', 'cancelled', 'undone']);
    expect(ACTIVE_RUN_STATUSES).toEqual(['awaiting-approval', 'queued', 'running', 'waiting', 'paused']);
  });

  it('narrows with its guards', () => {
    const status: RunStatus = 'done';
    if (isSettled(status)) {
      const settled: SettledRunStatus = status;
      expect(settled).toBe('done');
    }
    expect(isUnsettled('paused')).toBe(true);
    expect(isSettled('paused')).toBe(false);
  });
});

describe('labels', () => {
  it('names things for people', () => {
    expect(humanize('read_file')).toBe('Read file');
    expect(humanize('readFile')).toBe('Read file');
    expect(humanize('Entry.reveal')).toBe('Entry reveal');
    expect(humanize('')).toBe('');
    expect(fnLabel('fs/read_file')).toBe('Read file');
    expect(lowerFirst('Read file')).toBe('read file');
    expect(lowerFirst('URL fetch')).toBe('URL fetch');
    expect(upperFirst('read')).toBe('Read');
  });
});

describe('status words', () => {
  const read = StatusTemplates.parse({
    active: { one: 'Reading {args.path}…', many: 'Reading {n} files…' },
    retry: { one: 'Retrying {args.path}…', many: 'Retrying {n} reads…' },
    done: { one: 'Read {args.path} ({output.lines} lines)', many: 'Read {n} files' },
    failed: { one: 'Reading {args.path|a file} failed', many: '{n} reads failed' },
  });

  it('works out the phase from the status and attempt', () => {
    expect(phaseOf('queued', 1)).toBe('active');
    expect(phaseOf('running', 2)).toBe('retry');
    expect(phaseOf('waiting', 1)).toBe('active');
    expect(phaseOf('done', 3)).toBe('done');
    expect(phaseOf('failed', 1)).toBe('failed');
    expect(phaseOf('awaiting-approval', 1)).toBeUndefined();
    expect(phaseOf('undone', 1)).toBeUndefined();
  });

  it('fills a fn\'s templates from its args and result', () => {
    const values = { fn: 'fs/read' as const, args: { path: 'docs/harness.md' } };
    expect(resolveStatus([read], 'active', values)).toEqual({ phase: 'active', one: 'Reading docs/harness.md…', many: 'Reading {n} files…' });
    expect(resolveStatus([read], 'done', { ...values, output: { lines: 42 } }).one).toBe('Read docs/harness.md (42 lines)');
    expect(resolveStatus([read], 'failed', { fn: 'fs/read', args: {} }).one).toBe('Reading a file failed');
  });

  it('skips a template with a token that has no value, falling back to the next source and then the defaults', () => {
    const values = { fn: 'fs/read_file' as const, args: {} };
    expect(resolveStatus([read], 'active', values).one).toBe('Read file…');
    expect(resolveStatus([undefined, read], 'retry', { ...values, args: { path: 'a.md' } }).one).toBe('Retrying a.md…');
    expect(resolveStatus([], 'retry', values)).toEqual({ phase: 'retry', one: 'Retrying read file…', many: 'Retrying read file ×{n}…' });
    expect(resolveStatus([], 'done', values).one).toBe('Read file done');
    // the result is only there once the run is done
    expect(resolveStatus([read], 'done', values).one).toBe('Read file done');
  });

  it('says values briefly: objects by title, name or id, lists as English, long text clipped', () => {
    const t = StatusTemplates.parse({ ...DEFAULT_STATUS, active: { one: 'Loading {args.items}…', many: '{n}' } });
    const say = (items: Json): string => resolveStatus([t], 'active', { fn: 'hub/load', args: { items } }).one;
    expect(say([{ title: 'Web search' }, { name: 'Send email' }])).toBe('Loading Web search and Send email…');
    expect(say(['a', 'b', 'c', 'd', 'e'])).toBe('Loading a, b, c and 2 more…');
    expect(say('x'.repeat(100))).toBe(`Loading ${'x'.repeat(59)}…`);
    expect(say({ id: 'run_1' })).toBe('Loading run_1…');
    expect(say({})).toBe('Load…');
  });

  it('counts a group with the many form', () => {
    const text = resolveStatus([read], 'active', { fn: 'fs/read', args: { path: 'a.md' } });
    expect(countedText(text, 1)).toBe('Reading a.md…');
    expect(countedText(text, 3)).toBe('Reading 3 files…');
  });

  it('carries the words on the wire', () => {
    const text = RunText.parse({ phase: 'done', one: 'Read a.md', many: 'Read {n} files' });
    expect(RunUpdate.parse({ type: 'status', status: 'done', text })).toEqual({ type: 'status', status: 'done', text });
  });
});

describe('message parts', () => {
  it('keeps reasoning and scored suggestions', () => {
    expect(MessagePart.parse({ type: 'reasoning', text: 'Because.' })).toEqual({ type: 'reasoning', text: 'Because.' });
    const block = HookBlock.parse({ type: 'suggest-fns', items: [{ fn: 'fs/glob', why: 'finds files', score: 0.82 }] });
    expect(block).toEqual({ type: 'suggest-fns', items: [{ fn: 'fs/glob', why: 'finds files', score: 0.82 }] });
  });
});
