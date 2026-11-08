/**
 * The chat's root store: the session list, the capabilities, the inspectors, collapsed cards and system renderers,
 * and a thread, composer and draft suggestions per session (made on first open and kept for the last few sessions,
 * so switching back is instant and drafts stay). `app/wire.ts` builds it from the real callers; tests build it from
 * fakes. Pages reach it through `useStores().chat`.
 */
import type { ListValuesCaller } from '../../state/query.ts';
import { SessionId, type ActorId, type ClientInfo, type ContentRef, type RunId } from '@harness/core';
import { ref, shallowRef } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import type { KeyValueStore } from '../../state/persisted.ts';
import type { ChatApi, FileSender, SessionEvents } from '../api.ts';
import { CapabilitiesStore } from './capabilities.ts';
import { TypeLibrary } from '../../gin/types.ts';
import { CollapseStore } from './collapse.ts';
import { ComposerStore } from './composer.ts';
import { Inspector } from './inspect.ts';
import { MentionCards } from './mentions.ts';
import { RendererHub, type RendererDeps } from './renderers.ts';
import { SessionListStore } from './sessions.ts';
import type { RetryPolicy } from '../../state/retry.ts';
import { SelectionPreview } from './preview.ts';
import { DraftSuggestions } from './suggest.ts';
import { THREAD_SETTINGS, ThreadStore, type ThreadSettings } from './thread.ts';
import { sendFile, UploadQueue, type Previews } from './uploads.ts';
import { RecordedDictation, SpeechDictation, VoiceStore, type DictationEngines, type Recorder, type SpeechRecognizerFactory } from './voice.ts';

/** What the chat is built from. */
export interface ChatDeps {
  readonly api: ChatApi;
  readonly userEvents: UserEvents;
  readonly sessionEvents: SessionEvents;
  readonly store: KeyValueStore;
  readonly sender: FileSender;
  readonly clock: () => number;
  readonly client: () => ClientInfo;
  readonly me: () => ActorId | undefined;
  /** A microphone, when this browser can record (the `model` dictation engine). */
  readonly recorder: () => Recorder | undefined;
  /** The browser's speech recognition, when it has one (the `browser` dictation engine). */
  readonly speech?: () => SpeechRecognizerFactory | undefined;
  readonly previews?: Previews;
  readonly renderers?: Pick<RendererDeps, 'load' | 'share'>;
  readonly thread?: ThreadSettings;
  /** How a thread retries its catch-up after a reconnect (default `RETRY`). */
  readonly retry?: RetryPolicy;
}

/** How many sessions keep their thread in memory. */
export const THREADS_KEPT = 5;

/** The browser's time zone, locale and clock. */
export function browserClient(now: () => number = Date.now): ClientInfo {
  const options = Intl.DateTimeFormat().resolvedOptions();
  return { timeZone: options.timeZone, locale: navigator.language, now: now() };
}

/** Everything the chat keeps. */
export class ChatStore {
  /** A list field's values in the data, for every search box's suggestions. */
  readonly listValues: ListValuesCaller;
  readonly sessions: SessionListStore;
  readonly capabilities: CapabilitiesStore;
  readonly inspector: Inspector;
  /** The named gin types forms need, fetched from the hub as they come up. */
  readonly types: TypeLibrary;
  readonly collapse: CollapseStore;
  readonly renderers: RendererHub;
  readonly mentions: MentionCards;
  /** Chat titles read for ids the list doesn't hold (a search pill's session), by id. */
  readonly #titles = shallowRef<ReadonlyMap<string, string>>(new Map());
  /** The ids already asked for (not reactive: asking happens while a view reads a title). */
  readonly #askedTitles = new Set<string>();
  /** The session shown now. */
  readonly current = ref<SessionId | undefined>(undefined);
  readonly #deps: ChatDeps;
  readonly #threads = new Map<SessionId, ThreadStore>();
  readonly #composers = new Map<SessionId, ComposerStore>();
  readonly #suggestions = new Map<SessionId, DraftSuggestions>();
  readonly #previews = new Map<SessionId, SelectionPreview>();
  #voice: VoiceStore | null | undefined;

