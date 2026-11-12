/**
 * Auto pair. At pairing an admin may let an instance re-pair by itself: the hub hands it a secret unique to
 * that instance, with an expiry (90 days by default, or never). The system keeps it in its state dir and brings it in
 * its `hello` when its key is lost or the hub forgot it; the hub checks it (stored hashed, compared in constant time,
 * rate limited, never logged), takes the new key once the system signs the challenge with it, and rotates the secret:
 * the new one comes back in `Welcome`. The previous secret stays good until the new one is first used, so a lost
 * `Welcome` cannot lock the system out. Admins list and revoke secrets.
 */
import { z } from 'zod';
import { ActorId, AutoPairId, Duration, InstanceName, SystemName, Timestamp } from './primitives.ts';

/**
 * The admin's choice at pairing: auto pair, expiring after `expiresIn` ms, never (`null`), or after the hub's default
 * (`HARNESS_AUTO_PAIR_EXPIRY`, 90 days) when absent.
 */
export const AutoPairChoice = z.object({ expiresIn: Duration.nullable().optional() });
export type AutoPairChoice = z.infer<typeof AutoPairChoice>;

/** What the hub gives the system (in `Welcome`): keep it, private, in the state dir; replace it each time. */
export const AutoPairGrant = z.object({ id: AutoPairId, secret: z.string().min(32), expiresAt: Timestamp.optional() });
export type AutoPairGrant = z.infer<typeof AutoPairGrant>;

/** What the system brings in `hello` to re-pair without a token or code. */
export const AutoPairProof = AutoPairGrant.pick({ id: true, secret: true });
export type AutoPairProof = z.infer<typeof AutoPairProof>;

/** The hub's row: the secret only as a hash. */
export const AutoPairSecret = z.object({
  id: AutoPairId,
  system: SystemName,
  instance: InstanceName,
  secretHash: z.string(),
  /** The secret before the last rotation, good until the current one is first used. */
  previousHash: z.string().optional(),
  createdBy: ActorId,
  createdAt: Timestamp,
  /** Absent: never expires. */
  expiresAt: Timestamp.optional(),
  lastUsedAt: Timestamp.optional(),
  uses: z.number().int().min(0),
  revokedAt: Timestamp.optional(),
});
export type AutoPairSecret = z.infer<typeof AutoPairSecret>;

/** A secret as the admin pages list it: no hashes. */
export const AutoPairView = AutoPairSecret.omit({ secretHash: true, previousHash: true });
export type AutoPairView = z.infer<typeof AutoPairView>;
