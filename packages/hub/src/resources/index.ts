/**
 * The resources module (resources lane): the hub's own resources, raw content and converted forms, reading any form
 * for people and LLMs, resources as message content, and context made from resources or written as memory.
 *
 * - **Raw content** of every resource the hub has read lives in the content store (`api`'s `ContentStore` over an
 *   ayepi `FileStore`): files under the data folder by default, or the hub's database (`HARNESS_CONTENT_AT=database`,
 *   `SqliteFiles` in `sqlite-files.ts`, beside the store but outside `HUB_TABLES`; `openContentFiles` chooses).
 *   Hub resources (`hub://resources/…`: uploads, fetched pages, fn outputs) live only there; system resources keep a
 *   snapshot of what their system served, refetched when its version changes.
 * - **Forms** are made once per raw hash, kind and converter (`FormRecord`), by one job per key at a time, with the
 *   shared `@aeye/resources` registry (`Converters`) or a model through the hub (`FormModels`: descriptions, text in
 *   images, transcripts). Sectioning and the index read the primary form (the router's `primary`).
 * - **Context** made from a resource is one item per section (a `next` chain for long ones) under a resource-level
 *   parent, with `about` links back, named so re-running updates instead of duplicating. Memory is written the same
 *   way, under `memory/`.
 *
 * Every operation here is what both a web endpoint (`resourcesSlice`, `contextSlice`) and a hub fn
 * (`hub/resource_read`, `hub/remember`, …) run, so the chat LLM sees and does what the browser does. Tunables are the
 * `resourcesEnv` slice (`env.ts`).
 */
import type {
  ActorId, ContentRef, ContextFromResourceArgs, ContextFromResourceResult, ContextItemView, ContextLink, ContextQuery, ContextRecord, ConvertedVersion,
  DeclarableRelation, FormKind, FormRecord, LinkTarget, LlmContentPart, MadeFormKind, ModelCallId, ModelInfo, Page, QualifiedName, RememberArgs, UpdateMemoryArgs,
  ResourceForms, ResourceImportArgs, ResourcePage, ResourceQuery, ResourceReadArgs, ResourceReadResult, ResourceRecord, ResourceUri, RunId, Section, SectionKey,
  SessionId,
} from '@harness/core';
import type { PrimaryText } from '../index/index.ts';

/** Who asks, so reads and writes are checked and attributed (and model-made forms are charged to the run). */
export interface Asking {
  readonly actor: ActorId;
  readonly run?: RunId;
  readonly session?: SessionId;
}

/** The hub's own resources under `hub://resources/`. */
export interface ResourceLibrary {
  /** A URL (through the web system when it is connected, a plain fetch otherwise) or uploaded content into a hub resource. */
  import(args: ResourceImportArgs, who: Asking): Promise<ResourceRecord>;
  /** A fn's output (an attachment, a generated image, a recording) kept as a hub resource. */
  keep(input: { content: ContentRef; name: string; run: RunId; fn: QualifiedName }): Promise<ResourceRecord>;
  rename(uri: ResourceUri, name: string, who: Asking): Promise<ResourceRecord>;
  /** Hub resources only; refused with the count of what still refers to it unless nothing does. */
  remove(uri: ResourceUri, who: Asking): Promise<{ deleted: boolean; referencedBy: number }>;
  /** Every resource the hub knows (hub and system ones), with the facets of one grouping. */
  browse(query: ResourceQuery, who: Asking): Promise<ResourcePage>;
}

/** Converting raw content with `@aeye/resources` (the shared registry). A seam for tests. */
export interface Converters {
  /** The resource type (`markdown`, `pdf`, `excel`) of a location and media type, as the registry detects it. */
  typeOf(location: string, mime?: string): string | undefined;
  /**
   * The ids of the converters that would convert a type now, first tried first. A stored converted form made by
   * another converter (an older version of one) is out of date and is made again.
   */
  current(type: string): readonly string[];
  /** The LLM-ready version of some bytes named `name` at `location`, or undefined when the raw form is LLM-ready already. */
  convert(input: { bytes: Uint8Array; type: string; location: string; name: string; mime?: string }): Promise<{ version: ConvertedVersion; converter: string } | undefined>;
  /** Sections of a converted version (`registry.sectionVersion`), each marked with the version's kind as its form. */
  sections(version: ConvertedVersion): Section[];
}

/** What a model-made form is made from: the raw content, its bytes and its name. */
export interface MadeFormInput {
  readonly raw: ContentRef;
  readonly bytes: Uint8Array;
  readonly name: string;
}

/** A model-made form's text, the model that made it, and its call record when there is one. */
export interface MadeForm {
  readonly text: string;
  readonly model: string;
  readonly call?: ModelCallId;
}

