/**
 * Whether a person may see an index hit: a fn, context item, type or resource section found by search. Every path
 * that hands search hits to a person or their agent (the hub fns, the web's search and suggestions) asks this, so a
 * hit never names what the person's scope would hide.
 */
import { QualifiedName, splitName, type SearchHit, type SessionId, type Suggestion } from '@harness/core';
import { parseSectionIndexKey } from '../index/indexer.ts';
import type { AccessScope, ContextRef } from './index.ts';
import { seesContextNamed } from './scope.ts';

/** Looks up a context item's record by name (the catalog's `context`). */
export type ContextLookup = (name: QualifiedName) => Promise<ContextRef | undefined>;

/**
 * Whether `access` sees a hit. A session-scoped memory needs `session`. Message hits are never shown: they carry no
 * session the person could be checked against.
 */
export async function seesHit(access: AccessScope, context: ContextLookup, hit: Pick<SearchHit, 'kind' | 'key'>, session?: SessionId): Promise<boolean> {
  if (hit.kind === 'section') return access.seesUri(parseSectionIndexKey(hit.key).uri);
  if (hit.kind === 'message') return false;
  const name = QualifiedName.safeParse(hit.key);
  if (!name.success) return false;
  const { system } = splitName(name.data);
  switch (hit.kind) {
    case 'fn': return access.seesFn({ name: name.data, system });
    case 'context': return seesContextNamed(access, context, name.data, session);
    case 'type': return access.seesSystem(system);
  }
}

/** The `keep` a search takes so only hits `access` sees count toward its limit. */
export function keepSeen(access: AccessScope, context: ContextLookup, session?: SessionId): (hit: SearchHit) => Promise<boolean> {
  return (hit) => seesHit(access, context, hit, session);
}

/**
 * Whether a fn or context item may be offered to a person as a suggestion: a fn they may use now (`mayUse`), a context
 * item they see (`seesContextNamed`; a session-scoped memory needs `session`).
 */
export async function mayOffer(access: AccessScope, context: ContextLookup, item: Pick<Suggestion, 'kind' | 'name'>, session?: SessionId): Promise<boolean> {
  return item.kind === 'fn' ? access.mayUse({ name: item.name, system: splitName(item.name).system }) : seesContextNamed(access, context, item.name, session);
}
