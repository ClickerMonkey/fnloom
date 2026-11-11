/**
 * Build 3's web slices: the query standard (`querySlice`: any list by `ListQuery`, a field's values for the search
 * box, and the global fns catalogue), the suggestion decision model (`suggestionsSlice`) and auto-pair secrets
 * (`autoPairSlice`, answered by the link module's auto-pair service).
 */
import { plugin } from '@ayepi/plugin';
import { autoPairSlice, querySlice, suggestionsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { HubReads } from '../reads.ts';
import type { AdminOperations } from '../admin-ops.ts';
import { adminReadOperations } from '../person-ops.ts';
import { visibleSession, type FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The build 3 plugins. Require the systems plugin, which binds `adminOnly`. */
export function build3Plugins(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, reads: HubReads, ops: AdminOperations) {
  const adminReads = adminReadOperations(hub);
  const { suggestions } = hub.chat;
  return [
    plugin({ name: 'web.query', spec: querySlice, requires: [systems] })
      .handlers((): FullHandlers<typeof querySlice> => ({
        query: ({ data, user }) => reads.lists.query(data, user),
        listValues: ({ data, user }) => reads.lists.values(data, user),
        fns: ({ data, user }) => reads.lists.page('fns', data, user),
      })),
    plugin({ name: 'web.suggestions', spec: suggestionsSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof suggestionsSlice> => ({
        suggestDecision: ({ data, user }) => adminReads.suggest_decision_get(data, user),
        setSuggestDecision: ({ data, user }) => ops.suggest_decision_set(data, user.id),
        previewSuggestions: async ({ data, user }) => {
          await visibleSession(hub, data.session, user);
          const decided = await suggestions.decide({ session: data.session, text: data.text, actor: user.id });
          return decided.record ?? { by: 'score', items: [] };
        },
      })),
    plugin({ name: 'web.autoPair', spec: autoPairSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof autoPairSlice> => ({
        autoPairs: ({ data, user }) => adminReads.auto_pairs_list(data, user),
        revokeAutoPair: ({ data, user }) => ops.auto_pair_revoke(data, user.id),
      })),
  ] as const;
}