  constructor(deps: ChatDeps) {
    this.#deps = deps;
    this.listValues = deps.api.listValues;
    this.sessions = new SessionListStore(deps.api, deps.userEvents);
    this.capabilities = new CapabilitiesStore(deps.api, deps.userEvents);
    this.inspector = new Inspector(deps.api);
    this.types = new TypeLibrary((names) => deps.api.types.call({ names: [...names] }));
    this.collapse = new CollapseStore(deps.store);
    this.mentions = new MentionCards(deps.api);
    this.renderers = new RendererHub({
      thread: () => (this.current.value === undefined ? undefined : this.#threads.get(this.current.value)),
      online: (system) => this.capabilities.online(system),
      ...deps.renderers,
    });
  }

  /** Listen to the user channel for list and capability changes. */
  start(): void {
    this.sessions.start();
    this.capabilities.start();
  }

  stop(): void {
    this.sessions.stop();
    this.capabilities.stop();
    for (const thread of this.#threads.values()) { thread.close(); }
  }

  /**
   * A chat's title by its id, for showing an id a person can't read (a search pill's session): from the list when it
   * holds the chat, else asked of the hub once and filled in when it answers. Undefined while unknown or untitled.
   */
  titleOf(id: string): string | undefined {
    const listed = this.sessions.items.value.find((s) => s.id === id);
    if (listed !== undefined) { return listed.title === '' ? undefined : listed.title; }
    const known = this.#titles.value.get(id);
    if (known !== undefined) { return known === '' ? undefined : known; }
    const parsed = SessionId.safeParse(id);
    if (!parsed.success || this.#askedTitles.has(id)) { return undefined; }
    this.#askedTitles.add(id);
    this.#deps.api.session.call({ session: parsed.data }).then(
      (session) => { this.#titles.value = new Map([...this.#titles.value, [id, session.title]]); },
      () => undefined,
    );
    return undefined;
  }

  /** A session's thread, made on first use. The oldest beyond `THREADS_KEPT` are let go. */
  thread(id: SessionId): ThreadStore {
    const known = this.#threads.get(id);
    if (known !== undefined) {
      this.#threads.delete(id);
      this.#threads.set(id, known);
      return known;
    }
    const thread = new ThreadStore(id, {
      api: this.#deps.api, events: this.#deps.sessionEvents, clock: this.#deps.clock, client: this.#deps.client, me: this.#deps.me,
      changed: (summary) => { this.sessions.remember(summary); },
      ...(this.#deps.retry === undefined ? {} : { retry: this.#deps.retry }),
    }, this.#deps.thread ?? THREAD_SETTINGS);
    this.#threads.set(id, thread);
    for (const [old, stale] of this.#threads) {
      if (this.#threads.size <= THREADS_KEPT) { break; }
      if (old === id || old === this.current.value) { continue; }
      stale.close();
      this.#threads.delete(old);
    }
    return thread;
  }

  /** The chat a run belongs to, if any (a notification about a run leads there). */
  async sessionOfRun(run: RunId): Promise<SessionId | undefined> {
    return (await this.#deps.api.run.call({ run })).session;
  }

  /** A session's composer (its draft is saved per session). */
  composer(id: SessionId): ComposerStore {
    const known = this.#composers.get(id);
    if (known !== undefined) { return known; }
    const composer = new ComposerStore({
      session: id, store: this.#deps.store, api: this.#deps.api,
      capabilities: () => this.capabilities.value.value,
      uploads: new UploadQueue(this.#deps.api, this.#deps.sender, this.#deps.previews),
    });
    this.#composers.set(id, composer);
    return composer;
  }

  /** A session's suggestions while writing. */
  suggestions(id: SessionId): DraftSuggestions {
    const known = this.#suggestions.get(id);
    if (known !== undefined) { return known; }
    const made = new DraftSuggestions(this.#deps.api, id);
    this.#suggestions.set(id, made);
    return made;
  }

  /** A session's dry run of its contextor ("what would this message get?"). */
  preview(id: SessionId): SelectionPreview {
    const known = this.#previews.get(id);
    if (known !== undefined) { return known; }
    const made = new SelectionPreview(this.#deps.api, id);
    this.#previews.set(id, made);
    return made;
  }

  /** Dictation, when this browser can record or recognise speech. */
  voice(): VoiceStore | undefined {
    if (this.#voice === undefined) {
      const recorder = this.#deps.recorder();
      const speech = this.#deps.speech?.();
      const engines: DictationEngines = {
        ...(recorder === undefined ? {} : { model: new RecordedDictation(recorder, (clip) => this.#uploadClip(clip), this.#deps.api) }),
        ...(speech === undefined ? {} : { browser: new SpeechDictation(speech) }),
      };
      this.#voice = Object.keys(engines).length === 0 ? null : new VoiceStore(engines, this.#deps.clock);
    }
    return this.#voice ?? undefined;
  }

  /** Show a session: listen to it, load it, and read its capabilities. The one shown before stops listening. */
  async open(id: SessionId): Promise<ThreadStore> {
    const previous = this.current.value;
    if (previous !== undefined && previous !== id) { this.#threads.get(previous)?.close(); }
    this.current.value = id;
    const thread = this.thread(id);
    await Promise.all([thread.open(), this.#loadCapabilities(id)]);
    return thread;
  }

  /** Leave the open session (the list is shown). */
  leave(): void {
    const previous = this.current.value;
    if (previous !== undefined) { this.#threads.get(previous)?.close(); }
    this.current.value = undefined;
  }

  /** Fetch again after a reconnect: events sent while offline are lost. */
  async refresh(): Promise<void> {
    const current = this.current.value;
    await Promise.all([
      this.sessions.loaded.value ? this.sessions.load() : Promise.resolve(),
      this.#loadCapabilities(current),
      current === undefined ? Promise.resolve() : this.thread(current).refresh(),
    ]);
  }

  /** Load the systems' renderers outside a chat (the admin's resource viewer uses them), unless they are loaded. */
  async prepareRenderers(): Promise<void> {
    if (this.capabilities.value.value === undefined) { await this.#loadCapabilities(this.current.value); }
  }

  async #loadCapabilities(session: SessionId | undefined): Promise<void> {
    await this.capabilities.load(session);
    const caps = this.capabilities.value.value;
    if (caps !== undefined) { void this.renderers.sync(caps.clients); }
  }

  #uploadClip(clip: Blob): Promise<ContentRef> {
    const extension = clip.type.includes('ogg') ? 'ogg' : clip.type.includes('mp4') ? 'm4a' : 'webm';
    return sendFile(this.#deps.api, this.#deps.sender, clip, `dictation.${extension}`, () => undefined, new AbortController().signal);
  }
}
