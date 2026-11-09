/**
 * The session list: newest activity first, paged, searchable, with archived sessions behind a switch. The search's
 * pause and "only the newest page counts" are the callers' own policy (`searchSessions` debounces, both are
 * `lastOnly`, see `chat/api.ts`); this store asks and shows what comes back.
 * Rows stay live from the one user channel (`session` and `session-deleted` events), not a subscription per row.
 * Starting, renaming, archiving and deleting go through here so the list and the hub agree.
 *
 * A chat nothing has happened in yet (no message, no setting changed) is a blank: New chat opens the blank there is
 * rather than saving another, and the list leaves blanks out unless one is open, so trying the button leaves nothing
 * behind.
 */
import { partialOf } from '../../state/loaded.ts';
import { SessionSummary, type Filter, type ListQuery, type QualifiedName, type Session, type SessionId, type UserEvent } from '@harness/core';
import { hubListQuery, readListQuery, withPage } from '../../state/query.ts';
import { computed, ref, shallowRef } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import { isSuperseded, problemText } from '../../state/problems.ts';
import type { ChatApi } from '../api.ts';

/** Sessions per page. */
export const SESSIONS_PAGE = 40;

/** What the list asks the hub for: a page of the list's query, which always says active or archived chats. */
interface SessionsQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly query: ListQuery;
}

const newestFirst = (a: SessionSummary, b: SessionSummary): number => b.updatedAt - a.updatedAt;

/** Whether nothing has happened in a chat since it was made: no message sent, no setting changed. */
export function isBlank(session: Pick<SessionSummary, 'createdAt' | 'updatedAt'>): boolean {
  return session.updatedAt === session.createdAt;
}

/** The summary a list shows of a full session. */
export function summaryOf(session: Session): SessionSummary {
  return SessionSummary.parse(session);
}

/** The list of sessions. */
export class SessionListStore {
  readonly #api: Pick<ChatApi, 'sessions' | 'searchSessions' | 'createSession' | 'updateSession' | 'deleteSession'>;
  readonly #events: UserEvents;
  #stop: (() => void) | undefined;
  #cursor: string | undefined;

  readonly items = shallowRef<readonly SessionSummary[]>([]);
  readonly search = ref('');
  readonly archived = ref(false);
  readonly loading = ref(false);
  readonly loadingMore = ref(false);
  readonly loaded = ref(false);
  readonly problem = ref('');
  readonly creating = ref(false);
  /** The hub stopped at its scan bound for this search: more chats may match. */
  readonly partial = ref(false);
  readonly #hasMore = ref(false);
  readonly hasMore = computed(() => this.#hasMore.value);

  constructor(api: Pick<ChatApi, 'sessions' | 'searchSessions' | 'createSession' | 'updateSession' | 'deleteSession'>, events: UserEvents) {
    this.#api = api;
    this.#events = events;
  }

  start(): void {
    if (this.#stop !== undefined) { return; }
    this.#stop = this.#events((event) => { this.#onEvent(event); });
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.#api.searchSessions.cancel();
  }

  /** Load the first page for the current search and archive choice. */
  load(): Promise<void> {
    this.#api.searchSessions.cancel();
    return this.#firstPage((query) => this.#api.sessions.call(query));
  }

  /** Fetch the first page with one of the list's callers; a page superseded by a newer one changes nothing. */
  async #firstPage(fetch: (query: SessionsQuery) => ReturnType<ChatApi['sessions']['call']>): Promise<void> {
    this.loading.value = true;
    this.problem.value = '';
    try {
      const page = await fetch(this.#query());
      this.items.value = page.items;
      this.#cursor = page.cursor;
      this.#hasMore.value = page.cursor !== undefined;
      this.partial.value = partialOf(page);
      this.loaded.value = true;
      this.loading.value = false;
    } catch (error) {
      if (isSuperseded(error)) { return; }
      this.problem.value = problemText(error, "Couldn't load your chats.");
      this.loading.value = false;
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.#cursor;
    if (cursor === undefined || this.loadingMore.value) { return; }
    this.loadingMore.value = true;
    try {
      const page = await this.#api.sessions.call(this.#query(cursor));
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

  /** Change the search; the list reloads once typing pauses (the search caller's debounce). */
  setSearch(text: string): void {
    this.search.value = text;
    this.#api.sessions.cancel();
    void this.#firstPage((query) => this.#api.searchSessions.call(query));
  }

  /** Show archived sessions, or the active ones. */
  async showArchived(archived: boolean): Promise<void> {
    this.archived.value = archived;
    await this.load();
  }

  /** The chats to list: blanks left out, unless it is the one open (`current`). */
  listed(current?: SessionId): readonly SessionSummary[] {
    return this.items.value.filter((s) => !isBlank(s) || s.id === current);
  }

  /**
   * Start a new chat: the blank one already there when there is one (for the default agent), else a new one, which
   * goes to the top of the list. Resolves with its id.
   */
  async create(input: { agent?: QualifiedName; title?: string } = {}): Promise<SessionId | undefined> {
    if (this.creating.value) { return undefined; }
    const blank = input.agent === undefined && input.title === undefined && !this.archived.value ? this.items.value.find(isBlank) : undefined;
    if (blank !== undefined) { return blank.id; }
    this.creating.value = true;
    try {
      const session = await this.#api.createSession.call(input);
      this.#upsert(summaryOf(session));
      return session.id;
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

  /**
   * The page asked for. `search` is the list's written query (`agent:x deploy`); when it has one the hub takes it over
   * the old narrow fields, so the archive choice goes in as a filter too (unless the query names its own).
   */
  #query(cursor?: string): SessionsQuery {
    const list = hubListQuery(readListQuery('sessions', this.search.value));
    const filters = list.filters ?? [];
    const archived: Filter = { field: 'archived', op: 'is', value: this.archived.value };
    return withPage({ query: filters.some((f) => f.field === 'archived') ? list : { ...list, filters: [...filters, archived] } }, SESSIONS_PAGE, cursor);
  }

  /** Put a changed summary in place: newest first by default; under a chosen sort it keeps its place (new ones go on top). */
  #upsert(summary: SessionSummary): void {
    const others = this.items.value.filter((s) => s.id !== summary.id);
    const belongs = summary.archived === this.archived.value && this.#matches(summary);
    if (!belongs) { this.items.value = others; return; }
    if ((readListQuery('sessions', this.search.value).sort ?? []).length === 0) { this.items.value = [summary, ...others].sort(newestFirst); return; }
    const at = this.items.value.findIndex((s) => s.id === summary.id);
    this.items.value = at < 0 ? [summary, ...others] : this.items.value.map((s) => (s.id === summary.id ? summary : s));
  }

  #matches(summary: SessionSummary): boolean {
    const search = (readListQuery('sessions', this.search.value).text ?? '').toLowerCase();
    return search === '' || summary.title.toLowerCase().includes(search);
  }

  #onEvent(event: UserEvent): void {
    if (event.type === 'session-deleted') { this.items.value = this.items.value.filter((s) => s.id !== event.session); return; }
    if (event.type !== 'session') { return; }
    const known = this.items.value.some((s) => s.id === event.session.id);
    if (known || this.loaded.value) { this.#upsert(event.session); }
  }
}
