/**
 * One system's review (build 7), shared by its review page and its system page: what it declares, its stage, its
 * install checks, what is live and what waits, the items switched off, and the refusals the hub logged, a page at a
 * time. Switching an item shows at once and is put back if the hub refuses. Going live, and approving or declining a
 * pending review (all of it, or one change at a time), send the hash that was reviewed, so the hub refuses when the
 * contract moved since. A test call runs a fn as the admin
 * while the system is installed.
 */
import {
  QualifiedName, type ChangeRef, type GoLiveRequest, type ItemRef, type Json, type RefusalRecord, type RefusalRule, type ReviewDecided, type RunId, type SystemName, type SystemReview, type SystemStage,
} from '@harness/core';
import { computed, ref } from 'vue';
import { Loaded, Paged, Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import { changeKey, changeRef, offKeys, itemKey, withSwitch } from '../logic/review.ts';

type ReviewApi = Pick<AdminApi, 'systemReview' | 'goLive' | 'approveReview' | 'rejectReview' | 'decideReview' | 'testCall' | 'refusals' | 'switchItem' | 'switchPart'>;

/** Which refusals the list shows: one system's, of one rule or all. */
export interface RefusalFilter {
  readonly system: SystemName | undefined;
  readonly rule: RefusalRule | undefined;
}

/** How many refusals are read per page. */
export const REFUSALS_PAGE = 50;

/** One system's review. */
export class ReviewStore {
  readonly #api: ReviewApi;
  readonly review = new Loaded<SystemReview>();
  readonly refusals: Paged<RefusalRecord, RefusalFilter>;
  /** Switching one item. */
  readonly switching = new Task();
  /** Going live, approving or rejecting. */
  readonly deciding = new Task();
  /** The key (`changeKey`) of the one pending change being approved or declined now. */
  readonly decidingChange = ref<string | undefined>(undefined);
  readonly testing = new Task();
  /** The keys of the items switched off now. */
  readonly off = computed(() => offKeys(this.review.value.value?.off ?? []));

  constructor(api: ReviewApi) {
    this.#api = api;
    this.refusals = new Paged<RefusalRecord, RefusalFilter>({
      fetch: async ({ system, rule }, cursor, limit) => {
        if (system === undefined) { return { items: [] }; }
        const page = await this.#api.refusals.call({ system, limit, ...(rule === undefined ? {} : { rule }), ...(cursor === undefined ? {} : { cursor }) });
        return { items: page.items, ...(page.next === undefined ? {} : { cursor: page.next }) };
      },
      key: (refusal) => refusal.id,
      failure: "Couldn't load the refusals.",
      limit: REFUSALS_PAGE,
    }, { system: undefined, rule: undefined });
  }

  /** Read a system's review (quietly again when it is the one shown). */
  async open(system: SystemName): Promise<void> {
    const quiet = this.review.value.value?.system === system;
    if (!quiet) { this.review.reset(); }
    await this.review.load(() => this.#api.systemReview.call({ system }), "Couldn't load this system's review.", quiet);
  }

  /** Read a system's refusals, of one rule or all. */
  async loadRefusals(system: SystemName, rule?: RefusalRule): Promise<void> {
    await this.refusals.load({ system, rule });
  }

  /** Whether an item is switched on (absent from the off list). */
  isOn(item: ItemRef): boolean {
    return !this.off.value.has(itemKey(item));
  }

  /** Switch one item on or off: fns and context items by their own flag, every other part by its system and name. */
  async switch(item: ItemRef, on: boolean): Promise<boolean> {
    const review = this.review.value.value;
    if (review === undefined) { return false; }
    const before = review.off;
    this.review.set({ ...review, off: withSwitch(before, item, on) });
    const result = await this.switching.run(() => this.#send(review.system, item, on), "Couldn't switch that.");
    if (!result.ok) {
      const now = this.review.value.value;
      if (now !== undefined) { this.review.set({ ...now, off: withSwitch(now.off, item, !on) }); }
    }
    return result.ok;
  }

  async #send(system: SystemName, item: ItemRef, on: boolean): Promise<void> {
    const { section, name } = item;
    if (section === 'fns' || section === 'context') {
      await this.#api.switchItem.call({ section, name: QualifiedName.parse(name), on });
      return;
    }
    await this.#api.switchPart.call({ system, section, name, on });
  }

  /** The request that goes live with, or approves, what was reviewed: its hash and the items kept off. */
  #request(hash: string): GoLiveRequest | undefined {
    const review = this.review.value.value;
    return review === undefined ? undefined : { system: review.system, hash, off: review.off };
  }

  /** Go live with the contract reviewed. Refused (and read again) when it moved since. */
  async goLive(): Promise<Outcome<SystemStage>> {
    const review = this.review.value.value;
    const request = review === undefined ? undefined : this.#request(review.manifest.hash);
    if (review === undefined || request === undefined) { return { ok: false, problem: 'No system is open.' }; }
    const result = await this.deciding.run(() => this.#api.goLive.call(request), "Couldn't go live.");
    void this.open(review.system);
    return result.ok ? { ok: true, value: result.value.stage } : result;
  }

  /** Approve the pending changes; the changed items come on unless they are switched off. */
  async approve(): Promise<Outcome<string>> {
    const review = this.review.value.value;
    const pending = review?.pending;
    const request = pending === undefined ? undefined : this.#request(pending.hash);
    if (review === undefined || request === undefined) { return { ok: false, problem: 'Nothing waits for review.' }; }
    const result = await this.deciding.run(() => this.#api.approveReview.call(request), "Couldn't approve the changes.");
    void this.open(review.system);
    return result.ok ? { ok: true, value: result.value.hash } : result;
  }

  /**
   * Approve or decline one pending change (by the hash reviewed): approved, it goes live; declined, it stays off and
   * is recorded; the rest keep waiting. `deciding` names the change while the hub answers. Read again after.
   */
  async decide(change: ChangeRef, verdict: 'approve' | 'decline'): Promise<Outcome<ReviewDecided>> {
    const review = this.review.value.value;
    const pending = review?.pending;
    if (review === undefined || pending === undefined) { return { ok: false, problem: 'Nothing waits for review.' }; }
    this.decidingChange.value = changeKey(change);
    const ref = changeRef(change);
    const decision = { system: review.system, hash: pending.hash, approve: verdict === 'approve' ? [ref] : [], decline: verdict === 'decline' ? [ref] : [], off: [] };
    try {
      const result = await this.deciding.run(() => this.#api.decideReview.call(decision), verdict === 'approve' ? "Couldn't approve that change." : "Couldn't decline that change.");
      await this.open(review.system);
      return result;
    } finally {
      this.decidingChange.value = undefined;
    }
  }

  /** Drop the pending changes: the live version stays, and the changes stay off. */
  async reject(): Promise<Outcome<boolean>> {
    const review = this.review.value.value;
    const pending = review?.pending;
    if (review === undefined || pending === undefined) { return { ok: false, problem: 'Nothing waits for review.' }; }
    const result = await this.deciding.run(() => this.#api.rejectReview.call({ system: review.system, hash: pending.hash }), "Couldn't reject the changes.");
    void this.open(review.system);
    return result.ok ? { ok: true, value: result.value.ok } : result;
  }

  /** Run one of its fns as the admin, marked as a test; the run to follow. */
  async testCall(fn: QualifiedName, args: Json): Promise<Outcome<RunId>> {
    const result = await this.testing.run(() => this.#api.testCall.call({ fn, args }), "Couldn't run that.");
    return result.ok ? { ok: true, value: result.value.run } : result;
  }

  /** Forget the open system. */
  close(): void {
    this.review.reset();
    void this.refusals.load({ system: undefined, rule: undefined });
  }
}
