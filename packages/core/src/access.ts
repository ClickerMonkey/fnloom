/**
 * Visibility (build 4). Every system, fn, context item, resource root and person's connection has an owner and a
 * visibility: `private` (only its owner), `shared` (its owner plus the people and groups in `with`), `public`
 * (everyone). The hub enforces it on every read, list, query, suggestion and fn call. A thing with no stored row is
 * `public` and owned by whoever added it, so build 3 data keeps working. A hub with one person shows none of this.
 */
import { z } from 'zod';
import { ActorId, ConnectionId, LocalName, QualifiedName, RunId, SystemName, Timestamp } from './primitives.ts';

/** Who may see and use a thing. */
export const VISIBILITIES = ['private', 'shared', 'public'] as const;
export const Visibility = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof Visibility>;

/** What each visibility reads as in a picker. */
export const VISIBILITY_LABELS = {
  private: 'Only me', shared: 'Me and chosen people', public: 'Everyone',
} as const satisfies Record<Visibility, string>;

/** A thing's owner and visibility. `with` (people or groups) counts only when `shared`. */
export const Sharing = z.object({ owner: ActorId, visibility: Visibility, with: z.array(ActorId) });
export type Sharing = z.infer<typeof Sharing>;

/** The kinds of thing that carry a visibility. */
export const ACCESS_TARGET_KINDS = ['system', 'fn', 'context', 'root', 'connection'] as const;
export const AccessTargetKind = z.enum(ACCESS_TARGET_KINDS);
export type AccessTargetKind = z.infer<typeof AccessTargetKind>;

/** The thing a visibility is about. `root` is a resource root's URI (`hub://web/crawls/...`, `fs://repo`). */
export const AccessTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system'), system: SystemName }),
  z.object({ kind: z.literal('fn'), fn: QualifiedName }),
  z.object({ kind: z.literal('context'), context: QualifiedName }),
  z.object({ kind: z.literal('root'), uri: z.string().min(1) }),
  z.object({ kind: z.literal('connection'), connection: ConnectionId }),
]);
export type AccessTarget = z.infer<typeof AccessTarget>;

/** The stored key of a target (`fn:web/crawl`), the `access` table's key. */
export function accessKey(target: AccessTarget): string {
  switch (target.kind) {
    case 'system': return `system:${target.system}`;
    case 'fn': return `fn:${target.fn}`;
    case 'context': return `context:${target.context}`;
    case 'root': return `root:${target.uri}`;
    case 'connection': return `connection:${target.connection}`;
  }
}

/** The hub's row for a thing whose visibility someone set. */
export const AccessRecord = z.object({
  key: z.string(),
  target: AccessTarget,
  sharing: Sharing,
  setBy: ActorId,
  updatedAt: Timestamp,
});
export type AccessRecord = z.infer<typeof AccessRecord>;

/** A target's visibility as the web shows it, with whether the asker may change it (its owner or an admin). */
export const AccessView = z.object({ target: AccessTarget, sharing: Sharing, editable: z.boolean() });
export type AccessView = z.infer<typeof AccessView>;

/** Whether the hub has more than one person; the web shows visibility controls only when it does. */
export const AccessInfo = z.object({ multiUser: z.boolean() });
export type AccessInfo = z.infer<typeof AccessInfo>;

/** A visibility without its owner, for things whose owner is kept elsewhere (a connection's `owner`). */
export const ShareRule = Sharing.omit({ owner: true });
export type ShareRule = z.infer<typeof ShareRule>;

/**
 * System → hub (`shareFn`): a running fn hands a fn of its own system to its run's person, with who else may use it
 * (a form someone saved as a fn). The person then owns it and can change who sees it like anything else of theirs.
 */
export const FnShare = z.object({ run: RunId, fn: LocalName, share: ShareRule });
export type FnShare = z.infer<typeof FnShare>;
