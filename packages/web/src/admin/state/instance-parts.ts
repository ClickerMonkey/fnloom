/**
 * What a fleet instance owns, for its admin page (a database's tables and saved queries): the fns routed to it, the
 * types that belong to it, and the runs its system proposed for an admin to approve (a rescan's changes that would
 * break saved queries or drop a type), each with its preview, answered from the page.
 *
 * The hub has no list of an instance's types yet, so the types are the ones its fns depend on and its waiting changes
 * touch (`typeNamesOf`), read by name.
 */
import type { Approval, FnRecord, Run, TypeRecord } from '@harness/core';
import { computed, shallowRef } from 'vue';
import { ApprovalDesk } from '../../chat/state/approvals.ts';
import type { ChatApi } from '../../chat/api.ts';
import { Loaded } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import { changedTypes, instanceFns, instanceTypes, proposedOnly, typeNamesOf, waitingRunsOf } from '../logic/instances.ts';
import type { InstanceKey } from './instance.ts';

type PartsApi = Pick<AdminApi, 'systemFns' | 'runs'>;
type PartsChat = Pick<ChatApi, 'types' | 'approvals' | 'approve'>;

/** The most waiting runs of a system read at once. */
export const WAITING_RUNS = 100;

/** An instance's fns, types and proposed changes. */
export class InstancePartsStore {
  readonly #api: PartsApi;
  readonly #chat: PartsChat;
  readonly #key = shallowRef<InstanceKey | undefined>(undefined);
  readonly fns = new Loaded<readonly FnRecord[]>();
  readonly types = new Loaded<readonly TypeRecord[]>();
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
    this.#chat = chat;
    this.desk = new ApprovalDesk(chat);
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
    ]);
    await this.loadTypes(same);
  }

  /** Read the instance's types by the names its fns and waiting changes mention. */
  async loadTypes(quiet = false): Promise<void> {
    const key = this.#key.value;
    if (key === undefined) { return; }
    const names = typeNamesOf(key.system, this.fns.value.value ?? [], this.proposals.value);
    await this.types.load(async () => (names.length === 0 ? [] : instanceTypes((await this.#chat.types.call({ names })).types, key.instance)), "Couldn't load this instance's types.", quiet);
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
    this.types.reset();
    this.waitingRuns.reset();
  }
}
