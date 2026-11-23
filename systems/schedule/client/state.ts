/**
 * The schedule pages' state, over what the page host gives: the hub client (the person's schedule fns found with
 * `searchFns` and read with `hub/fns_get` as quiet reads, their `schedule/Firing` records, and for admins every
 * schedule fn in the hub's fns list) and the page's runs in a harness chat (`host.runs`), so a change, pause, skip or
 * remove made on a page is the person's own run, with the same approvals and undo as in a chat.
 *
 * - `MySchedules`: the person's schedules with their payloads, read again quietly while a page is open.
 * - `RangeFirings`: the firing records in a calendar range, under its filters.
 * - `ScheduleStore`: one schedule, the fn it runs (its args type), its history a page at a time, and its actions.
 * - `AllSchedules`: every schedule on the hub (admins), searched and paged by the hub, with each owner's name.
 */
import type { Actor, Approval, FnRecord, Json, QualifiedName, Remember } from '@harness/core';
import type { HubClient, PageRuns, PageRunsOptions, RunOutcome } from '@harness/sdk';
import { computed, ref, shallowRef } from 'vue';
import { ScheduleView, SchedulePayload, type FiringStatus } from '../shared/index.ts';
import {
  FIRING_TYPE, firingsOf, historyQuery, rangeQuery, SCHEDULE_FNS, SCHEDULE_KIND, scheduleOf, StoredFnView, type CalendarUrl, type FiringItem, type ScheduleItem,
} from './logic.ts';

/** What the stores read through. */
export type ScheduleHub = Pick<HubClient, 'caller'>;
/** Makes the chat a page's runs go to (`host.runs`). */
export type RunsOf = (options: PageRunsOptions) => PageRuns;

/** A problem in words: the error's message, else the fallback. */
export function problemText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}

/** How many schedules are read at once. */
const READ_TOGETHER = 6;
/** The most schedules the calendar reads (a person's limit is 50 by default). */
const MOST_SCHEDULES = 100;

/** Run `work` over `items`, a few at a time, keeping their order. */
async function eachTogether<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      const item = items[at];
      if (item !== undefined) { out[at] = await work(item); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_TOGETHER, items.length) }, lane));
  return out;
}

/** Read one fn as `hub/fns_get` gives it (a quiet read as the person); undefined when it can't be read. */
export async function readStoredFn(hub: ScheduleHub, fn: string): Promise<StoredFnView | undefined> {
  const answer = await hub.caller('readFn').call({ fn: 'hub/fns_get', args: { fn } });
  const parsed = StoredFnView.safeParse(answer);
  return parsed.success ? parsed.data : undefined;
}

/** The person's schedules. */
export class MySchedules {
  readonly #hub: ScheduleHub;
  readonly items = shallowRef<readonly ScheduleItem[]>([]);
  readonly loading = ref(false);
  readonly loaded = ref(false);
  readonly problem = ref('');
  #generation = 0;

  constructor(hub: ScheduleHub) {
    this.#hub = hub;
  }

