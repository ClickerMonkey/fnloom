/**
 * One opened resource, as the viewer shows it: what is known about it (its stat, the forms the hub has made and
 * could make, its links), the viewer plan for it (`viewerFor`, with the systems' viewers for its format), the mode
 * shown, and what each mode reads, loaded once per thing read (the raw text, a presigned URL of the raw bytes, a
 * form's text, a converted version's structure). Making a form (describe, transcribe, convert) is a task that loads
 * the new form when it is made. A resource the hub's library doesn't hold (or a hub without one yet) is read from its
 * system instead (`resource`), with its text and links. Live: a `resource` change for the opened URI loads its forms
 * again.
 */
import {
  ConvertedVersion, type ContextFromResourceResult, type FormKind, type FormOffer, type FormRecord, type ResourceLink, type ResourceReadResult,
  type ResourceRecord, type ResourceStat, type ResourceUri, type SectionKey,
} from '@harness/core';
import type { ContractShape, ResourceView, SystemClient } from '@harness/sdk';
import type { SystemResourceViewer } from '@harness/sdk/client';
import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import { Loaded, Task } from '../../state/loaded.ts';
import type { FetchUrl, ResourceChange, ResourcesApi } from '../api/resources.ts';
import { modeOf, readKey, viewerFor, type ModeRead, type SystemViewerInfo, type ViewerPlan, type ViewMode } from '../logic/viewers.ts';

/** Read a version counter, so the computed or render reading it runs again when it is bumped. */
function track(version: Readonly<Ref<number>>): number {
  return version.value;
}

/** The largest text read in one go; a longer text says it was cut, with how long it is. */
export const MAX_TEXT = 200_000;

/** The systems' viewers, from the chat's loaded client builds. */
export interface SystemViewers {
  /** Every system viewer for a format: `replace` ones draw the Preview, `tab` ones add a mode. */
  viewers(format: string): readonly SystemResourceViewer[];
  /** What a system's viewer gets as `system`. */
  client(system: string): SystemClient<ContractShape>;
  /** Bumped when a client build loads, so a plan made before it is made again. */
  readonly version: Readonly<Ref<number>>;
}

/** No system viewers (tests, and pages before the chat has loaded any). */
export const NO_SYSTEM_VIEWERS: SystemViewers = { viewers: () => [], client: () => { throw new Error('No system clients.'); }, version: ref(0) };

/** What the viewer needs. */
export interface ViewerDeps {
  readonly api: Pick<ResourcesApi, 'forms' | 'read' | 'convert' | 'download' | 'systemRead' | 'contextFrom'>;
  readonly fetch: FetchUrl;
  readonly systems: SystemViewers;
}

/** What is known about the opened resource, and where from. */
export interface Opened {
  readonly stat: ResourceStat;
  /** The hub's record, when its library holds the resource. */
  readonly record: ResourceRecord | undefined;
  readonly forms: readonly FormRecord[];
  readonly offers: readonly FormOffer[];
  readonly links: readonly ResourceLink[];
  /** `library`: the hub's resource library (every form, presigned downloads); `system`: read from its system (text and links only). */
  readonly from: 'library' | 'system';
  /** The text the system gave with its read (`system` only). */
  readonly text: string | undefined;
}

/** A presigned download. */
export interface Download {
  readonly url: string;
  readonly mime: string;
  readonly size: number;
}

/** What a mode's read loaded. */
export type Read =
  | { readonly as: 'text'; readonly result: ResourceReadResult }
  | { readonly as: 'url'; readonly download: Download }
  | { readonly as: 'version'; readonly version: ConvertedVersion };

/** One opened resource. */
export class ResourceViewerStore {
  readonly #deps: ViewerDeps;
  readonly uri = shallowRef<ResourceUri | undefined>(undefined);
  readonly section = shallowRef<SectionKey | undefined>(undefined);
  readonly opened = new Loaded<Opened>();
  /** The mode asked for (from the URL); the plan's first mode when it names none of them. */
  readonly asked = ref<string | undefined>(undefined);
  readonly #reads = new Map<string, Loaded<Read>>();
  /** Bumped when the reads are forgotten (another resource, a change), so what looked one up looks again. */
  readonly #readsVersion = ref(0);
  readonly making = new Task();
  readonly contexting = new Task();

