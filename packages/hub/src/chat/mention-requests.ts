/**
 * Mention requests (build 8, `core/mention-search.ts`): each `@` search the hub sends a system gets an id tied to the
 * person asking, their session and the system asked, kept in the hub's key/value store for
 * `HARNESS_MENTION_REQUEST_TTL`. While it is fresh the system may search the hub's resources for it
 * (`mentionResources` on the hub link), and the search runs as that person, so a system can only ever search for the
 * person it was asked about.
 */
import { reject } from '@ayepi/core';
import { z } from 'zod';
import { ActorId, mintId, SessionId, SystemName, type IdRandom, type MentionRequestId } from '@harness/core';
import type { HubKeyValue } from '../store/index.ts';

/** What a request id stands for. */
const MentionRequestRecord = z.object({ system: SystemName, actor: ActorId, session: SessionId });
export type MentionRequestRecord = z.infer<typeof MentionRequestRecord>;

/** The key a request is kept under. */
const keyOf = (id: MentionRequestId): string => `mention-request:${id}`;

/** Mints and checks mention requests. */
export interface MentionRequests {
  /** A new request for a search of `system`'s mentions by `actor` in `session`. */
  mint(record: MentionRequestRecord): Promise<MentionRequestId>;
  /** Who a system's request stands for; refused (403) when it is unknown, stale or another system's. */
  check(id: MentionRequestId, system: SystemName): Promise<MentionRequestRecord>;
}

/** Mention requests in the hub's key/value store, each expiring by itself. */
export class StoreMentionRequests implements MentionRequests {
  readonly #o: { readonly keys: () => HubKeyValue; readonly ttl: number; readonly random?: IdRandom };

  constructor(options: { readonly keys: () => HubKeyValue; readonly ttl: number; readonly random?: IdRandom }) {
    this.#o = options;
  }

  async mint(record: MentionRequestRecord): Promise<MentionRequestId> {
    const id = mintId('mentionRequest', this.#o.random);
    await this.#o.keys().set(keyOf(id), JSON.stringify(record), this.#o.ttl);
    return id;
  }

  async check(id: MentionRequestId, system: SystemName): Promise<MentionRequestRecord> {
    const kept = await this.#o.keys().get(keyOf(id));
    const record = kept === undefined ? undefined : MentionRequestRecord.safeParse(JSON.parse(kept)).data;
    if (record === undefined) { throw reject(403, 'MENTION_REQUEST_UNKNOWN', `${id} is not a mention search the hub sent, or it has expired`); }
    if (record.system !== system) { throw reject(403, 'MENTION_REQUEST_NOT_YOURS', `${id} was sent to another system`); }
    return record;
  }
}
