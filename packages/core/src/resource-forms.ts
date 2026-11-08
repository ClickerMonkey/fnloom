/**
 * A resource's raw content and its converted forms. The **raw** form is the bytes as served or uploaded; a **form** is
 * something made from them for people and LLMs: an LLM-ready converted version from `@aeye/resources` (markdown of an
 * html page, tables of a spreadsheet, the pages of a pdf) or one a model made (an image's description, the text in
 * it, an audio transcript, a thumbnail). Forms are kept by the raw content's hash, so the same bytes at two URIs are
 * converted once. Sectioning, the index and the LLM read a resource's primary form by default.
 */
import type { RenderMode as LibraryRenderMode } from '@aeye/resources';
import { resourceVersionSchema } from '@aeye/resources/versions';
import { z } from 'zod';
import { ActorId, ModelCallId, PageRequest, QualifiedName, RunId, type Same, SystemName, Timestamp } from './primitives.ts';
import { CONTENT_HASH, ContentRef, ConvertedKind, FormKind, ResourceUri, SectionKey } from './resources.ts';

// ─── Forms ────────────────────────────────────────────────────────────────────

/** An LLM-ready converted version, as `@aeye/resources` makes it (its schema is the library's: one source of truth). */
export const ConvertedVersion = resourceVersionSchema;
export type ConvertedVersion = z.infer<typeof ConvertedVersion>;

/** Whether a form kind is a converted version (its content is a `ConvertedVersion` as JSON). */
export function isConvertedKind(kind: FormKind): kind is ConvertedKind {
  return ConvertedKind.safeParse(kind).success;
}

/** The media type of a stored converted version: its content is the `ConvertedVersion` as JSON. */
export const CONVERTED_VERSION_MIME = 'application/vnd.harness.converted+json';

/**
 * One stored form of some raw content. Keyed by the raw hash, the kind and the converter, so a converter upgrade
 * (a new id or version in `converter`) redoes only what it touches and two readers never pay twice.
 */
export const FormRecord = z.object({
  /** The raw content's sha-256. */
  hash: z.string().regex(CONTENT_HASH),
  kind: FormKind,
  /** What made it: `@aeye/resources:htmlConverter@2`, `model:openai/gpt-4o-mini`, or a system's `fs:text@1`. */
  converter: z.string().min(1),
  /** Its bytes: a `ConvertedVersion` as JSON (`CONVERTED_VERSION_MIME`), text for descriptions and transcripts, an image for a thumbnail. */
  content: ContentRef,
  /** Its text's length and estimated tokens, so a small budget can pick an outline over the whole without reading it. */
  chars: z.number().int().min(0),
  tokens: z.number().int().min(0),
  /** The model call that made it, when one did: its cost is on that record. */
  call: ModelCallId.optional(),
  createdAt: Timestamp,
});
export type FormRecord = z.infer<typeof FormRecord>;

/** A form that does not exist yet but could be made, with what making it would use. */
export const FormOffer = z.object({ kind: FormKind, model: z.string().optional(), estimate: z.number().min(0).optional() });
export type FormOffer = z.infer<typeof FormOffer>;

// ─── Where a resource came from ───────────────────────────────────────────────

/**
 * Where a resource came from. System resources are served by their system (the hub keeps a snapshot of the raw
 * content and the forms); the others are hub resources under `hub://resources/`, whose raw content lives only in
 * the hub's content store.
 */
export const ResourceSource = z.discriminatedUnion('from', [
  /** `served: text` when the system sent its own text and no bytes: that text is the raw content and is not converted again. */
  z.object({ from: z.literal('system'), system: SystemName, served: z.enum(['bytes', 'text']).optional() }),
  z.object({ from: z.literal('upload'), by: ActorId }),
  z.object({ from: z.literal('web'), url: z.url(), finalUrl: z.url().optional(), fetchedAt: Timestamp, rendered: z.boolean() }),
  z.object({ from: z.literal('run'), run: RunId, fn: QualifiedName }),
]);
export type ResourceSource = z.infer<typeof ResourceSource>;
export type ResourceSourceKind = ResourceSource['from'];

/** Every kind of source, for filters: exactly `ResourceSource`'s kinds (a new one fails to compile here until listed). */
export const RESOURCE_SOURCES = ['system', 'upload', 'web', 'run'] as const;
true satisfies Same<(typeof RESOURCE_SOURCES)[number], ResourceSourceKind>;

/**
 * When a fetched html page is run in a headless browser first: only when it looks script-built (`auto`), always, or
 * never. Exactly `@aeye/resources`' render modes (a mode added there fails to compile here until it is listed).
 */
export const RENDER_MODES = ['auto', 'always', 'never'] as const;
true satisfies Same<(typeof RENDER_MODES)[number], LibraryRenderMode>;
export const RenderMode = z.enum(RENDER_MODES);
export type RenderMode = z.infer<typeof RenderMode>;

/** The root every hub resource lives under. */
export const HUB_RESOURCE_ROOT = 'hub://resources/';

// ─── Families: how resources are grouped, shown and converted ────────────────

/** What sort of thing a resource is, for grouping, icons and choosing a viewer. */
export const FORMAT_FAMILIES = ['document', 'code', 'image', 'table', 'audio', 'video', 'web', 'data', 'archive', 'folder', 'other'] as const;
export const FormatFamily = z.enum(FORMAT_FAMILIES);
export type FormatFamily = z.infer<typeof FormatFamily>;

