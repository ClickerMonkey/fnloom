/**
 * The chat's place in the URL, so a refresh (or a shared link) returns to the same view: the session
 * (`/chat/:session`), a turn's tree (`/chat/:session/turn/:turn/tree`), the panel open over it (`?run=`, `?llm=`,
 * `?details=` for an answer's turn, `?resource=`, `?panel=settings|people`) and a message (`#m-:id`). Every value is
 * read through its schema, so a bad URL reads as nothing open. Opening a panel adds a history entry, so Back closes
 * it before it leaves the session; closing one goes back when that is where it came from. The list of chats keeps its
 * search (`?q=`) and view (`?chats=archived`) in the URL as well; moving between chats keeps them.
 */
import { LlmInteractionId, MessageId, ResourceUri, RunId, SessionId, TurnId } from '@harness/core';
import { computed } from 'vue';
import { useRoute, useRouter, type LocationQuery } from 'vue-router';
import { z } from 'zod';
import { links, ROUTES } from '../app/routes.ts';
import { TAB_KEYS } from './logic/inspect.ts';

/** The panels a session can have open besides inspectors. */
export const ChatPanel = z.enum(['settings', 'people']);
export type ChatPanel = z.infer<typeof ChatPanel>;

/** Each query key, and the schema of its value. */
export const PANEL_KEYS = { run: RunId, llm: LlmInteractionId, details: TurnId, resource: ResourceUri, panel: ChatPanel } as const;
export type PanelKey = keyof typeof PANEL_KEYS;
/** A panel's value, by key. */
export type PanelValue<K extends PanelKey> = z.infer<(typeof PANEL_KEYS)[K]>;

/** Which chats the list shows. */
export const ChatsView = z.enum(['active', 'archived']);
export type ChatsView = z.infer<typeof ChatsView>;

/** The query keys that belong to the list of chats, kept when moving between chats. */
export const LIST_KEYS = { search: 'q', view: 'chats' } as const;

/** The panel on top, when several are open: an LLM call over a run, a run over a turn's details, and so on. */
export const PANEL_ORDER = ['llm', 'run', 'details', 'resource', 'panel'] as const satisfies readonly PanelKey[];

/** The first string of a query value or route param. */
function one(value: unknown): string | undefined {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

/** Read a value through its schema; undefined when it doesn't fit. */
function read<S extends z.ZodType>(schema: S, value: unknown): z.output<S> | undefined {
  const parsed = schema.safeParse(one(value));
  return parsed.success ? parsed.data : undefined;
}

/** The query key of a panel's tab, for the panels that have tabs. */
function tabKeyOf(key: PanelKey): string | undefined {
  return key === 'run' || key === 'llm' ? TAB_KEYS[key] : undefined;
}

/** Whether a query has a valid value for a panel. */
export function hasPanel(query: LocationQuery, key: PanelKey): boolean {
  return read(PANEL_KEYS[key], query[key]) !== undefined;
}

/** The message a hash points at (`#m-msg_1`). */
export function hashMessage(hash: string): MessageId | undefined {
  const parsed = MessageId.safeParse(/^#m-(.+)$/.exec(hash)?.[1]);
  return parsed.success ? parsed.data : undefined;
}

/** The chat's URL state, and the moves that change it. */
export function useChatUrl() {
  const route = useRoute();
  const router = useRouter();

  const session = computed(() => read(SessionId, route.params['session']));
  const treeTurn = computed(() => (route.name === ROUTES.turnTree ? read(TurnId, route.params['turn']) : undefined));
  const run = computed(() => read(PANEL_KEYS.run, route.query['run']));
  const llm = computed(() => read(PANEL_KEYS.llm, route.query['llm']));
  const details = computed(() => read(PANEL_KEYS.details, route.query['details']));
  const resource = computed(() => read(PANEL_KEYS.resource, route.query['resource']));
  const panel = computed(() => read(PANEL_KEYS.panel, route.query['panel']));
  const message = computed(() => hashMessage(route.hash));
  const search = computed(() => one(route.query[LIST_KEYS.search]) ?? '');
  const archived = computed(() => read(ChatsView, route.query[LIST_KEYS.view]) === 'archived');
  /** The list's part of the query, to carry from chat to chat. */
  const listQuery = (): LocationQuery => Object.fromEntries(Object.values(LIST_KEYS).flatMap((key) => {
    const value = one(route.query[key]);
    return value === undefined ? [] : [[key, value]];
  }));
  /** The panel on top, if any. */
  const top = computed<PanelKey | 'tree' | undefined>(() => PANEL_ORDER.find((key) => hasPanel(route.query, key)) ?? (treeTurn.value === undefined ? undefined : 'tree'));

  /** Open a panel over the session (a new history entry). */
  function open<K extends PanelKey>(key: K, value: PanelValue<K>): void {
    void router.push({ query: { ...route.query, [key]: value }, hash: route.hash });
  }

  /** Close the panel on top: back, when the entry before is this view without it; otherwise replace. */
  function close(): void {
    const key = top.value;
    if (key === undefined) { return; }
    const base = router.resolve(session.value === undefined ? links.chat() : links.session(session.value)).path;
    const target = key === 'tree'
      ? router.resolve({ path: base, query: route.query }).fullPath
      : router.resolve({ query: Object.fromEntries(Object.entries(route.query).filter(([k]) => k !== key && k !== tabKeyOf(key))), hash: route.hash }).fullPath;
    const back: unknown = window.history.state === null ? undefined : Reflect.get(window.history.state, 'back');
    if (back === target) { router.back(); } else { void router.replace(target); }
  }

  /** Open a turn's tree over its session. */
  function openTree(turn: TurnId): void {
    if (session.value !== undefined) { void router.push({ path: router.resolve(links.turnTree(session.value, turn)).path, query: route.query }); }
  }

  /** Go to a session (Alt+↑/↓, the list), or the list with none, keeping the list's search and view. */
  function go(id: SessionId | undefined): void {
    void router.push({ path: router.resolve(id === undefined ? links.chat() : links.session(id)).path, query: listQuery() });
  }

  /** Change the list's search or view in the URL (replacing the entry: filters aren't places to go back to). */
  function setList(change: { readonly search?: string; readonly archived?: boolean }): void {
    const query: LocationQuery = { ...route.query };
    const set = (key: string, value: string | undefined): void => { if (value === undefined || value === '') { Reflect.deleteProperty(query, key); } else { query[key] = value; } };
    if (change.search !== undefined) { set(LIST_KEYS.search, change.search.trim()); }
    if (change.archived !== undefined) { set(LIST_KEYS.view, change.archived ? 'archived' : undefined); }
    void router.replace({ query, hash: route.hash });
  }

  /** Point the URL at a message (Copy link and quotes use the same form). */
  function showMessage(id: MessageId): void {
    void router.replace({ query: route.query, hash: `#m-${id}` });
  }

  return { session, treeTurn, run, llm, details, resource, panel, message, search, archived, top, open, close, openTree, go, setList, showMessage };
}

/** The chat's URL state. */
export type ChatUrl = ReturnType<typeof useChatUrl>;
