/**
 * Live: `make_code` on a real free model (skipped without a key), through the whole forced workflow to a saved code fn,
 * which then runs as the kind runs it. Run with `npm run test:live`.
 */
import { CODE_KIND, CodeFnSpec, QualifiedName } from '@harness/core';
import { realModel, testHub } from '@harness/sdk/testing';
import { describe, expect } from 'vitest';
import { code } from '../shared/index.ts';
import { codeEnv } from './env.ts';
import { createCodeImpl } from './impl.ts';

describe('make_code, live', () => {
  realModel.it('writes, checks and saves a small calculation, which then runs', async (model) => {
    const kit = await testHub(code, createCodeImpl({ settings: codeEnv.parse() }), { config: {}, model });
    try {
      const { result } = await kit.call('make_code', { request: 'A price with tax: args amount (num) and rate (num, a percentage); returns the total as a num. 100 at 10 gives 110.' });
      expect(result.fn).toMatch(/^code\//);
      const kept = kit.hub.fns.kept.get(result.fn);
      const spec = CodeFnSpec.parse(kept?.saved.payload);
      const names = Object.keys(spec.args.props ?? {});
      const outcome = await kit.hub.run(QualifiedName.parse(result.fn), Object.fromEntries(names.map((name, index) => [name, index === 0 ? 100 : 10])), { kind: CODE_KIND, payload: kept?.saved.payload ?? null });
      expect(outcome.status).toBe('done');
    } finally {
      await kit.stop();
    }
  }, 300_000);
});
