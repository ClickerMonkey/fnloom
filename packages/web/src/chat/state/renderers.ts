/**
 * Systems' renderers in the chat. The hub lists each system's client build in the capabilities (`clients`); this
 * loads each once per build hash into the SDK's `ClientRuntime`, which looks renderers up by fn, kind, attachment,
 * input type, mention provider and resource format. Renderers talk back through a `ClientBridge` made of the open
 * thread (actions, form submissions and live delivery state) and the capabilities (whether a system is online).
 *
 * A build that fails to load is marked failed, and its fns fall back to the default card.
 */
import { SystemName, type ChatCapabilities, type DeliveryId, type QualifiedName, type ResourceRead } from '@harness/core';
import { ClientRuntime, type AnyRenderer, type ClientBridge } from '@harness/sdk/client';
import { shallowRef } from 'vue';
import type { RenderView } from '../components/types.ts';
import type { ThreadStore } from './thread.ts';

/**
 * A system's viewer for a resource, mounted with the resource's stat and its text (inline text only; bytes are not
 * fetched here). Undefined when no system registered a viewer for its format, so the default viewer draws it.
 */
export function resourceRenderView(renderers: Pick<RendererHub, 'resource'>, read: ResourceRead | undefined): RenderView | undefined {
  const format = read?.stat.format;
  const component = format === undefined ? undefined : renderers.resource(format);
  if (component === undefined || read === undefined) { return undefined; }
  const text = read.text !== undefined && 'inline' in read.text ? read.text.inline : '';
  return { component, props: { stat: read.stat, text: () => Promise.resolve(text), bytes: () => Promise.resolve(new Uint8Array()) } };
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