/** Formats by family. A format not listed is `other`. The one table the hub's facets and the web's viewers read. */
/**
 * The formats that are code: every one of `@aeye/resources`' `CODE_TYPES` (the hub checks it at compile time) and the
 * few more the hub reads as code. Grouped as `code` and drawn with the highlighter.
 */
export const CODE_FORMATS = [
  'typescript', 'javascript', 'jsx', 'tsx', 'vue', 'python', 'ruby', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'php', 'swift', 'kotlin', 'scala',
  'css', 'scss', 'less', 'shell', 'sql', 'dockerfile', 'graphql', 'lua', 'r', 'dart',
] as const;
export type CodeFormat = (typeof CODE_FORMATS)[number];

export const FORMAT_FAMILY: Readonly<Record<string, FormatFamily>> = {
  markdown: 'document', text: 'document', pdf: 'document', docx: 'document', pptx: 'document', rtf: 'document', odt: 'document', notebook: 'document',
  html: 'web',
  json: 'data', jsonl: 'data', yaml: 'data', toml: 'data', xml: 'data', ini: 'data',
  csv: 'table', tsv: 'table', excel: 'table', ods: 'table',
  image: 'image', svg: 'image', mermaid: 'image',
  audio: 'audio', video: 'video',
  zip: 'archive',
  folder: 'folder',
  ...Object.fromEntries(CODE_FORMATS.map((format) => [format, 'code'] as const)),
};

/** The family of a format (`other` for one not in `FORMAT_FAMILY`), with the mime type's major type as a fallback. */
export function familyOf(format: string | undefined, mime?: string): FormatFamily {
  const known = format === undefined ? undefined : FORMAT_FAMILY[format];
  if (known !== undefined) { return known; }
  const major = mime?.split('/')[0];
  return major === 'image' || major === 'audio' || major === 'video' ? major : 'other';
}

// ─── Browsing ─────────────────────────────────────────────────────────────────

/** How the resource browser groups: by family, by source (system, instance, uploads, web domain, fn), by folder path, or by date. */
export const RESOURCE_GROUPINGS = ['type', 'source', 'path', 'date'] as const;
export const ResourceGrouping = z.enum(RESOURCE_GROUPINGS);
export type ResourceGrouping = z.infer<typeof ResourceGrouping>;

/** One group value and how many resources have it (computed by the hub, so groups never need every row). */
export const ResourceFacet = z.object({ value: z.string(), label: z.string(), count: z.number().int().min(0) });
export type ResourceFacet = z.infer<typeof ResourceFacet>;

/** What the resource browser asks for: a page, narrowed by filters, with facets for one grouping. */
export const ResourceQuery = PageRequest.extend({
  search: z.string().optional(),
  system: SystemName.optional(),
  family: FormatFamily.optional(),
  source: z.enum(RESOURCE_SOURCES).optional(),
  /** A URI prefix (a folder). */
  under: z.string().optional(),
  /** Resources that have (or lack, with `missing`) a form. */
  form: FormKind.optional(),
  missing: FormKind.optional(),
  group: ResourceGrouping.optional(),
  /** Only the resources in one group value (`group` must be set). */
  in: z.string().optional(),
});
export type ResourceQuery = z.infer<typeof ResourceQuery>;

// ─── Hub fn shapes ────────────────────────────────────────────────────────────

/** `hub/resource_outline`: the resource whose sections to list. */
export const ResourceOutlineArgs = z.object({ uri: ResourceUri });
export type ResourceOutlineArgs = z.infer<typeof ResourceOutlineArgs>;

/** `hub/resource_send`: a resource (or one section of it) to show the model at its next step. */
export const ResourceSendArgs = z.object({ uri: ResourceUri, section: SectionKey.optional() });
export type ResourceSendArgs = z.infer<typeof ResourceSendArgs>;

/** `hub/resource_read`: a resource's text in one form, a section of it, or a window of it, for a small budget. */
export const ResourceReadArgs = z.object({
  uri: ResourceUri,
  /** The form to read; its primary form when absent. `raw` reads the raw text (for text formats). */
  form: z.union([FormKind, z.literal('raw')]).optional(),
  section: SectionKey.optional(),
  offset: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(1).max(200_000).optional(),
  /** For tables: a range of rows of one table. */
  rows: z.object({ table: z.string(), from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
});
export type ResourceReadArgs = z.infer<typeof ResourceReadArgs>;

/** What reading gives: the text, where it sits in the whole, and which forms there are. */
export const ResourceReadResult = z.object({
  uri: ResourceUri,
  form: z.union([FormKind, z.literal('raw')]),
  text: z.string(),
  offset: z.number().int().min(0),
  total: z.number().int().min(0),
  truncated: z.boolean(),
  forms: z.array(FormKind),
  offers: z.array(FormOffer),
});
export type ResourceReadResult = z.infer<typeof ResourceReadResult>;

/** `hub/resource_import`: a URL or uploaded content into a hub resource. */
export const ResourceImportArgs = z.union([
  z.object({ url: z.url(), render: RenderMode.optional(), name: z.string().optional() }),
  z.object({ content: ContentRef, name: z.string().min(1), path: z.string().optional() }),
]);
export type ResourceImportArgs = z.infer<typeof ResourceImportArgs>;
