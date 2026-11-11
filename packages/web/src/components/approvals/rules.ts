/** What the approval cards decide from an approval record alone. */
import type { Approval } from '@harness/core';

/**
 * Whether an answer may be remembered beyond this run. A proposed run is one of a kind, and a run with a preview is a
 * write or a schema change (`FnApproval.remember: false` in this build), whose answers the hub keeps for that run only.
 */
export function isRememberable(approval: Pick<Approval, 'preview' | 'proposed'>): boolean {
  return approval.proposed !== true && approval.preview === undefined;
}

/**
 * The waiting runs a bulk "Approve all" may answer: the ones without a preview. A run with one (a write, a schema
 * change, anything that can't be undone) is approved only from its own card, after the person has seen what it does.
 */
export function approvableTogether<T extends { readonly preview?: unknown }>(items: readonly T[]): T[] {
  return items.filter((item) => item.preview === undefined);
}
