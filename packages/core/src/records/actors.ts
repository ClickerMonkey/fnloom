/** Actors (users, groups, agents, systems), sign-in, settings, policies and approvals. */
import { z } from 'zod';
import {
  ActorId, ActorKind, ApprovalId, AuthSessionId, Json, PolicyId, QualifiedName, RunId, SystemName, Timestamp,
} from '../primitives.ts';

const actorBase = {
  id: ActorId,
  name: z.string(),
  /** Agents and other participants see this. */
  about: z.string(),
  createdAt: Timestamp,
  disabled: z.boolean(),
};

export const UserRole = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRole>;

export const UserActor = z.object({ ...actorBase, kind: z.literal('user'), email: z.string(), role: UserRole, timeZone: z.string().optional() });
export type UserActor = z.infer<typeof UserActor>;
/** A named set of users. A user is in zero or more groups. */
export const GroupActor = z.object({ ...actorBase, kind: z.literal('group') });
export type GroupActor = z.infer<typeof GroupActor>;
/** An agent fn acting as a participant, so its runs and messages have an author. */
export const AgentActor = z.object({ ...actorBase, kind: z.literal('agent'), fn: QualifiedName });
export type AgentActor = z.infer<typeof AgentActor>;
export const SystemActor = z.object({ ...actorBase, kind: z.literal('system'), system: SystemName });
export type SystemActor = z.infer<typeof SystemActor>;

/** Anything that acts, owns, or is granted something. */
export const Actor = z.discriminatedUnion('kind', [UserActor, GroupActor, AgentActor, SystemActor]);
export type Actor = z.infer<typeof Actor>;

/** The public view of a user, as the browser gets it. */
export const UserView = UserActor.pick({ id: true, kind: true, name: true, email: true, role: true, timeZone: true });
export type UserView = z.infer<typeof UserView>;

export const Membership = z.object({ group: ActorId, user: ActorId, addedBy: ActorId, addedAt: Timestamp });
export type Membership = z.infer<typeof Membership>;

/** How a user signs in. Hashing is the hub's (`PasswordHasher`). */
export const Credential = z.object({ user: ActorId, kind: z.enum(['password', 'passkey']), secretHash: z.string(), createdAt: Timestamp });
export type Credential = z.infer<typeof Credential>;

/** A signed-in browser: makes refresh and revocation of access tokens possible. */
export const AuthSession = z.object({
  id: AuthSessionId,
  user: ActorId,
  /** Bumped to revoke every token of this session. */
  version: z.number().int().min(1),
  refreshHash: z.string(),
  device: z.string(),
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  /** An admin acting as another user; actions are recorded under the admin. */
  actingAs: ActorId.optional(),
});
export type AuthSession = z.infer<typeof AuthSession>;

/** The claims of a browser access token. */
export const AccessClaims = z.object({ actor: ActorId, session: AuthSessionId, version: z.number().int().min(1) });
export type AccessClaims = z.infer<typeof AccessClaims>;

/** A value of a system's actor setting on one actor. */
export const ActorSetting = z.object({ setting: QualifiedName, actor: ActorId, value: Json, setBy: ActorId, run: RunId.optional(), updatedAt: Timestamp });
export type ActorSetting = z.infer<typeof ActorSetting>;

// ─── Permissions ──────────────────────────────────────────────────────────────

/** Which actors a policy covers. */
export const ActorMatch = z.union([
  z.object({ actor: ActorId }),
  z.object({ group: ActorId }),
  z.object({ kind: ActorKind }),
  z.object({ everyone: z.literal(true) }),
]);
export type ActorMatch = z.infer<typeof ActorMatch>;

/** Which fns a policy covers. All given fields must match. */
export const FnMatch = z.object({
  /** A name or a glob over names: `fs/*`. */
  fn: z.string().optional(),
  system: SystemName.optional(),
  kind: z.union([z.literal('native'), QualifiedName]).optional(),
  tags: z.array(z.string()).optional(),
  /** A gin predicate over the args. */
  when: Json.optional(),
});
export type FnMatch = z.infer<typeof FnMatch>;

/** Who answers an "ask". */
export const Approver = z.discriminatedUnion('by', [
  z.object({ by: z.literal('turn-user') }),
  z.object({ by: z.literal('actor'), actor: ActorId }),
  z.object({ by: z.literal('group'), group: ActorId, quorum: z.number().int().min(1).optional() }),
  /** An agent fn that answers allow or deny with a reason. */
  z.object({ by: z.literal('judge'), fn: QualifiedName }),
  /** The hub decides by itself (a rule, a quota). */
  z.object({ by: z.literal('hub') }),
]);
export type Approver = z.infer<typeof Approver>;

/** What a judge fn (`{ by: 'judge' }`) is given: the call waiting for approval. */
export const JudgeRequest = z.object({ fn: QualifiedName, args: Json, actor: ActorId });
export type JudgeRequest = z.infer<typeof JudgeRequest>;

/** What a judge fn, or the hub deciding by itself, answers about a call waiting for approval. */
export const Verdict = z.object({ approve: z.boolean(), reason: z.string() });
export type Verdict = z.infer<typeof Verdict>;

/** What a policy decides. */
export const PolicyDecision = z.discriminatedUnion('effect', [
  z.object({ effect: z.literal('allow') }),
  z.object({ effect: z.literal('deny'), reason: z.string() }),
  z.object({ effect: z.literal('ask'), approver: Approver }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

/**
 * May these actors run these fns? Deny beats ask beats allow; a more specific match beats a broader one. With no
 * match, fns tagged `read` are allowed and anything else asks the turn's user.
 */
export const Policy = z.object({
  id: PolicyId,
  description: z.string(),
  subject: ActorMatch,
  target: FnMatch,
  decision: PolicyDecision,
  priority: z.number().int(),
  expiresAt: Timestamp.optional(),
  createdBy: ActorId,
  createdAt: Timestamp,
});
export type Policy = z.infer<typeof Policy>;

/** How long an approval answer lasts. `always` turns into a policy. */
export const Remember = z.enum(['once', 'session', 'always']);
export type Remember = z.infer<typeof Remember>;

/** A run waiting for approval. */
export const Approval = z.object({
  id: ApprovalId,
  run: RunId,
  fn: QualifiedName,
  policy: PolicyId.optional(),
  approver: Approver,
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  decisions: z.array(z.object({ by: ActorId, approve: z.boolean(), remember: Remember, reason: z.string().optional(), at: Timestamp })),
  createdAt: Timestamp,
});
export type Approval = z.infer<typeof Approval>;
