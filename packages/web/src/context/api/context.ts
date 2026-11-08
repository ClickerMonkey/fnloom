/**
 * The context pages' callers, made once from the one hub client: every context item (filtered, page by page), one
 * item with its links both ways and its text, writing, changing and forgetting memory, drawing and removing links, and making
 * context from a resource. Stores receive only the callers they use (`Pick<ContextApi, …>`), so tests hand them fakes.
 * Live changes come through `ContextEvents`.
 */
import type { QualifiedName } from '@harness/core';
import type { Hub } from '../../api/client.ts';
import type { UserEvents } from '../../api/notifications.ts';

/** Make the context callers. */
export function contextApi(hub: Hub) {
  return {
    /** The list's pages; a newer first page (a filter changed) supersedes one still on its way. */
    list: hub.caller('contexts', { lastOnly: true }),
    item: hub.caller('contextItem', { dedupe: true }),
    remember: hub.caller('remember'),
    updateMemory: hub.caller('updateMemory'),
    forget: hub.caller('forget'),
    link: hub.caller('linkContext'),
    unlink: hub.caller('unlinkContext'),
    fromResource: hub.caller('contextFromResource'),
  };
}

/** The context callers. */
export type ContextApi = ReturnType<typeof contextApi>;

/** Listen to context changes (an item written, forgotten or linked); returns the function that stops listening. */
export type ContextEvents = (listener: (name: QualifiedName) => void) => () => void;

/** Context changes from the user's live events (the hub's `user` channel). */
export function contextEvents(events: UserEvents): ContextEvents {
  return (listener) => events((event) => { if (event.type === 'context') { listener(event.name); } });
}
