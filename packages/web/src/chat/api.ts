/**
 * The chat's callers, made once from the one hub client: sessions, messages and sending, runs and their inspection,
 * the composer's searches, approvals and answers, uploads and voice, and the renderers' actions. Stores receive only
 * the callers they use (`Pick<ChatApi, …>`), so tests hand them fakes. Live session events come through
 * `SessionEvents`, and file bytes go to the hub's presigned URL through a `FileSender`.
 */
import type { SessionEvent, SessionId } from '@harness/core';
import type { Hub } from '../api/client.ts';
import { connectionsApi } from '../api/connections.ts';
import { pickerApi } from '../api/pickers.ts';

/** The cache tag of the session list, cleared by anything that changes a session. */
export const SESSIONS_TAG = 'sessions';
/** The cache tag of the chat's capabilities, cleared when the hub says they changed. */
export const CAPABILITIES_TAG = 'capabilities';

/** How long typing pauses before a draft's suggestions are asked for (ms). */
export const SUGGEST_PAUSE = 700;
/** How long typing in the chat list's search pauses before the list is asked for again (ms). */
export const SEARCH_PAUSE = 250;
/** How long a live turn's tree waits after its runs change before it is asked for again (ms). */
export const TREE_REFRESH = 400;

/** Make the chat's callers. */
export function chatApi(hub: Hub) {
  return {
    capabilities: hub.caller('capabilities', { cache: { ttl: 60_000, tags: [CAPABILITIES_TAG] }, dedupe: true }),
    types: hub.caller('types', { cache: { ttl: 300_000, tags: [CAPABILITIES_TAG] }, dedupe: true }),
    /** The list's pages; a newer first page (a reload, the other view) supersedes one still on its way. */
    sessions: hub.caller('sessions', { cache: { ttl: 5_000, tags: [SESSIONS_TAG] }, dedupe: true, lastOnly: true }),
    /** The list's search as it is typed: asked once typing pauses, only the latest answer counts. */
    searchSessions: hub.caller('sessions', { debounce: SEARCH_PAUSE, lastOnly: true }),
    session: hub.caller('session', { dedupe: true }),
    /** A list field's values in the data, for the search boxes' suggestions (every list, not only the chat's). */
    listValues: hub.caller('listValues', { cache: { ttl: 10_000 }, dedupe: true }),
    createSession: hub.caller('createSession', { invalidates: [SESSIONS_TAG] }),
    updateSession: hub.caller('updateSession', { invalidates: [SESSIONS_TAG] }),
    deleteSession: hub.caller('deleteSession', { invalidates: [SESSIONS_TAG] }),
    limits: hub.caller('limits', { dedupe: true }),
    messages: hub.caller('messages', { dedupe: true }),
    send: hub.caller('send', { invalidates: [SESSIONS_TAG] }),
    invoke: hub.caller('invoke'),
    control: hub.caller('control'),
    controls: hub.caller('controls', { dedupe: true }),
    background: hub.caller('background'),
    undoTurn: hub.caller('undoTurn'),
    continueTurn: hub.caller('continueTurn'),
    tree: hub.caller('tree', { dedupe: true }),
    /** A live turn's tree asked again as its runs change: once changes pause, only the latest answer counts. */
    treeRefresh: hub.caller('tree', { debounce: TREE_REFRESH, lastOnly: true }),
    run: hub.caller('run', { dedupe: true }),
    llmCall: hub.caller('llmCall', { cache: { ttl: 300_000 }, dedupe: true }),
    /** A draft's suggestions: asked once typing pauses, only the latest answer counts. */
    suggest: hub.caller('suggest', { debounce: SUGGEST_PAUSE, lastOnly: true }),
    mentions: hub.caller('mentions'),
    mentionHover: hub.caller('mentionHover', { cache: { ttl: 30_000 }, dedupe: true }),
    waiting: hub.caller('waiting'),
    approve: hub.caller('approve'),
    /** The approvals of some runs, with what each would do (the inbox's approval cards). */
    approvals: hub.caller('approvals', { dedupe: true }),
    /** Which systems contribute to a registry (the result views' visuals), cleared with the capabilities. */
    contributions: hub.caller('contributions', { cache: { ttl: 60_000, tags: [CAPABILITIES_TAG] }, dedupe: true }),
    /** Raise a used-up budget (admins): the run waiting on it goes on at its next check. */
    setBudget: hub.caller('setBudget'),
    answer: hub.caller('answer'),
    presence: hub.caller('presence'),
    resource: hub.caller('resource', { cache: { ttl: 30_000 }, dedupe: true }),
    upload: hub.caller('upload'),
    uploaded: hub.caller('uploaded'),
    transcribe: hub.caller('transcribe'),
    act: hub.caller('act'),
    submit: hub.caller('submit'),
    state: hub.caller('state', { dedupe: true }),
    /** What the session's contextor would put in the prompt for a draft, without calling the model; only the latest counts. */
    previewSelection: hub.caller('previewSelection', { lastOnly: true }),
    ...pickerApi(hub),
    ...connectionsApi(hub),
  };
}

/** The chat's callers. */
export type ChatApi = ReturnType<typeof chatApi>;

/** Listen to one session's live events; returns the function that stops listening. */
export type SessionEvents = (session: SessionId, listener: (event: SessionEvent) => void) => () => void;

/** A session's live events, from the hub's `session` channel. */
export function sessionEvents(hub: Hub): SessionEvents {
  return (session, listener) => hub.on('session', { session }, listener);
}

/** Bytes on their way to a presigned URL, with progress. */
export interface FileSender {
  /** PUT `file` to `url`; `progress` gets the fraction sent (0 to 1). Rejects when the transfer fails or is aborted. */
  put(url: string, file: Blob, progress: (fraction: number) => void, signal: AbortSignal): Promise<void>;
}

/** Sends files with `XMLHttpRequest`, the one browser API that reports upload progress. */
export class XhrFileSender implements FileSender {
  put(url: string, file: Blob, progress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      if (file.type !== '') { xhr.setRequestHeader('content-type', file.type); }
      xhr.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) { progress(event.loaded / event.total); } };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { progress(1); resolve(); } else { reject(new Error(`Upload failed (${xhr.status}).`)); }
      };
      xhr.onerror = () => { reject(new Error('Upload failed.')); };
      xhr.onabort = () => { reject(new DOMException('Upload cancelled.', 'AbortError')); };
      signal.addEventListener('abort', () => { xhr.abort(); }, { once: true });
      xhr.send(file);
    });
  }
}