/** Forms a model makes through the hub (descriptions, text in images, transcripts), each a recorded model call. A seam for tests. */
export interface FormModels {
  /** The model a kind of form would be made with now, or undefined when its role is off (or the kind isn't made by a model here). */
  model(kind: MadeFormKind): Promise<string | undefined>;
  /** Make one. Refused when the role is off or the content isn't what the kind reads (an image, a recording). */
  make(kind: MadeFormKind, input: MadeFormInput, who: Asking, signal?: AbortSignal): Promise<MadeForm>;
}

/** Forms of raw content: made once per key, looked up by hash. */
export interface FormService {
  /**
   * A resource's record with its raw content in the store: a hub resource as it is, a system resource's snapshot
   * fetched again from its system when missing or its version changed.
   */
  snapshot(uri: ResourceUri, who: Asking): Promise<ResourceRecord & { readonly raw: ContentRef }>;
  /** A resource's record, the forms made from its current raw content, and the ones that could be made. */
  forms(uri: ResourceUri, who: Asking): Promise<ResourceForms>;
  /** A form, made now if it doesn't exist (two callers wait on one job). Model-made forms are charged to `who.run`. */
  ensure(uri: ResourceUri, kind: FormKind, who: Asking): Promise<FormRecord>;
  /**
   * The text the LLM, sectioning and the index read: the primary form's (made now when it is a converted one, or a
   * model-made one when `make` allows), or the raw text.
   */
  primary(uri: ResourceUri, who: Asking, options?: { make?: boolean; signal?: AbortSignal }): Promise<PrimaryText>;
  /** The text of a form (a converted version's text, a description, a transcript). */
  text(form: FormRecord): Promise<string>;
  /** A converted form's version, parsed with its schema. */
  version(form: FormRecord): Promise<ConvertedVersion>;
}

/** Reading for people and LLMs: any form, a section, a window, rows of a table. */
export interface ResourceReader {
  read(args: ResourceReadArgs, who: Asking): Promise<ResourceReadResult>;
  /** The sections of the primary form, without their text, for choosing what to read on a small budget. */
  outline(uri: ResourceUri, who: Asking): Promise<Section[]>;
  /** A presigned download of the raw content or one form. */
  download(uri: ResourceUri, form: FormKind | undefined, who: Asking): Promise<{ url: string; mime: string; size: number }>;
}

/** What message content needs to know of the model chosen: its id (for logs) and what it takes. */
export type ContentModel = Pick<ModelInfo, 'id' | 'capabilities'>;

/**
 * A resource as message content for the model actually chosen: an image as an image part only for a vision model,
 * else its description (made once); a pdf as a file part only when the model takes files, else its text; audio the
 * same with its transcript; text formats always as text. One section is always its text in the primary form. Never
 * fails: the worst case is one text part.
 */
export interface MessageContent {
  parts(uri: ResourceUri, model: ContentModel, who: Asking, options?: { section?: SectionKey }): Promise<LlmContentPart[]>;
}

/** Context made from resources, memory, and the context list as people browse it. */
export interface ContextLibrary {
  fromResource(args: ContextFromResourceArgs, who: Asking): Promise<ContextFromResourceResult>;
  remember(args: RememberArgs, who: Asking): Promise<{ name: QualifiedName }>;
  /** Edit a memory its author wrote: text, title and any context option (tied fns are its `decl.fns`). */
  update(args: UpdateMemoryArgs, who: Asking): Promise<{ name: QualifiedName }>;
  /** Disable a memory (memory only; system context is turned off by its system or an admin). */
  forget(name: QualifiedName, who: Asking): Promise<boolean>;
  list(query: ContextQuery, who: Asking): Promise<Page<ContextRecord>>;
  item(name: QualifiedName, who: Asking): Promise<ContextItemView>;
  /** A person's link from a context item (`linkContext`). */
  link(input: { from: QualifiedName; to: LinkTarget; relation: DeclarableRelation; weight: number }, who: Asking): Promise<ContextLink>;
  /** Remove a link a person drew (`unlinkContext`). */
  unlink(key: Pick<ContextLink, 'from' | 'toKey' | 'relation'>, who: Asking): Promise<boolean>;
  /** A resource's sections changed: snapshot context made from them turns stale (live context reads the new text). */
  sectionsChanged(uri: ResourceUri, changed: readonly SectionKey[]): Promise<number>;
}

/** The resources module's services (`HubServices.resources`). */
export interface ResourceServices {
  readonly library: ResourceLibrary;
  readonly forms: FormService;
  readonly reader: ResourceReader;
  readonly content: MessageContent;
  readonly context: ContextLibrary;
}
