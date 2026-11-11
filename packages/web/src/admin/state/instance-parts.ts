/**
 * What a fleet instance owns, for its admin page (a database's tables and saved queries): the fns routed to it, the
 * types that belong to it, and the runs its system proposed for an admin to approve (a rescan's changes that would
 * break saved queries or drop a type), each with its preview, answered from the page.
 *
 * The types are the hub's `types` list for the system and instance (every table, whether a saved query uses it or
 * not), a page at a time.
 */
import { TypeRecord, type Approval, type FnRecord, type Run } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import { ApprovalDesk } from '../../chat/state/approvals.ts';
import type { ChatApi } from '../../chat/api.ts';
import { Loaded, Paged } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import { changedTypes, instanceFns, proposedOnly, typesQuery, waitingRunsOf } from '../logic/instances.ts';
import type { InstanceKey } from './instance.ts';

type PartsApi = Pick<AdminApi, 'systemFns' | 'runs' | 'query'>;
type PartsChat = Pick<ChatApi, 'approvals' | 'approve'>;

/** The most waiting runs of a system read at once. */
export const WAITING_RUNS = 100;

/** How many of an instance's types are read per page. */
export const TYPES_PAGE = 100;

/** An instance's fns, types and proposed changes. */
export class InstancePartsStore {
  readonly #api: PartsApi;
  readonly #key = shallowRef<InstanceKey | undefined>(undefined);
  readonly fns = new Loaded<readonly FnRecord[]>();
  /** The instance's types, by name, a page at a time. */
  readonly types: Paged<TypeRecord, InstanceKey | undefined>;
  /** How many types the instance has, as the hub counted them. */
  readonly typeCount = ref<number | undefined>(undefined);
  readonly waitingRuns = new Loaded<readonly Run[]>();
  readonly desk: ApprovalDesk;
  /** The changes its system proposed that wait for an admin, oldest first. */
  readonly proposals = computed<readonly Approval[]>(() => proposedOnly((this.waitingRuns.value.value ?? []).flatMap((run) => {
    const found = this.desk.byRun.value.get(run.id);
    return found === undefined ? [] : [found];
  })));
  /** The types a waiting change would alter. */
  readonly changing = computed(() => { const key = this.#key.value; return key === undefined ? new Set<string>() : changedTypes(key.system, this.proposals.value); });

  constructor(api: PartsApi, chat: PartsChat) {
    this.#api = api;
    this.desk = new ApprovalDesk(chat);
    this.types = new Paged<TypeRecord, InstanceKey | undefined>({
      fetch: async (key, cursor, limit) => {
        if (key === undefined) { return { items: [] }; }
        const page = await this.#api.query.call(typesQuery(key, cursor, limit));
        if (cursor === undefined) { this.typeCount.value = page.total; }
        return { items: TypeRecord.array().parse(page.items), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
      },
      key: (type) => type.name,
      failure: "Couldn't load this instance's types.",
      limit: TYPES_PAGE,
    }, undefined);
  }

  /** Read everything for an instance (again, quietly, when it is the one already open). */
  async open(key: InstanceKey): Promise<void> {
    const open = this.#key.value;
    const same = open?.system === key.system && open.instance === key.instance;
    if (!same) { this.close(); }
    this.#key.value = key;
    await Promise.all([
      this.fns.load(async () => instanceFns(await this.#api.systemFns.call({ system: key.system }), key.instance), "Couldn't load this instance's fns.", same),
      this.waitingRuns.load(async () => {
        const page = await this.#api.runs.call({
          query: { filters: [{ field: 'system', op: 'is', value: key.system }, { field: 'status', op: 'is', value: 'awaiting-approval' }], limit: WAITING_RUNS },
        });
        const runs = waitingRunsOf(page.items, key.instance);
        await this.desk.load(runs.map((run) => run.id));
        return runs;
      }, "Couldn't load the changes waiting for approval.", same),
      this.types.load(key),
    ]);
  }

  /** Approve or decline a proposed change; on success the instance is read again (its types may have moved on). */
  async decide(approval: Approval, approve: boolean, reason: string): Promise<boolean> {
    const ok = await this.desk.decide(approval, approve, reason);
    const key = this.#key.value;
    if (ok && key !== undefined) { void this.open(key); }
    return ok;
  }

  close(): void {
    this.#key.value = undefined;
    this.fns.reset();
    void this.types.load(undefined);
    this.typeCount.value = undefined;
    this.waitingRuns.reset();
  }
}
