/**
 * The mock hub's build 4 state: pickers' options (systems, fns, people and groups from the mock admin; a few of each
 * other kind) and visibility kept in memory, on a hub with more than one person so the controls show. It adds a
 * Google Calendar system (configured, so its page is ready) whose connect page and connections are kept in memory:
 * connecting answers at once with a connected account, as the redirect back would.
 */
import {
  AccessTarget, accessKey, ActorId, ConnectDecl, ConnectionId, SystemName, type AccessView, type ConnectionChange, type ConnectionView, type ConnectPage, type PickOption, type PickQuery,
  type PickSource, type ShareRule,
} from '@harness/core';
import { systemView } from '../src/admin/test/fakes.ts';
import { listSource } from '../src/ui/picker.ts';
import type { MockAdmin } from './mockAdmin.ts';

const FIXED: Readonly<Partial<Record<PickSource, readonly PickOption[]>>> = {
  context: [{ value: 'fs/guide', label: 'fs/guide', hint: 'How to use fs' }, { value: 'memory/tabs', label: 'memory/tabs', hint: 'Prefers tabs' }],
  model: [{ value: 'openai/gpt-oss-20b:free', label: 'gpt-oss-20b (free)', hint: 'openrouter' }, { value: 'qwen2.5:3b', label: 'qwen2.5:3b', hint: 'ollama' }],
  resource: [{ value: 'hub://uploads/notes.md', label: 'notes.md', hint: 'hub://uploads/' }, { value: 'fs://repo/README.md', label: 'README.md', hint: 'fs://repo/' }],
  type: [{ value: 'fs/path', label: 'fs/path' }, { value: 'fs/Entry', label: 'fs/Entry' }],
  kind: [{ value: 'native', label: 'native' }, { value: 'hub/llm', label: 'hub/llm' }, { value: 'input/form', label: 'input/form' }],
};

/** The calendar system's name in the mock. */
const CALENDAR = SystemName.parse('google-calendar');

/** The calendar's connect declaration, as `systems/google-calendar` declares it. */
const CALENDAR_CONNECT: ConnectDecl = ConnectDecl.parse({
  title: 'Calendar',
  description: 'Connect your Google Calendar so the chat can see your events and, as you allow, add and change them.',
  icon: 'calendar',
  how: { flow: 'oauth' },
  settings: { name: 'obj', props: {
    calendars: { type: { name: 'optional', generic: { T: { name: 'list', generic: { V: { name: 'text' } } } } }, docs: 'The calendars the chat reads (ids). Empty: your primary calendar.' },
    defaultCalendar: { type: { name: 'optional', generic: { T: { name: 'text' } } }, docs: 'Where new events go. Default: your primary calendar.' },
  } },
  fns: {
    list_events: { on: true, ask: false }, search_events: { on: true, ask: false }, get_event: { on: true, ask: false },
    create_event: { on: true, ask: true }, update_event: { on: true, ask: true }, delete_event: { on: false, ask: true },
  },
});

/** What each calendar fn does, for the picker's hints. */
const CALENDAR_FNS: Readonly<Record<string, string>> = {
  list_events: 'List your events between two times.', search_events: 'Find your events by words.', get_event: 'Read one event in full.',
  create_event: 'Add an event to your calendar.', update_event: 'Change an event.', delete_event: 'Delete an event.',
};

/** Build 4's state, answered from memory. */
export class MockBuild4 {
  readonly #admin: MockAdmin;
  readonly #owner: () => ActorId;
  readonly #stored = new Map<string, AccessView>();
  #connections: ConnectionView[] = [];

  constructor(admin: MockAdmin, owner: () => ActorId) {
    this.#admin = admin;
    this.#owner = owner;
    admin.systems.set(CALENDAR, systemView({
      name: 'google-calendar', description: 'Your Google Calendar: see, add and change events as you.', fns: 6, version: '0.1.0',
      configType: { name: 'obj', props: {
        clientId: { type: { name: 'text', options: { minLength: 1 } }, docs: 'The OAuth client id (Google Cloud console, Credentials).' },
        clientSecret: { type: { name: 'text', options: { minLength: 1 } }, docs: 'The OAuth client secret.' },
        hubUrl: { type: { name: 'text', options: { minLength: 1 } }, docs: "The hub's public address. Add `<hub>/connect/callback` to the client's redirect URIs." },
      } },
      config: { value: { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: '••••••', hubUrl: 'https://hub.example.com' }, version: 1, setAt: Date.now() - 86_400_000, setBy: 'act_admin' },
    }));
  }

