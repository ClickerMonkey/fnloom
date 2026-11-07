/**
 * The session list: newest activity first, paged, searchable (debounced), with archived sessions behind a switch.
 * Rows stay live from the one user channel (`session` and `session-deleted` events), not a subscription per row.
 * Starting, renaming, archiving and deleting go through here so the list and the hub agree.
 */
import { SessionSummary, type QualifiedName, type Session, type SessionId, type UserEvent } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import { problemText } from '../../state/problems.ts';
import type { ChatApi } from '../api.ts';

/** Sessions per page, and how long typing in search waits before searching (ms). */
export const SESSIONS_PAGE = 40;
export const SEARCH_DELAY = 250;

const newestFirst = (a: SessionSummary, b: SessionSummary): number => b.updatedAt - a.updatedAt;

/** The summary a list shows of a full session. */
export function summaryOf(session: Session): SessionSummary {
  return SessionSummary.parse(session);
}

/** The list of sessions. */
export class SessionListStore {
  readonly #api: Pick<ChatApi, 'sessions' | 'createSession' | 'updateSession' | 'deleteSession'>;
  readonly #events: UserEvents;
  readonly #searchDelay: number;
  #stop: (() => void) | undefined;
  #cursor: string | undefined;
  #generation = 0;
  #searchTimer: ReturnType<typeof setTimeout> | undefined;

  readonly items = shallowRef<readonly SessionSummary[]>([]);
  readonly search = ref('');
  readonly archived = ref(false);
  readonly loading = ref(false);
  readonly loadingMore = ref(false);
  readonly loaded = ref(false);
  readonly problem = ref('');
  readonly creating = ref(false);
  readonly #hasMore = ref(false);
  readonly hasMore = computed(() => this.#hasMore.value);

  constructor(api: Pick<ChatApi, 'sessions' | 'createSession' | 'updateSession' | 'deleteSession'>, events: UserEvents, searchDelay = SEARCH_DELAY) {
    this.#api = api;
    this.#events = events;
    this.#searchDelay = searchDelay;
  }

  start(): void {
    if (this.#stop !== undefined) { return; }
    this.#stop = this.#events((event) => { this.#onEvent(event); });
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
    clearTimeout(this.#searchTimer);
  }

  /** Load the first page for the current search and archive choice. */
  async load(): Promise<void> {
    const generation = ++this.#generation;
    this.loading.value = true;
    this.problem.value = '';
    try {
      const page = await this.#api.sessions.call(this.#query());
      if (generation !== this.#generation) { return; }
      this.items.value = page.items;
      this.#cursor = page.cursor;
      this.#hasMore.value = page.cursor !== undefined;
      this.loaded.value = true;
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, "Couldn't load your chats."); }
    } finally {
      if (generation === this.#generation) { this.loading.value = false; }
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.#cursor;
    if (cursor === undefined || this.loadingMore.value) { return; }
    this.loadingMore.value = true;
    try {
      const page = await this.#api.sessions.call({ ...this.#query(), cursor });
      const known = new Set(this.items.value.map((s) => s.id));
      this.items.value = [...this.items.value, ...page.items.filter((s) => !known.has(s.id))];
      this.#cursor = page.cursor;
      this.#hasMore.value = page.cursor !== undefined;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't load more chats.");
    } finally {
      this.loadingMore.value = false;
    }
  }

  /** Change the search; the list reloads once typing pauses. */
  setSearch(text: string): void {
    this.search.value = text;
    clearTimeout(this.#searchTimer);
    this.#searchTimer = setTimeout(() => { void this.load(); }, this.#searchDelay);
  }

  /** Show archived sessions, or the active ones. */
  async showArchived(archived: boolean): Promise<void> {
    this.archived.value = archived;
    await this.load();
  }

  /** Start a new session; it goes to the top of the list. */
  async create(input: { agent?: QualifiedName; title?: string } = {}): Promise<Session | undefined> {
    if (this.creating.value) { return undefined; }
    this.creating.value = true;
    try {
      const session = await this.#api.createSession.call(input);
      this.#upsert(summaryOf(session));
      return session;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't start a new chat.");
      return undefined;
    } finally {
      this.creating.value = false;
    }
  }

  /** Rename a session. Shown at once; put back if the hub refuses. */
  async rename(id: SessionId, title: string): Promise<boolean> {
    return this.#change(id, { title }, (s) => ({ ...s, title }));
  }

  /** Archive or restore a session. It leaves the list it no longer belongs in. */
  async archive(id: SessionId, archived: boolean): Promise<boolean> {
    return this.#change(id, { archived }, (s) => ({ ...s, archived }));
  }

  /** Delete a session for good. It leaves the list at once, and comes back if the hub refuses. */
  async remove(id: SessionId): Promise<boolean> {
    const before = this.items.value;
    this.items.value = before.filter((s) => s.id !== id);
    try {
      await this.#api.deleteSession.call({ session: id });
      return true;
    } catch (error) {
      this.items.value = before;
      this.problem.value = problemText(error, "Couldn't delete that chat.");
      return false;
    }
  }

  /** A session's summary, if listed. */
  find(id: SessionId): SessionSummary | undefined {
    return this.items.value.find((s) => s.id === id);
  }

  /** Put a session's summary in the list (from a session just opened or changed). */
  remember(summary: SessionSummary): void {
    this.#upsert(summary);
  }

  async #change(id: SessionId, body: { title?: string; archived?: boolean }, apply: (s: SessionSummary) => SessionSummary): Promise<boolean> {
    const before = this.items.value;
    const current = before.find((s) => s.id === id);
    if (current !== undefined) { this.#upsert(apply(current)); }
    try {
      const session = await this.#api.updateSession.call({ session: id, ...body });
      this.#upsert(summaryOf(session));
      return true;
    } catch (error) {
      this.items.value = before;
      this.problem.value = problemText(error, "Couldn't change that chat.");
      return false;
    }
  }

  #query(): { limit: number; archived: boolean; search?: string } {
    const search = this.search.value.trim();
    return { limit: SESSIONS_PAGE, archived: this.archived.value, ...(search === '' ? {} : { search }) };
  }

  #upsert(summary: SessionSummary): void {
    const others = this.items.value.filter((s) => s.id !== summary.id);
    const belongs = summary.archived === this.archived.value && this.#matches(summary);
    this.items.value = belongs ? [summary, ...others].sort(newestFirst) : others;
  }

  #matches(summary: SessionSummary): boolean {
    const search = this.search.value.trim().toLowerCase();
    return search === '' || summary.title.toLowerCase().includes(search);
  }

  #onEvent(event: UserEvent): void {
    if (event.type === 'session-deleted') { this.items.value = this.items.value.filter((s) => s.id !== event.session); return; }
    if (event.type !== 'session') { return; }
    const known = this.items.value.some((s) => s.id === event.session.id);
    if (known || this.loaded.value) { this.#upsert(event.session); }
  }
}
