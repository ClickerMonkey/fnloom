/**
 * What the chat may offer right now (the hub's `ChatCapabilities`): voice, uploads, the `@` providers, the `/`
 * commands, the `!` fns, the systems' client builds and their status. Read per session, and read again when the hub
 * says they changed (the user channel's `capabilities` event) or a system comes or goes, so `@` starts working
 * without a reload.
 */
import type { ChatCapabilities, QualifiedName, SessionId, UserEvent } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import { problemText } from '../../state/problems.ts';
import type { ChatApi } from '../api.ts';

/** The chat's capabilities for the open session. */
export class CapabilitiesStore {
  readonly #api: Pick<ChatApi, 'capabilities'>;
  readonly #events: UserEvents;
  #stop: (() => void) | undefined;
  #generation = 0;

  readonly value = shallowRef<ChatCapabilities | undefined>(undefined);
  readonly session = ref<SessionId | undefined>(undefined);
  readonly problem = ref('');

  /** Whether each power is on now. */
  readonly can = computed(() => {
    const caps = this.value.value;
    return {
      mention: (caps?.mentions.length ?? 0) > 0,
      command: (caps?.commands.length ?? 0) > 0,
      invoke: (caps?.invocations.length ?? 0) > 0,
      upload: caps?.uploads === true,
      voice: caps?.voiceInput === true,
    };
  });

  constructor(api: Pick<ChatApi, 'capabilities'>, events: UserEvents) {
    this.#api = api;
    this.#events = events;
  }

  /** Listen for changes. */
  start(): void {
    if (this.#stop !== undefined) { return; }
    this.#stop = this.#events((event) => { this.#onEvent(event); });
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  /** Read the capabilities for a session (or the hub's, with none). */
  async load(session: SessionId | undefined = this.session.value): Promise<void> {
    this.session.value = session;
    const generation = ++this.#generation;
    try {
      const caps = await this.#api.capabilities.call(session === undefined ? {} : { session });
      if (generation !== this.#generation) { return; }
      this.value.value = caps;
      this.problem.value = '';
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, "Couldn't load what this chat can do."); }
    }
  }

  /** Whether a system is connected now. */
  online(system: string): boolean {
    return this.value.value?.systems.find((s) => s.name === system)?.status === 'connected';
  }

  /** The `!` fn of a name, if the person may run it. */
  invocation(fn: QualifiedName): ChatCapabilities['invocations'][number] | undefined {
    return this.value.value?.invocations.find((i) => i.fn === fn);
  }

  /** The `/` command of a context, if the session offers one. */
  commandFor(context: QualifiedName): ChatCapabilities['commands'][number] | undefined {
    return this.value.value?.commands.find((c) => c.context === context);
  }

  #onEvent(event: UserEvent): void {
    if (event.type === 'capabilities') {
      this.#api.capabilities.invalidate();
      void this.load();
      return;
    }
    if (event.type === 'system') {
      const caps = this.value.value;
      if (caps === undefined) { return; }
      this.value.value = { ...caps, systems: caps.systems.map((s) => (s.name === event.system ? { ...s, status: event.status } : s)) };
    }
  }
}