  /** The connect pages: the calendar, with the asker's connections and those shared with them. */
  connectPages(): ConnectPage[] {
    return [{ system: CALENDAR, decl: CALENDAR_CONNECT, ready: true, connections: this.#connections }];
  }

  /** Connecting: the mock signs in at once, as the redirect back from Google would. */
  connect(): { connection: ConnectionView } {
    const at = Date.now();
    const made: ConnectionView = {
      id: ConnectionId.parse(`cnx_${at.toString(36)}`), system: CALENDAR, owner: this.#owner(), status: 'connected',
      account: { label: 'ada@example.com', detail: 'Google' }, settings: {}, fns: {}, share: { visibility: 'private', with: [] }, createdAt: at, updatedAt: at,
    };
    this.#connections = [made, ...this.#connections.filter((c) => c.owner !== made.owner)];
    return { connection: made };
  }

  updateConnection(change: ConnectionChange): ConnectionView {
    const found = this.#connections.find((c) => c.id === change.connection);
    if (found === undefined) { throw new Error(`no connection ${change.connection}`); }
    const next: ConnectionView = {
      ...found, ...(change.settings === undefined ? {} : { settings: change.settings }), ...(change.fns === undefined ? {} : { fns: change.fns }),
      ...(change.share === undefined ? {} : { share: { visibility: change.share.visibility, with: readActors(change.share.with) } }), updatedAt: Date.now(),
    };
    this.#connections = this.#connections.map((c) => (c.id === next.id ? next : c));
    return next;
  }

  disconnect(id: ConnectionId): { ok: boolean } {
    const before = this.#connections.length;
    this.#connections = this.#connections.filter((c) => c.id !== id);
    return { ok: this.#connections.length < before };
  }

  /** A picker's options, or the labels of values. */
  async pick(query: PickQuery): Promise<PickOption[]> {
    const from = listSource(this.#options(query.source));
    const found = query.values === undefined ? await from.search(query.text ?? '') : await from.label(query.values);
    return found.slice(0, query.limit ?? 50);
  }

  /** A target's visibility: public and the owner's until set. */
  access(target: AccessTarget): AccessView {
    return this.#stored.get(accessKey(target)) ?? { target, sharing: { owner: this.#owner(), visibility: 'public', with: [] }, editable: true };
  }

  setAccess(target: AccessTarget, rule: ShareRule): AccessView {
    const view: AccessView = { target, sharing: { owner: this.access(target).sharing.owner, ...rule }, editable: true };
    this.#stored.set(accessKey(target), view);
    return view;
  }

  #options(source: PickSource): readonly PickOption[] {
    switch (source) {
      case 'system': return this.#admin.list().map((s) => ({ value: s.name, label: s.name, hint: s.description }));
      case 'fn': return [
        ...this.#admin.list().flatMap((s) => this.#admin.fns(s.name).map((fn) => ({ value: fn.name, label: fn.name, hint: fn.decl.description }))),
        ...Object.entries(CALENDAR_FNS).map(([local, hint]) => ({ value: `${CALENDAR}/${local}`, label: `${CALENDAR}/${local}`, hint })),
      ];
      case 'person': return this.#admin.actorsOf({ kind: 'user' }).map((a) => ({ value: a.id, label: a.name }));
      case 'group': return this.#admin.actorsOf({ kind: 'group' }).map((a) => ({ value: a.id, label: a.name, hint: 'group' }));
      case 'context': case 'kind': case 'model': case 'resource': case 'type': return FIXED[source] ?? [];
    }
  }
}

/** A visibility as the body sends it, read into the stored shape. */
export function readAccess(target: unknown): AccessTarget {
  return AccessTarget.parse(target);
}

/** Actor ids as the body sends them. */
export function readActors(ids: readonly string[]): ActorId[] {
  return ids.map((id) => ActorId.parse(id));
}
