/** What the approval cards decide from an approval record alone. */
import type { Approval } from '@harness/core';

/**
 * Whether an answer may be remembered beyond this run. A proposed run is one of a kind, and a run with a preview is a
 * write or a schema change (`FnApproval.remember: false` in this build), whose answers the hub keeps for that run only.
 */
export function isRememberable(approval: Pick<Approval, 'preview' | 'proposed'>): boolean {
  return approval.proposed !== true && approval.preview === undefined;
}
