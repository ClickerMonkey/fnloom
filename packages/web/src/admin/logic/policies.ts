/**
 * How policies read: who they cover, which fns, and what they decide, as one sentence each ("Group Engineering may
 * run fs/* (tagged write) after the turn's person approves"); and the order they are weighed in.
 */
import { QualifiedName, type ActorKind, type ActorMatch, type Approver, type FnMatch, type Policy, type PolicyDecision } from '@harness/core';
import { fnLabel } from '../../chat/logic/labels.ts';
import type { Tone } from '../../ui/index.ts';
import type { NameOf } from './limits.ts';

const KIND_PLURAL = { user: 'people', group: 'groups', agent: 'agents', system: 'systems', mcp: 'MCP clients' } as const satisfies Record<ActorKind, string>;

/** Who a policy covers. */
export function subjectText(subject: ActorMatch, nameOf: NameOf): string {
  if ('actor' in subject) { return nameOf(subject.actor); }
  if ('group' in subject) { return `Group ${nameOf(subject.group)}`; }
  if ('kind' in subject) { return `All ${KIND_PLURAL[subject.kind]}`; }
  return 'Everyone';
}

/** Which fns a policy covers. */
export function targetText(target: FnMatch): string {
  const parts: string[] = [];
  if (target.fn !== undefined) {
    const name = QualifiedName.safeParse(target.fn);
    parts.push(name.success && !target.fn.includes('*') ? fnLabel(name.data) : target.fn);
  }
  if (target.system !== undefined) { parts.push(`fns of ${target.system}`); }
  if (target.kind !== undefined) { parts.push(target.kind === 'native' ? 'native fns' : `${target.kind} fns`); }
  if (target.tags !== undefined && target.tags.length > 0) { parts.push(`tagged ${target.tags.join(', ')}`); }
  if (target.when !== undefined) { parts.push('when its args match'); }
  return parts.length === 0 ? 'any fn' : parts.join(', ');
}

/** Who answers an "ask". */
export function approverText(approver: Approver, nameOf: NameOf): string {
  switch (approver.by) {
    case 'turn-user': return "the message's sender";
    case 'actor': return nameOf(approver.actor);
    case 'group': return `group ${nameOf(approver.group)}${approver.quorum === undefined ? '' : ` (${approver.quorum} needed)`}`;
    case 'judge': return `the judge ${fnLabel(approver.fn)}`;
    case 'hub': return 'the hub';
  }
}

/** What a policy decides, with its tone. */
export function decisionText(decision: PolicyDecision, nameOf: NameOf): { readonly word: string; readonly detail: string; readonly tone: Tone } {
  switch (decision.effect) {
    case 'allow': return { word: 'Allow', detail: 'runs without asking', tone: 'ok' };
    case 'deny': return { word: 'Deny', detail: decision.reason, tone: 'danger' };
    case 'ask': return { word: 'Ask', detail: `asks ${approverText(decision.approver, nameOf)}`, tone: 'warn' };
  }
}

/** The order the hub weighs policies in: higher priority first, then deny before ask before allow. */
export function sortPolicies(policies: readonly Policy[]): Policy[] {
  const weight = { deny: 0, ask: 1, allow: 2 } as const;
  return [...policies].sort((a, b) => b.priority - a.priority || weight[a.decision.effect] - weight[b.decision.effect]);
}
