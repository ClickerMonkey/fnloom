/**
 * Test doubles for a fn's view: callers that answer with a fn found by search, its facts and its examples, paged.
 */
import { QualifiedName, SystemName, type FnExampleView, type FnFacts, type FnSearchHit } from '@harness/core';
import { fakeCaller } from '../../test/fakes.ts';

/** The fn the fakes answer about. */
export const SAMPLE_FN = QualifiedName.parse('fs/bash');

/** Its search hit. */
export const SAMPLE_HIT: FnSearchHit = {
  item: 'fn', name: SAMPLE_FN, system: SystemName.parse('fs'), description: 'Run a shell command in a root.', kind: 'native', mode: 'delete',
  signature: 'bash(command: text, timeout?: num) → { output: text, code: num }', available: true,
};

/** Its facts: it spends nothing and usually takes a few seconds. */
export const SAMPLE_FACTS: FnFacts = {
  fn: SAMPLE_FN, kind: 'native', mode: 'delete', reads: ['fs/Entry'], writes: ['fs/Entry'], uses: [SAMPLE_FN], free: true,
  cost: { min: 0, typical: 0, max: 0, basis: 'free', runs: 42 }, times: { runs: 42, typical: 2_400, slow: 18_000, longest: 61_000 }, longRunning: false,
};

/** Seven examples, so a page of five leaves two. */
export const SAMPLE_EXAMPLES: readonly FnExampleView[] = Array.from({ length: 7 }, (_, i) => ({
  id: `fex_${i}`, args: { command: `ls -la src/${i}` }, ...(i === 0 ? { note: 'List a folder.', result: { output: 'a.ts\nb.ts', code: 0 } } : {}),
}));

/** The fn view's callers, answering with the samples. */
export function fakeFnsApi() {
  return {
    searchFns: fakeCaller<'searchFns'>(() => Promise.resolve({ items: [SAMPLE_HIT] })),
    fnFacts: fakeCaller<'fnFacts'>(() => Promise.resolve(SAMPLE_FACTS)),
    fnExamples: fakeCaller<'fnExamples'>((query) => {
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 5;
      const items = SAMPLE_EXAMPLES.slice(offset, offset + limit);
      const next = offset + limit < SAMPLE_EXAMPLES.length ? offset + limit : undefined;
      return Promise.resolve({ fn: SAMPLE_FN, items: [...items], total: SAMPLE_EXAMPLES.length, ...(next === undefined ? {} : { next }) });
    }),
  };
}