  /** Read them (quietly when some are shown already). */
  async load(): Promise<void> {
    const generation = ++this.#generation;
    if (!this.loaded.value) { this.loading.value = true; }
    try {
      const page = await this.#hub.caller('searchFns').call({ items: ['fn'], kinds: [SCHEDULE_KIND], visibility: 'mine', available: false, order: 'name', limit: MOST_SCHEDULES });
      const read = await eachTogether(page.items.map((hit) => hit.name), (name) => readStoredFn(this.#hub, name).catch(() => undefined));
      if (generation !== this.#generation) { return; }
      this.items.value = read.flatMap((stored) => { const item = scheduleOf(stored); return item === undefined ? [] : [item]; });
      this.problem.value = '';
      this.loaded.value = true;
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, "Couldn't read your schedules."); }
    } finally {
      if (generation === this.#generation) { this.loading.value = false; }
    }
  }
}

/** The firing records of a calendar range. */
export class RangeFirings {
  readonly #records;
  readonly items = shallowRef<readonly FiringItem[]>([]);
  readonly problem = ref('');
  readonly loaded = ref(false);
  #generation = 0;
  #last: { from: number; to: number; url: Pick<CalendarUrl, 'schedule' | 'status'> } | undefined;

  constructor(hub: ScheduleHub) {
    this.#records = hub.caller('records');
  }

  /** Read the firings planned in `[from, to)` under the filters. */
  async show(from: number, to: number, url: Pick<CalendarUrl, 'schedule' | 'status'>): Promise<void> {
    this.#last = { from, to, url };
    const generation = ++this.#generation;
    try {
      const page = await this.#records.call(rangeQuery(from, to, url));
      if (generation !== this.#generation) { return; }
      this.items.value = firingsOf(page.items);
      this.problem.value = '';
      this.loaded.value = true;
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, "Couldn't read the past runs."); }
    }
  }

  /** Read the same range again. */
  async refresh(): Promise<void> {
    if (this.#last !== undefined) { await this.show(this.#last.from, this.#last.to, this.#last.url); }
  }
}

/** Where an action on a schedule is: idle, running, or waiting for the person's approval. */
export type ActPhase = 'idle' | 'running' | 'approval';

/** One schedule, as its page shows it. */
export class ScheduleStore {
  readonly #hub: ScheduleHub;
  readonly #records;
  readonly #runsOf: RunsOf;
  readonly name: QualifiedName;
  readonly item = shallowRef<ScheduleItem | undefined>(undefined);
  /** The fn it runs, as the hub gives it (its args type for the args editor). */
  readonly target = shallowRef<StoredFnView | undefined>(undefined);
  readonly loading = ref(true);
  readonly missing = ref(false);
  readonly problem = ref('');
  readonly history = shallowRef<readonly FiringItem[]>([]);
  readonly historyLoading = ref(false);
  readonly historyProblem = ref('');
  readonly historyLoaded = ref(false);
  readonly hasMore = ref(false);
  #cursor: string | undefined;
  #historyGeneration = 0;
  /** The firing a link opened (`?firing=`), read by its key. */
  readonly opened = shallowRef<FiringItem | undefined>(undefined);
  /** The chat its actions run in, made on the first one. */
  readonly runs = shallowRef<PageRuns | undefined>(undefined);
  readonly phase = ref<ActPhase>('idle');
  readonly acting = ref('');
  readonly actProblem = ref('');
  /** The last change's answer (the schedule as the server says it now: its words, next runs, the next run's args). */
  readonly view = shallowRef<ScheduleView | undefined>(undefined);
  readonly busy = computed(() => this.phase.value !== 'idle');
  /** The approval an action waits on, answered on the page. */
  readonly approval = computed((): Approval | undefined => this.runs.value?.approvals[0]);

  constructor(deps: { hub: ScheduleHub; runs: RunsOf }, name: QualifiedName) {
    this.#hub = deps.hub;
    this.#records = deps.hub.caller('records');
    this.#runsOf = deps.runs;
    this.name = name;
  }

  /** Read the schedule and the fn it runs. */
  async open(): Promise<void> {
    try {
      const stored = await readStoredFn(this.#hub, this.name);
      const item = scheduleOf(stored);
      this.item.value = item;
      this.missing.value = item === undefined;
      this.problem.value = '';
      if (item !== undefined && this.target.value?.fn !== item.payload.fn) {
        this.target.value = await readStoredFn(this.#hub, item.payload.fn).catch(() => undefined);
      }
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't read the schedule.");
    } finally {
      this.loading.value = false;
    }
  }

  /** Read its history from the newest, under a status. */
  async showHistory(status?: FiringStatus): Promise<void> {
    const generation = ++this.#historyGeneration;
    this.historyLoading.value = true;
    try {
      const page = await this.#records.call(historyQuery(this.name, { status }));
      if (generation !== this.#historyGeneration) { return; }
      this.history.value = firingsOf(page.items);
      this.#cursor = page.cursor;
      this.hasMore.value = page.cursor !== undefined;
      this.historyProblem.value = '';
      this.historyLoaded.value = true;
    } catch (error) {
      if (generation === this.#historyGeneration) { this.historyProblem.value = problemText(error, "Couldn't read its runs."); }
    } finally {
      if (generation === this.#historyGeneration) { this.historyLoading.value = false; }
    }
  }

  /** The next page of its history. */
  async more(status?: FiringStatus): Promise<void> {
    if (this.#cursor === undefined || this.historyLoading.value) { return; }
    const generation = this.#historyGeneration;
    this.historyLoading.value = true;
    try {
      const page = await this.#records.call(historyQuery(this.name, { cursor: this.#cursor, status }));
      if (generation !== this.#historyGeneration) { return; }
      this.history.value = [...this.history.value, ...firingsOf(page.items)];
      this.#cursor = page.cursor;
      this.hasMore.value = page.cursor !== undefined;
    } catch (error) {
      this.historyProblem.value = problemText(error, "Couldn't read more runs.");
    } finally {
      this.historyLoading.value = false;
    }
  }

  /** Read the firing a link names. */
  async openFiring(key: string | undefined): Promise<void> {
    if (key === undefined) { this.opened.value = undefined; return; }
    if (this.opened.value?.value.key === key) { return; }
    const found = this.history.value.find((firing) => firing.value.key === key);
    if (found !== undefined) { this.opened.value = found; return; }
    try {
      const page = await this.#records.call(historyQuery(this.name, { key }));
      this.opened.value = firingsOf(page.items)[0];
    } catch {
      this.opened.value = undefined;
    }
  }

  /**
   * Run one of the schedule fns on it as the person (in the chat made for the page's runs), and read it again once it
   * settled. The outcome; a problem is also kept in `actProblem`.
   */
  async act(fn: QualifiedName, args: Readonly<Record<string, Json>>, label: string): Promise<RunOutcome> {
    if (this.runs.value === undefined) {
      this.runs.value = this.#runsOf({ title: () => `Schedule: ${this.item.value?.title ?? this.name}` });
    }
    this.actProblem.value = '';
    this.acting.value = label;
    this.phase.value = 'running';
    const outcome = await this.runs.value.run(fn, { ...args }, { waiting: () => { this.phase.value = 'approval'; } });
    this.phase.value = 'idle';
    this.acting.value = '';
    if (!outcome.ok) {
      this.actProblem.value = outcome.problem;
      return outcome;
    }
    const view = ScheduleView.safeParse(outcome.output);
    this.view.value = view.success ? view.data : undefined;
    if (fn !== SCHEDULE_FNS.remove) { await this.open(); }
    return outcome;
  }

  /** Answer the approval an action waits on. */
  async decide(approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<boolean> {
    const runs = this.runs.value;
    const approval = this.approval.value;
    if (runs === undefined || approval === undefined) { return false; }
    const ok = await runs.approve(approval, approve, remember, reason, answer);
    if (!ok) { this.actProblem.value = runs.problem || "Couldn't send your answer."; }
    return ok;
  }

  /** Stop listening to the actions' chat (the page left). */
  close(): void {
    this.runs.value?.close();
    this.runs.value = undefined;
  }
}

/** One schedule on the admins' list: its fn, owner, payload and owner's name. */
export interface AdminSchedule {
  readonly fn: QualifiedName;
  readonly owner?: string | undefined;
  readonly ownerName: string;
  readonly payload: SchedulePayload | undefined;
  readonly available: boolean;
  readonly disabled: boolean;
}

/** How many schedules the admins' list reads at a time. */
export const ALL_PAGE = 30;

/** Every schedule on the hub (admins). */
export class AllSchedules {
  readonly #fns;
  readonly #actors;
  readonly items = shallowRef<readonly AdminSchedule[]>([]);
  readonly loading = ref(false);
  readonly loadingMore = ref(false);
  readonly loaded = ref(false);
  readonly problem = ref('');
  readonly hasMore = ref(false);
  #names = new Map<string, string>();
  #cursor: string | undefined;
  #text = '';
  #generation = 0;

  constructor(hub: ScheduleHub) {
    this.#fns = hub.caller('fns');
    this.#actors = hub.caller('actors');
  }

  /** The schedules whose names match `text`, from the first page. */
  async show(text: string): Promise<void> {
    this.#text = text.trim();
    const generation = ++this.#generation;
    this.loading.value = true;
    try {
      if (this.#names.size === 0) {
        const actors = await this.#actors.call({ kind: 'user' }).catch((): Actor[] => []);
        this.#names = new Map(actors.map((actor) => [actor.id, actor.name]));
      }
      const page = await this.#fns.call(this.#query());
      if (generation !== this.#generation) { return; }
      this.items.value = page.items.map((record) => this.#row(record));
      this.#cursor = page.cursor;
      this.hasMore.value = page.cursor !== undefined;
      this.problem.value = '';
      this.loaded.value = true;
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, "Couldn't read the schedules."); }
    } finally {
      if (generation === this.#generation) { this.loading.value = false; }
    }
  }

  /** The next page. */
  async more(): Promise<void> {
    if (this.#cursor === undefined || this.loadingMore.value) { return; }
    const generation = this.#generation;
    this.loadingMore.value = true;
    try {
      const page = await this.#fns.call(this.#query(this.#cursor));
      if (generation !== this.#generation) { return; }
      this.items.value = [...this.items.value, ...page.items.map((record) => this.#row(record))];
      this.#cursor = page.cursor;
      this.hasMore.value = page.cursor !== undefined;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't read more schedules.");
    } finally {
      this.loadingMore.value = false;
    }
  }

  /** The hub's query of schedule fns, by name. */
  #query(cursor?: string) {
    return {
      limit: ALL_PAGE,
      filters: [{ field: 'kind', op: 'is' as const, value: SCHEDULE_KIND }],
      sort: [{ field: 'name', dir: 'asc' as const }],
      ...(this.#text === '' ? {} : { text: this.#text }),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }

  #row(record: FnRecord): AdminSchedule {
    const payload = SchedulePayload.safeParse(record.decl.payload);
    const owner = record.addedBy;
    return {
      fn: record.name, owner, ownerName: owner === undefined ? 'Unknown' : (this.#names.get(owner) ?? owner),
      payload: payload.success ? payload.data : undefined, available: record.available === true, disabled: record.disabled,
    };
  }
}

/** The firing records' type, for a link to them in the data browser. */
export const FIRING_RECORDS = FIRING_TYPE;
