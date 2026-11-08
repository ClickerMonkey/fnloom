/**
 * Build 3's new web slices: the query standard (`querySlice`), the suggestion decision model (`suggestionsSlice`)
 * and auto-pair secrets (`autoPairSlice`). STUBS by the design lane so the spec compiles; the hub lane replaces each
 * handler (docs/plans/build-3-design.md) and may split this file per slice.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { autoPairSlice, querySlice, suggestionsSlice } from '@harness/core';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

const todo = (what: string) => (): never => { throw reject(501, 'NOT_IMPLEMENTED', `${what} is not built yet`); };

/** The build 3 plugins. Require the systems plugin, which binds `adminOnly`. */
export function build3Plugins(systems: ReturnType<typeof systemsPlugin>) {
  return [
    plugin({ name: 'web.query', spec: querySlice, requires: [systems] })
      .handlers((): FullHandlers<typeof querySlice> => ({ query: todo('query'), listValues: todo('listValues'), fns: todo('fns') })),
    plugin({ name: 'web.suggestions', spec: suggestionsSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof suggestionsSlice> => ({
        suggestDecision: todo('suggestDecision'), setSuggestDecision: todo('setSuggestDecision'), previewSuggestions: todo('previewSuggestions'),
      })),
    plugin({ name: 'web.autoPair', spec: autoPairSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof autoPairSlice> => ({ autoPairs: todo('autoPairs'), revokeAutoPair: todo('revokeAutoPair') })),
  ] as const;
}
