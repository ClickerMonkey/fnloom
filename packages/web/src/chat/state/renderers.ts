/**
 * Systems' renderers in the chat. The hub lists each system's client build in the capabilities (`clients`); this
 * loads each once per build hash into the SDK's `ClientRuntime`, which looks renderers up by fn, kind, attachment,
 * input type, mention provider and resource format, and builds their props from the thread's wire JSON decoded with
 * each contract's gin types. Renderers talk back through a `ClientBridge` made of the open
 * thread (actions, form submissions and live delivery state) and the capabilities (whether a system is online).
 *
 * A build that fails to load is marked failed, and its fns fall back to the default card.
 */
import {
  QualifiedName, SystemName, type ChatCapabilities, type DeliveryId, type Json, type MentionHover, type MessagePart, type ResultTable,
} from '@harness/core';
import type { InputMount } from '@harness/sdk';
import type { ResultFacts } from '@harness/core';
import { ClientRuntime, type ClientBridge, type PageWire, type VisualOption } from '@harness/sdk/client';
import { shallowRef } from 'vue';
import type { RenderView } from '../components/types.ts';
import { runError, runResult, shownStatus, type RunView } from '../logic/runs.ts';
import type { ThreadStore } from './thread.ts';

/** An attachment part of a message. */
type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;
/** A mention part of a message. */
type MentionPart = Extract<MessagePart, { type: 'mention' }>;

/** Where a system's client build is. */
export type ClientStatus = 'loading' | 'ready' | 'failed';

/** What the renderers need from the rest of the chat. */
export interface RendererDeps {
  /** The thread renderers act in. */
  readonly thread: () => ThreadStore | undefined;
  readonly online: (system: string) => boolean;
  /** Import a client build into the runtime (the runtime's own `load`, unless a test passes one). */
  readonly load?: (runtime: ClientRuntime, url: string) => Promise<void>;
  /** Give builds the chat's Vue and SDK, once, before the first load. */
  readonly share?: () => Promise<void>;
}

/** The chat's system renderers. */
export class RendererHub {
  readonly runtime: ClientRuntime;
  readonly #deps: RendererDeps;
  readonly #hashes = new Map<string, string>();
  #shared: Promise<void> | undefined;

  /** Each system's build status. */
  readonly status = shallowRef<ReadonlyMap<string, ClientStatus>>(new Map());
  /** Bumped when a build finishes loading, so lookups made before it run again. */
  readonly version = shallowRef(0);

  constructor(deps: RendererDeps) {
    this.#deps = deps;
    const bridge: ClientBridge = {
      online: (system) => deps.online(system),
      act: ({ system, action, input, run }) => Promise.resolve().then(() => this.#thread().act(SystemName.parse(system), action, input, run)),
      submit: async ({ run, value }) => {
        const delivery = await this.#thread().submit(run, value);
        if (delivery === undefined) { throw new Error("Couldn't submit that."); }
        return delivery;
      },
      invoke: async ({ fn, args }) => {
        const run = await this.#thread().invoke(fn, args);
        if (run === undefined) { throw new Error("Couldn't run that."); }
        return run;
      },
      follow: (delivery: DeliveryId, status) => Promise.resolve().then(() => this.#thread().follow(delivery, status)),
    };
    this.runtime = new ClientRuntime(bridge);
  }

  /** Load the builds listed in the capabilities that are new or changed. */
  async sync(clients: ChatCapabilities['clients']): Promise<void> {
    const changed = clients.filter((c) => this.#hashes.get(c.system) !== c.hash);
    if (changed.length === 0) { return; }
    this.#shared ??= this.#deps.share?.() ?? Promise.resolve();
    await this.#shared;
    await Promise.all(changed.map(async (c) => {
      this.#hashes.set(c.system, c.hash);
      this.#setStatus(c.system, 'loading');
      try {
        await (this.#deps.load ?? ((runtime, url) => runtime.load(url).then(() => undefined)))(this.runtime, c.url);
        this.#setStatus(c.system, 'ready');
        this.version.value++;
      } catch (error) {
        console.error('chat.renderer.load-failed', { system: c.system, url: c.url, error });
        this.#setStatus(c.system, 'failed');
      }
    }));
  }

  /**
   * A run's renderer and its view: its status as the chat shows it (`waiting` while it waits on the person's answer),
   * args, outcome, progress and the session state fields its fn declared, decoded by the runtime with the fn's gin
   * types. Undefined while the run's record (its args) hasn't arrived, when no renderer is loaded for it, or when its
   * values don't fit the fn's types (the default card draws it then).
   */
  fnView(run: RunView, state: Readonly<Record<string, Json>>): RenderView<'fn'> | undefined {
    this.#track();
    if (run.args === undefined) { return undefined; }
    const result = runResult(run);
    const error = runError(run);
    return this.runtime.fnView({
      fn: run.fn, kind: run.kind === undefined || run.kind === 'native' ? undefined : run.kind, run: run.id, status: shownStatus(run), args: run.args, state,
      ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }), ...(run.progress === undefined ? {} : { progress: run.progress }),
    });
  }

  /**
   * A finished run's result renderer (`client({ results })`, by its fn or kind) and its view, titled as the chat names
   * the run. Undefined until the run is done with a result, or when no build has one for it.
   */
  resultView(run: RunView, title: string): RenderView<'result'> | undefined {
    this.#track();
    const result = runResult(run);
    if (run.status !== 'done' || run.args === undefined || result === undefined) { return undefined; }
    return this.runtime.resultView({
      fn: run.fn, kind: run.kind === undefined || run.kind === 'native' ? undefined : run.kind, run: run.id, args: run.args, result, title,
    });
  }

  /** A system page's component and props (`/s/<system>/<page>`), once its system's build has loaded. */
  pageView(system: string, page: string, wire: PageWire): RenderView<'page'> | undefined {
    this.#track();
    return this.runtime.pageView(system, page, wire);
  }

  /** An attachment's renderer and view, if its system's build has one and the data fits its type. */
  attachmentView(part: AttachmentPart): RenderView<'attachment'> | undefined {
    this.#track();
    return this.runtime.attachmentView({ attachment: part.attachment, data: part.data, title: part.title });
  }

  /** A custom input for a named type (`fs/Entry`), with its system's client and its value codec; the form adds the value and problems. */
  inputView(type: string): InputMount | undefined {
    this.#track();
    const name = QualifiedName.safeParse(type);
    return name.success ? this.runtime.inputView(name.data) : undefined;
  }

  /** A mention provider's custom hover card, with what its `hover` returned (undefined while loading or gone). */
  mentionView(part: MentionPart, hover: MentionHover | undefined): RenderView<'mention'> | undefined {
    this.#track();
    return this.runtime.mentionView({ provider: part.provider, label: part.label, target: part.target, hover });
  }

  /**
   * The visuals loaded builds contribute to a registry that fit a table, best fit first, each with the label and icon
   * its contract gives it (`ClientRuntime.visuals`).
   */
  contributedVisuals(registry: QualifiedName, table: ResultTable, facts: ResultFacts): readonly VisualOption[] {
    this.#track();
    return this.runtime.visuals(registry, table, facts);
  }

  /** Read the version, so a lookup inside a computed or render runs again when a build loads. */
  #track(): number {
    return this.version.value;
  }

  #thread(): ThreadStore {
    const thread = this.#deps.thread();
    if (thread === undefined) { throw new Error('No chat is open.'); }
    return thread;
  }

  #setStatus(system: string, status: ClientStatus): void {
    const next = new Map(this.status.value);
    next.set(system, status);
    this.status.value = next;
  }
}

