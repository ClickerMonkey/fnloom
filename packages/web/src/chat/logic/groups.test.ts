/**
 * Reasoning next to reasoning merges into one block (Phil, 2026-11-18: "merge only reasoning pieces that sit next to
 * each other"); reasoning a shown call, words or a card separates stays its own, in the model's exact order.
 */
import { RunId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { groupPieces, mergeReasoning, REASONING_JOIN } from './groups.ts';
import type { AnswerPiece } from './thread.ts';

const reasoning = (key: string, text: string): AnswerPiece => ({ kind: 'reasoning', key, text });
const runs = (key: string, ...ids: string[]): AnswerPiece => ({ kind: 'runs', key, runs: ids.map((id) => RunId.parse(id)) });
const text = (key: string, words: string): AnswerPiece => ({ kind: 'text', key, text: words });
/** Every call shows but those named hidden. */
const showing = (...hidden: string[]) => (piece: Extract<AnswerPiece, { kind: 'runs' }>): number => piece.runs.filter((run) => !hidden.includes(run)).length;
const shape = (pieces: readonly AnswerPiece[]): string[] => pieces.map((p) => (p.kind === 'runs' ? `runs:${p.runs.join(',')}` : `${p.kind}:${p.kind === 'reasoning' || p.kind === 'text' ? p.text : ''}`));

describe('mergeReasoning', () => {
  it('merges reasoning with nothing between into one piece, keeping the first key', () => {
    const merged = mergeReasoning([reasoning('s0', 'Look.'), reasoning('s1', 'Then read.'), text('s2', 'Done.')], showing());
    expect(shape(merged)).toEqual([`reasoning:Look.${REASONING_JOIN}Then read.`, 'text:Done.']);
    expect(merged[0]?.key).toBe('s0');
  });

  it('merges across calls that show nothing, and drops those calls (they draw nothing)', () => {
    const pieces = [reasoning('s0', 'a'), runs('s1', 'run_hidden'), runs('s2', 'run_hidden2'), reasoning('s3', 'b'), runs('s4', 'run_shown')];
    expect(shape(mergeReasoning(pieces, showing('run_hidden', 'run_hidden2')))).toEqual([`reasoning:a${REASONING_JOIN}b`, 'runs:run_shown']);
  });

  it('keeps reasoning a shown call, words or a card separates apart, in the exact order', () => {
    const attachment: AnswerPiece = { kind: 'attachment', key: 'a0', part: { type: 'attachment', attachment: 'fs/diff', data: {}, title: 'Diff' } };
    const pieces = [reasoning('s0', 'a'), runs('s1', 'run_1'), reasoning('s2', 'b'), text('s3', 'Hi'), reasoning('s4', 'c'), attachment, reasoning('s5', 'd')];
    expect(shape(mergeReasoning(pieces, showing()))).toEqual(['reasoning:a', 'runs:run_1', 'reasoning:b', 'text:Hi', 'reasoning:c', 'attachment:', 'reasoning:d']);
  });

  it('keeps calls that show nothing when no reasoning follows them, and ones not after reasoning', () => {
    const pieces = [runs('s0', 'run_h'), reasoning('s1', 'a'), runs('s2', 'run_h2')];
    expect(shape(mergeReasoning(pieces, showing('run_h', 'run_h2')))).toEqual(['runs:run_h', 'reasoning:a', 'runs:run_h2']);
    // a hidden call before words stays where it was too
    expect(shape(mergeReasoning([reasoning('s0', 'a'), runs('s1', 'run_h'), text('s2', 'x')], showing('run_h')))).toEqual(['reasoning:a', 'runs:run_h', 'text:x']);
  });

  it('streams into the last step: the merged text grows and the key stays the same', () => {
    const before = mergeReasoning([reasoning('s0', 'Look.'), runs('s1', 'run_h'), reasoning('s2', 'Th')], showing('run_h'));
    const after = mergeReasoning([reasoning('s0', 'Look.'), runs('s1', 'run_h'), reasoning('s2', 'Then')], showing('run_h'));
    expect(before.map((p) => p.key)).toEqual(['s0']);
    expect(after.map((p) => p.key)).toEqual(['s0']);
    expect(shape(after)).toEqual([`reasoning:Look.${REASONING_JOIN}Then`]);
    // a step that has only just begun adds no empty paragraph
    expect(shape(mergeReasoning([reasoning('s0', 'Look.'), reasoning('s1', '')], showing()))).toEqual(['reasoning:Look.']);
  });

  it('leaves an answer with no reasoning, or one step, as it was', () => {
    const pieces = [text('s0', 'Hi'), runs('s1', 'run_1'), reasoning('s2', 'a')];
    expect(mergeReasoning(pieces, showing())).toEqual(pieces);
    expect(mergeReasoning([], showing())).toEqual([]);
  });

  it('runs before grouping, so a group holds one block for reasoning between hidden calls', () => {
    const pieces = [runs('s0', 'run_1'), reasoning('s1', 'a'), runs('s2', 'run_h'), reasoning('s3', 'b'), runs('s4', 'run_2')];
    const shown = showing('run_h');
    const grouped = groupPieces(mergeReasoning(pieces, shown), true, shown);
    expect(grouped).toHaveLength(1);
    const group = grouped[0];
    expect(group?.kind === 'group' && shape(group.steps)).toEqual(['runs:run_1', `reasoning:a${REASONING_JOIN}b`, 'runs:run_2']);
  });
});
