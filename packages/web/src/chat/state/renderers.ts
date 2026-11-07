/**
 * Systems' renderers in the chat. The hub lists each system's client build in the capabilities (`clients`); this
 * loads each once per build hash into the SDK's `ClientRuntime`, which looks renderers up by fn, kind, attachment,
 * input type, mention provider and resource format. Renderers talk back through a `ClientBridge` made of the open
 * thread (actions, form submissions and live delivery state) and the capabilities (whether a system is online).
 *
 * A build that fails to load is marked failed, and its fns fall back to the default card.
 */
import {
  QualifiedName, splitName, SystemName, type ChatCapabilities, type DeliveryId, type Json, type MentionHover, type MessagePart, type ResourceRead,
} from '@harness/core';
import type { AnyViews } from '@harness/sdk';
import { ClientRuntime, type AnyRenderer, type ClientBridge } from '@harness/sdk/client';
import { shallowRef } from 'vue';
import type { RenderView } from '../components/types.ts';
import { runError, runResult, shownStatus, type RunView } from '../logic/runs.ts';
import type { ThreadStore } from './thread.ts';

/** An attachment part of a message. */
type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;
/** A mention part of a message. */
type MentionPart = Extract<MessagePart, { type: 'mention' }>;

/**
 * A system's viewer for a resource, mounted with the resource's stat and its text (inline text only; bytes are not
 * fetched here). Undefined when no system registered a viewer for its format, so the default viewer draws it.
 */
export function resourceRenderView(renderers: Pick<RendererHub, 'resourceView'>, read: ResourceRead | undefined): RenderView<'resource'> | undefined {
  return read === undefined ? undefined : renderers.resourceView(read);
}

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
   * A run's renderer and its view: its status as the chat shows it (`waiting` while it waits on the person's answer), args, outcome, progress, the session state fields its fn declared, the form
   * submit (only for a fn that declares a form) and its system's client. Undefined while the run's record (its args)
   * hasn't arrived, or when no renderer is loaded for it.
   */
  fnView(run: RunView, state: Readonly<Record<string, Json>>): RenderView<'fn'> | undefined {
    if (run.args === undefined) { return undefined; }
    const component = this.fn(run.fn, run.kind === undefined || run.kind === 'native' ? undefined : run.kind);
    if (component === undefined) { return undefined; }
    const result = runResult(run);
    const error = runError(run);
    const props = {
      run: run.id, status: shownStatus(run), args: run.args, state,
      ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }), ...(run.progress === undefined ? {} : { progress: run.progress }),
      submit: this.runtime.formSubmit(run.fn, run.id), system: this.runtime.systemClient(splitName(run.fn).system, run.id),
    } satisfies AnyViews['fn'];
    return { component, props };
  }

  /** An attachment's renderer and view, if its system's build has one. */
  attachmentView(part: AttachmentPart): RenderView<'attachment'> | undefined {
    const component = this.attachment(part.attachment);
    if (component === undefined) { return undefined; }
    const props = { data: part.data, title: part.title, system: this.#client(part.attachment) } satisfies AnyViews['attachment'];
    return { component, props };
  }

  /** A custom input for a named type (`fs/Entry`), with its system's client; the form adds the value and problems. */
  inputView(type: string): RenderView<'input'> | undefined {
    const name = QualifiedName.safeParse(type);
    const component = name.success ? this.input(name.data) : undefined;
    if (!name.success || component === undefined) { return undefined; }
    return { component, props: { system: this.#client(name.data) } satisfies AnyViews['input'] };
  }

  /** A mention provider's custom hover card, with what its `hover` returned (undefined while loading or gone). */
  mentionView(part: MentionPart, hover: MentionHover | undefined): RenderView<'mention'> | undefined {
    const component = this.mention(part.provider);
    if (component === undefined) { return undefined; }
    const props = { label: part.label, target: part.target, hover, system: this.#client(part.provider) } satisfies AnyViews['mention'];
    return { component, props };
  }

  /** A system's viewer for a read resource's format, with its stat and inline text. */
  resourceView(read: ResourceRead): RenderView<'resource'> | undefined {
    const format = read.stat.format;
    const component = format === undefined ? undefined : this.resource(format);
    const system = format === undefined ? undefined : this.runtime.viewerSystem(format);
    if (component === undefined || system === undefined) { return undefined; }
    const text = read.text !== undefined && 'inline' in read.text ? read.text.inline : '';
    const props = {
      stat: read.stat, text: () => Promise.resolve(text), bytes: () => Promise.resolve(new Uint8Array()), system: this.runtime.systemClient(system),
    } satisfies AnyViews['resource'];
    return { component, props };
  }

  /** The renderer for a fn's runs (or its kind's), if its system's build is loaded. */
  fn(fn: QualifiedName, kind?: QualifiedName): AnyRenderer | undefined {
    this.#track();
    return this.runtime.fnRenderer(fn, kind);
  }

  attachment(name: QualifiedName): AnyRenderer | undefined {
    this.#track();
    return this.runtime.attachmentRenderer(name);
  }

  input(type: QualifiedName): AnyRenderer | undefined {
    this.#track();
    return this.runtime.inputRenderer(type);
  }

  mention(provider: QualifiedName): AnyRenderer | undefined {
    this.#track();
    return this.runtime.mentionRenderer(provider);
  }

  resource(format: string): AnyRenderer | undefined {
    this.#track();
    return this.runtime.resourceViewer(format);
  }

  /** Read the version, so a lookup inside a computed or render runs again when a build loads. */
  #track(): number {
    return this.version.value;
  }

  /** The client of the system a qualified name belongs to. */
  #client(name: QualifiedName): AnyViews['input']['system'] {
    return this.runtime.systemClient(splitName(name).system);
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

