import { describe, expect, it } from 'vitest';
import { RUN_STATUSES, RUN_STATUS_WORDS } from '@harness/core';
import { statusChip, failedOutput, percent } from './bash.ts';
import { blockStats, diffBlocks, diffLines, diffStats, patchBlocks, splitLines, type DiffLine } from './diff.ts';

/** Apply a diff's lines back: the kept and added lines make the new text, the kept and removed the old. */
function sides(lines: readonly DiffLine[]): { before: string[]; after: string[] } {
  return {
    before: lines.filter((l) => l.kind !== 'added').map((l) => l.text),
    after: lines.filter((l) => l.kind !== 'removed').map((l) => l.text),
  };
}

describe('diffLines', () => {
  it('splits lines without an empty last one and normalizes CRLF', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b']);
  });

  it('finds the shortest change and numbers both sides', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(lines).toEqual([
      { kind: 'same', text: 'a', old: 1, new: 1 },
      { kind: 'removed', text: 'b', old: 2 },
      { kind: 'added', text: 'B', new: 2 },
      { kind: 'same', text: 'c', old: 3, new: 3 },
      { kind: 'added', text: 'd', new: 4 },
    ]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it('handles new files, deleted files and no change', () => {
    expect(diffLines('', 'x\ny').map((l) => l.kind)).toEqual(['added', 'added']);
    expect(diffLines('x\ny', '').map((l) => l.kind)).toEqual(['removed', 'removed']);
    expect(diffLines('same\n', 'same\n').map((l) => l.kind)).toEqual(['same']);
    expect(diffLines('', '')).toEqual([]);
  });

  it('always reproduces both texts', () => {
    const cases = [
      ['a\nb\nc\nd\ne', 'e\nd\nc\nb\na'],
      ['x\nx\nx\ny', 'y\nx\nx'],
      ['1\n2\n3\n4\n5\n6\n7\n8', '1\n2\nthree\n4\n6\n7\n8\n9'],
    ] as const;
    for (const [before, after] of cases) {
      const { before: b, after: a } = sides(diffLines(before, after));
      expect(b).toEqual(splitLines(before));
      expect(a).toEqual(splitLines(after));
    }
  });
});

describe('diffBlocks', () => {
  it('keeps context around changes and folds long unchanged runs', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 10', 'LINE 10');
    const blocks = diffBlocks(diffLines(before, after), 2);
    expect(blocks.map((b) => [b.kind, b.lines.length])).toEqual([['fold', 7], ['lines', 6], ['fold', 8]]);
    expect(diffBlocks(diffLines('a', 'b'), 3).map((b) => b.kind)).toEqual(['lines']);
  });
});

describe('the bash card\'s logic', () => {
  it('labels each run status, exit codes and timeouts', () => {
    expect(statusChip('running', undefined, undefined)).toEqual({ label: 'Running', tone: 'busy' });
    expect(statusChip('done', 0, undefined)).toEqual({ label: 'Done', tone: 'ok' });
    expect(statusChip('done', 2, undefined)).toEqual({ label: 'Exit 2', tone: 'bad' });
    expect(statusChip('failed', undefined, { class: 'caller', message: 'x', code: 'timeout' }).label).toBe('Timed out');
    expect(statusChip('failed', undefined, { class: 'caller', message: 'x' }).label).toBe('Failed');
    expect(statusChip('queued', undefined, undefined).tone).toBe('quiet');
    expect(statusChip('awaiting-approval', undefined, undefined).label).toBe('Needs approval');
    expect(statusChip('paused', undefined, undefined).label).toBe('Paused');
    expect(statusChip('cancelled', undefined, undefined).label).toBe(RUN_STATUS_WORDS.cancelled);
    for (const status of RUN_STATUSES) { expect(statusChip(status, undefined, undefined).label).not.toBe(''); }
    expect(statusChip('undone', undefined, undefined).label).toBe('Undone');
  });

  it('keeps the output a timed-out run carries, and clamps progress', () => {
    expect(failedOutput({ class: 'caller', message: 't', data: { exitCode: 124, stdout: 'so far', stderr: '' } })).toEqual({ stdout: 'so far', stderr: '' });
    expect(failedOutput({ class: 'caller', message: 't', data: [1] })).toBeUndefined();
    expect(failedOutput(undefined)).toBeUndefined();
    expect(percent(0.456)).toBe(46);
    expect(percent(2)).toBe(100);
    expect(percent(undefined)).toBe(0);
  });
});

describe('patchBlocks', () => {
  it('numbers each hunk from its header and marks the lines a unified diff leaves out', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3,2 +3,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n@@ -10,1 +10,2 @@\n ten\n+eleven\n';
    const blocks = patchBlocks(patch);
    expect(blocks.map((b) => b.kind)).toEqual(['gap', 'lines', 'gap', 'lines']);
    expect(blocks[0]).toEqual({ kind: 'gap', count: 2 });
    expect(blocks[1]).toEqual({ kind: 'lines', lines: [
      { kind: 'same', text: 'keep', old: 3, new: 3 }, { kind: 'removed', text: 'old', old: 4 }, { kind: 'added', text: 'new', new: 4 },
    ] });
    expect(blocks[2]).toEqual({ kind: 'gap', count: 5 });
    expect(blockStats(blocks)).toEqual({ added: 2, removed: 1 });
  });

  it('reads a new file and nothing from a header-only diff', () => {
    expect(patchBlocks('--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b')).toEqual([{ kind: 'lines', lines: [{ kind: 'added', text: 'a', new: 1 }, { kind: 'added', text: 'b', new: 2 }] }]);
    expect(patchBlocks('diff --git a/x b/y\nrename from x\nrename to y\n--- a/x\n+++ b/y')).toEqual([]);
  });
});
