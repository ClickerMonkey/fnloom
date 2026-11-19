/**
 * Where each field of a list the database filters lives in its table's row (`ListColumn`), for `HubStore.lists`: the
 * one map from a list's fields (`LIST_FIELDS`) to SQL, read by the list's source and by the fns and context search
 * (`FnSearchQuery.filters`), so a filter means the same in both. Each map names every field of its list, and reads an
 * absent value as the list's accessor does.
 */
import type { ListField } from '@harness/core';
import type { ListColumn } from '../store/index.ts';

/** The context list's fields in the `context` table. */
export const CONTEXT_COLUMNS = {
  name: { column: 'name' },
  system: { column: 'system' },
  // a system's own context has no origin
  origin: { column: 'origin', path: '$.type', absent: 'system' },
  tags: { column: 'decl', path: '$.tags', each: true },
  disabled: { column: 'disabled', absent: false },
  stale: { column: 'stale' },
  tokens: { column: 'tokens', path: '$.full' },
  updatedAt: { column: 'updatedAt' },
} as const satisfies { readonly [F in ListField<'contexts'>]: ListColumn };

/** The notification list's fields in the `notifications` table, and whose they are (`user`). */
export const NOTIFICATION_COLUMNS = {
  kind: { column: 'reason' },
  read: { column: 'read' },
  createdAt: { column: 'createdAt' },
  user: { column: 'user' },
} as const satisfies { readonly [F in ListField<'notifications'>]: ListColumn } & Readonly<Record<string, ListColumn>>;

/** SSO: the people list's fields in the `actors` table, and the kind that makes a row a person. */
export const USER_COLUMNS = {
  name: { column: 'name' },
  email: { column: 'email' },
  role: { column: 'role' },
  disabled: { column: 'disabled', absent: false },
  createdAt: { column: 'createdAt' },
  kind: { column: 'kind' },
} as const satisfies { readonly [F in ListField<'users'>]: ListColumn } & Readonly<Record<string, ListColumn>>;

/** What a person's free text matches: their name and email. */
export const USER_TEXT: readonly ListColumn[] = [USER_COLUMNS.name, USER_COLUMNS.email];

/** SSO: the groups list's fields in the `actors` table, and the kind that makes a row a group. */
export const GROUP_COLUMNS = {
  name: { column: 'name' },
  createdAt: { column: 'createdAt' },
  kind: { column: 'kind' },
} as const satisfies { readonly [F in ListField<'groups'>]: ListColumn } & Readonly<Record<string, ListColumn>>;

/** What a group's free text matches: its name and what it is about. */
export const GROUP_TEXT: readonly ListColumn[] = [GROUP_COLUMNS.name, { column: 'about' }];

/** What a notification's free text matches: its kind, title and body. */
export const NOTIFICATION_TEXT: readonly ListColumn[] = [NOTIFICATION_COLUMNS.kind, { column: 'title' }, { column: 'body' }];
