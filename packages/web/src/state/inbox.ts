/**
 * The notifications inbox: the list (all, or only unread), paged; the unread count for the bell; live arrivals from
 * the user's event channel (shown only while no search narrows the list); and marking read, shown at once and put back if the hub refuses.
 */
import type { ListQuery, Notification, NotificationId, NotificationListQuery, UserEvent } from '@harness/core';
import { z } from 'zod';
import { computed, ref, shallowRef } from 'vue';
import type { NotificationsApi, UserEvents } from '../api/notifications.ts';
import { problemText } from './problems.ts';

/** Which notifications the list shows. */
export const InboxFilter = z.enum(['all', 'unread']);
export type InboxFilter = z.infer<typeof InboxFilter>;

/** How many to fetch per page, and the most unread counted for the bell. */
export const INBOX_PAGE = 30;
export const UNREAD_COUNTED = 100;

/** The inbox's state. */
export class InboxStore {
  readonly #api: Pick<NotificationsApi, 'list' | 'markRead'>;
  readonly #events: UserEvents;
  #stopEvents: (() => void) | undefined;
  #cursor: string | undefined;
  /** The search the list is narrowed by (words, filters, sort), sent with every page. */
  #query: ListQuery = {};

  /** The notifications shown, newest first. */
  readonly items = shallowRef<readonly Notification[]>([]);
  readonly filter = ref<InboxFilter>('all');
  /** How many are unread (counted up to `UNREAD_COUNTED`). */
  readonly unread = ref(0);
  readonly loading = ref(false);
  readonly loadingMore = ref(false);
  /** Whether the first page has arrived. */
  readonly loaded = ref(false);
  readonly problem = ref('');
  readonly #hasMore = ref(false);
  /** Whether there are older notifications to fetch. */
  readonly hasMore = computed(() => this.#hasMore.value);

  constructor(api: Pick<NotificationsApi, 'list' | 'markRead'>, events: UserEvents) {
    this.#api = api;
    this.#events = events;
  }

  /** Listen for new notifications and count the unread. */
  start(): void {
    if (this.#stopEvents !== undefined) { return; }
    this.#stopEvents = this.#events((event) => { this.#onEvent(event); });
    void this.countUnread();
  }

  stop(): void {
    this.#stopEvents?.();
    this.#stopEvents = undefined;
  }

  /** Load the first page for a filter and search (each kept for later pages and refreshes when left out). */
  async load(filter: InboxFilter = this.filter.value, query: ListQuery = this.#query): Promise<void> {
    this.filter.value = filter;
    this.#query = query;
    this.loading.value = true;
    this.problem.value = '';
    try {
      const page = await this.#api.list.call(this.#body());
      if (this.filter.value !== filter || this.#query !== query) { return; }
      this.items.value = page.items;
      this.#cursor = page.cursor;
      this.#hasMore.value = page.cursor !== undefined;
      this.loaded.value = true;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't load notifications.");
    } finally {
      this.loading.value = false;
    }
  }

  /** Fetch the next older page. */
  async loadMore(): Promise<void> {
    const cursor = this.#cursor;
    if (cursor === undefined || this.loadingMore.value) { return; }
    this.loadingMore.value = true;
    try {
      const page = await this.#api.list.call(this.#body(cursor));
      const known = new Set(this.items.value.map((n) => n.id));
      this.items.value = [...this.items.value, ...page.items.filter((n) => !known.has(n.id))];
      this.#cursor = page.cursor;
      this.#hasMore.value = page.cursor !== undefined;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't load more notifications.");
    } finally {
      this.loadingMore.value = false;
    }
  }

  /** Count the unread, for the bell. */
  async countUnread(): Promise<void> {
    try {
      const page = await this.#api.list.call({ limit: UNREAD_COUNTED, unread: true });
      this.unread.value = page.items.length;
    } catch {
      // the bell keeps its last count; the list shows its own problem
    }
  }

  /** Mark notifications read. Shown at once; put back if the hub refuses. */
  async markRead(ids: readonly NotificationId[]): Promise<boolean> {
    if (ids.length === 0) { return true; }
    const wanted = new Set(ids);
    const changing = this.items.value.filter((n) => wanted.has(n.id) && !n.read);
    const before = this.items.value;
    const unreadBefore = this.unread.value;
    this.items.value = this.filter.value === 'unread'
      ? before.filter((n) => !wanted.has(n.id))
      : before.map((n) => (wanted.has(n.id) ? { ...n, read: true } : n));
    this.unread.value = Math.max(0, unreadBefore - changing.length);
    try {
      await this.#api.markRead.call({ ids: [...ids] });
      return true;
    } catch (error) {
      this.items.value = before;
      this.unread.value = unreadBefore;
      this.problem.value = problemText(error, "Couldn't mark as read.");
      return false;
    }
  }

  /** Mark every unread notification shown as read. */
  async markAllRead(): Promise<boolean> {
    return this.markRead(this.items.value.filter((n) => !n.read).map((n) => n.id));
  }

  /** Fetch again after a reconnect: events sent while offline are lost. */
  async refresh(): Promise<void> {
    await Promise.all([this.loaded.value ? this.load() : Promise.resolve(), this.countUnread()]);
  }

  /** A page request for the current filter and search. */
  #body(cursor?: string): NotificationListQuery {
    return { limit: INBOX_PAGE, ...(cursor === undefined ? {} : { cursor }), ...(this.filter.value === 'unread' ? { unread: true } : {}), ...(this.#searched() ? { query: this.#query } : {}) };
  }

  /** Whether a search narrows the list (then live arrivals are not added: the hub decides what matches). */
  #searched(): boolean {
    return Object.keys(this.#query).length > 0;
  }

  #onEvent(event: UserEvent): void {
    if (event.type !== 'notification') { return; }
    const notification = event.notification;
    const held = this.items.value.find((n) => n.id === notification.id);
    if (held !== undefined) { this.#replace(held, notification); return; }
    if (this.loaded.value && !this.#searched() && (this.filter.value === 'all' || !notification.read)) {
      this.items.value = [notification, ...this.items.value];
    }
    if (!notification.read) { this.unread.value++; }
  }

  /** A notification the hub changed (it resolved, or was read elsewhere): shown as it is now, the count following. */
  #replace(held: Notification, notification: Notification): void {
    const drop = this.filter.value === 'unread' && notification.read;
    this.items.value = drop ? this.items.value.filter((n) => n.id !== held.id) : this.items.value.map((n) => (n.id === held.id ? notification : n));
    if (!held.read && notification.read) { this.unread.value = Math.max(0, this.unread.value - 1); }
    if (held.read && !notification.read) { this.unread.value++; }
  }
}