  /** The viewer plan: modes in order, from the stat, the forms and the systems' viewers. */
  readonly plan: ComputedRef<ViewerPlan | undefined>;
  /** The mode shown. */
  readonly mode: ComputedRef<ViewMode | undefined>;
  /** The systems' viewers for the format, with the plan's view of them. */
  readonly systemViewers: ComputedRef<readonly SystemResourceViewer[]>;

  constructor(deps: ViewerDeps) {
    this.#deps = deps;
    this.systemViewers = computed(() => {
      track(deps.systems.version);
      const format = this.opened.value.value?.stat.format;
      return format === undefined ? [] : deps.systems.viewers(format);
    });
    this.plan = computed(() => {
      const opened = this.opened.value.value;
      if (opened === undefined) { return undefined; }
      const systems: SystemViewerInfo[] = this.systemViewers.value.map((v) => ({ system: v.system, mode: v.mode, label: v.label }));
      return viewerFor(opened.stat, opened.forms.map((f) => f.kind), opened.offers, systems);
    });
    this.mode = computed(() => (this.plan.value === undefined ? undefined : modeOf(this.plan.value, this.asked.value)));
  }

  /** Open a resource (or the same one again, quietly, to refresh what is shown). */
  async open(uri: ResourceUri, section?: SectionKey): Promise<void> {
    const same = this.uri.value === uri;
    if (!same) { this.#reads.clear(); this.#readsVersion.value++; }
    this.uri.value = uri;
    this.section.value = section;
    await this.opened.load(() => this.#fetch(uri), "Couldn't open this resource.", same && this.opened.value.value !== undefined);
  }

  close(): void {
    this.uri.value = undefined;
    this.opened.reset();
    this.#reads.clear();
    this.#readsVersion.value++;
  }

  /** The library's forms and offers, or the system's read when the library doesn't hold it. */
  async #fetch(uri: ResourceUri): Promise<Opened> {
    try {
      const found = await this.#deps.api.forms.call({ uri });
      return { stat: found.record.stat, record: found.record, forms: found.forms, offers: found.offers, links: found.record.links, from: 'library', text: undefined };
    } catch (libraryError) {
      try {
        const read = await this.#deps.api.systemRead.call({ uri, want: ['text', 'links'] });
        const text = read.text !== undefined && 'inline' in read.text ? read.text.inline : undefined;
        return { stat: read.stat, record: undefined, forms: [], offers: [], links: read.links ?? [], from: 'system', text };
      } catch {
        throw libraryError;
      }
    }
  }

  /** The load of what a read needs, made the first time it is asked for. */
  load(read: ModeRead): Loaded<Read> | undefined {
    track(this.#readsVersion);
    const uri = this.uri.value;
    const opened = this.opened.value.value;
    if (read.as === 'none' || uri === undefined || opened === undefined) { return undefined; }
    const key = readKey(read);
    const known = this.#reads.get(key);
    if (known !== undefined) { return known; }
    const loaded = new Loaded<Read>();
    this.#reads.set(key, loaded);
    void loaded.load(() => this.#read(uri, opened, read), read.as === 'url' ? "Couldn't load this file." : "Couldn't read this.");
    return loaded;
  }

  async #read(uri: ResourceUri, opened: Opened, read: Exclude<ModeRead, { as: 'none' }>): Promise<Read> {
    switch (read.as) {
      case 'text': {
        if (opened.from === 'system') {
          const text = opened.text ?? '';
          return { as: 'text', result: { uri, form: 'raw', text, offset: 0, total: text.length, truncated: false, forms: [], offers: [] } };
        }
        return { as: 'text', result: await this.#deps.api.read.call({ uri, form: read.form, maxChars: MAX_TEXT }) };
      }
      case 'url': {
        if (opened.from === 'system') { throw new Error('This system resource has no download.'); }
        return { as: 'url', download: await this.#deps.api.download.call({ uri }) };
      }
      case 'version': {
        const download = await this.#deps.api.download.call({ uri, form: read.form });
        const response = await this.#deps.fetch(download.url);
        if (!response.ok) { throw new Error(`The download answered ${response.status}.`); }
        return { as: 'version', version: ConvertedVersion.parse(await response.json()) };
      }
    }
  }

  /** Load a read again (after it failed). */
  retry(read: ModeRead): void {
    this.#reads.delete(readKey(read));
    this.#readsVersion.value++;
  }

  /** The text a mode read, once loaded. */
  text(read: ModeRead): ResourceReadResult | undefined {
    const value = this.load(read)?.value.value;
    return value?.as === 'text' ? value.result : undefined;
  }

  /** The presigned download a mode read, once loaded. */
  download(read: ModeRead): Download | undefined {
    const value = this.load(read)?.value.value;
    return value?.as === 'url' ? value.download : undefined;
  }

  /** The converted version a mode read, once loaded. */
  version(read: ModeRead): ConvertedVersion | undefined {
    const value = this.load(read)?.value.value;
    return value?.as === 'version' ? value.version : undefined;
  }

  /** A presigned download of the raw content or a form (for the download button). */
  async downloadUrl(form?: FormKind): Promise<Download | undefined> {
    const uri = this.uri.value;
    if (uri === undefined) { return undefined; }
    const result = await this.making.run(() => this.#deps.api.download.call({ uri, ...(form === undefined ? {} : { form }) }), "Couldn't start the download.");
    return result.ok ? result.value : undefined;
  }

  /** Make a form now; its tab shows it once it is made. */
  async make(kind: FormKind): Promise<boolean> {
    const uri = this.uri.value;
    if (uri === undefined) { return false; }
    const made = await this.making.run(() => this.#deps.api.convert.call({ uri, kind }), "Couldn't make that.");
    if (made.ok) { await this.open(uri, this.section.value); }
    return made.ok;
  }

  /** Make context from the resource (one item per section, updated on a rerun). */
  async makeContext(): Promise<ContextFromResourceResult | undefined> {
    const uri = this.uri.value;
    if (uri === undefined) { return undefined; }
    const made = await this.contexting.run(() => this.#deps.api.contextFrom.call({ uri, copy: 'live' }), "Couldn't make context from this.");
    return made.ok ? made.value : undefined;
  }

  /** A resource changed: when it is the opened one, load its forms again and forget what its modes read. */
  changed(change: ResourceChange): void {
    if (change.uri !== this.uri.value) { return; }
    this.#reads.clear();
    this.#readsVersion.value++;
    void this.open(change.uri, this.section.value);
  }

  /**
   * The props a system's viewer is mounted with: the stat, the section, the forms, the text of the raw content or a
   * form, the raw bytes, and its system's client.
   */
  systemView(system: string): (ResourceView & { readonly system: SystemClient<ContractShape> }) | undefined {
    const opened = this.opened.value.value;
    const uri = this.uri.value;
    if (opened === undefined || uri === undefined) { return undefined; }
    const deps = this.#deps;
    return {
      stat: opened.stat,
      ...(this.section.value === undefined ? {} : { section: this.section.value }),
      forms: opened.forms.map((f) => f.kind),
      text: async (form?: FormKind) => {
        if (opened.from === 'system') { return opened.text ?? ''; }
        return (await deps.api.read.call({ uri, form: form ?? 'raw', maxChars: MAX_TEXT })).text;
      },
      bytes: async () => {
        if (opened.from === 'system') { return new Uint8Array(); }
        const download = await deps.api.download.call({ uri });
        return new Uint8Array(await (await deps.fetch(download.url)).arrayBuffer());
      },
      system: deps.systems.client(system),
    };
  }
}
