/** Resources, sections, content refs and links: content that systems serve at absolute URIs. */
import { RESOURCE_VERSION_KINDS } from '@aeye/resources/versions';
import { z } from 'zod';
import { RunId, Timestamp } from './primitives.ts';

/** An absolute URI. A system serves the URIs under its roots. */
export const ResourceUri = z.templateLiteral([z.string().regex(/^[a-z][a-z0-9+.-]*$/), '://', z.string()]);
export type ResourceUri = z.infer<typeof ResourceUri>;

/** A stable section key, made from structure (the heading path, the symbol name) so it survives content moving. */
export const SectionKey = z.string().min(1).brand<'SectionKey'>();
export type SectionKey = z.infer<typeof SectionKey>;

/** A content hash: sha-256 of the bytes, as lowercase hex. The one statement of the pattern; gin types and checks use it too. */
export const CONTENT_HASH_PATTERN = '^[0-9a-f]{64}$';
/** `CONTENT_HASH_PATTERN` as a regular expression. */
export const CONTENT_HASH = new RegExp(CONTENT_HASH_PATTERN);

/** Content moved by reference, fetched in chunks when needed. Keeps every message small. */
export const ContentRef = z.object({
  /** sha-256 of the bytes, hex. */
  hash: z.string().regex(CONTENT_HASH),
  size: z.number().int().min(0),
  mime: z.string(),
});
export type ContentRef = z.infer<typeof ContentRef>;

/** A place a system offers resources from, initially a folder. */
export const ResourceRoot = z.object({
  uri: ResourceUri,
  name: z.string(),
  description: z.string(),
  /** Index everything, only what gets opened, or nothing. */
  index: z.enum(['all', 'on-read', 'none']),
  /** Globs to leave out. */
  ignore: z.array(z.string()),
  watch: z.boolean(),
});
export type ResourceRoot = z.infer<typeof ResourceRoot>;

/** What is known about a resource without reading it. Folders, files and pages are all resources. */
export const ResourceStat = z.object({
  uri: ResourceUri,
  name: z.string(),
  type: z.enum(['folder', 'file', 'page', 'record', 'other']),
  mime: z.string().optional(),
  /** Used to pick a sectioner and a viewer: `markdown`, `typescript`, `pdf`. */
  format: z.string().optional(),
  size: z.number().int().min(0).optional(),
  modifiedAt: Timestamp.optional(),
  /** Changes whenever the content does. */
  version: z.string(),
});
export type ResourceStat = z.infer<typeof ResourceStat>;

/** A link between resources: a folder's child, a code import, a page link. */
export const ResourceLink = z.object({
  /** Absolute, when the system could resolve it. */
  uri: ResourceUri.optional(),
  /** As written: `./foo`, `react`. */
  raw: z.string(),
  kind: z.enum(['child', 'import', 'link', 'embed', 'external']),
  title: z.string().optional(),
});
export type ResourceLink = z.infer<typeof ResourceLink>;

/** What the hub asks for when reading. */
export const ReadWant = z.enum(['links', 'text', 'bytes']);
export type ReadWant = z.infer<typeof ReadWant>;

/** Text of a read: small text inline, large text by ref. */
export const ReadText = z.union([z.object({ inline: z.string() }), z.object({ ref: ContentRef })]);
export type ReadText = z.infer<typeof ReadText>;

/** A read. A system may include more than was asked for if it had it anyway. */
export const ResourceRead = z.object({
  stat: ResourceStat,
  links: z.array(ResourceLink).optional(),
  /** Converted text (markdown for documents). */
  text: ReadText.optional(),
  bytes: ContentRef.optional(),
});
export type ResourceRead = z.infer<typeof ResourceRead>;

/** The kinds of LLM-ready converted version `@aeye/resources` makes, read off the library's schema. */
export const ConvertedKind = z.enum(RESOURCE_VERSION_KINDS);
export type ConvertedKind = z.infer<typeof ConvertedKind>;

/** The forms a model makes through the hub provider, each a `ModelCall` with its cost. */
export const MADE_FORM_KINDS = ['description', 'ocr', 'transcript', 'thumbnail'] as const;
export const MadeFormKind = z.enum(MADE_FORM_KINDS);
export type MadeFormKind = z.infer<typeof MadeFormKind>;

/** Every kind of form made from a resource's raw content: the converted versions, then the made ones. See `resource-forms.ts`. */
export const FormKind = z.enum([...RESOURCE_VERSION_KINDS, ...MADE_FORM_KINDS]);
export type FormKind = z.infer<typeof FormKind>;

/** A stable piece of a resource. */
export const Section = z.object({
  key: SectionKey,
  /** Its place in the outline. */
  path: z.array(z.string()),
  title: z.string(),
  /** Character offsets in the text at this version. */
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  /** What gets embedded: the text plus its headings and the resource name. Default: built by the hub. */
  embedText: z.string().optional(),
  /** The form its offsets are into; the raw text when absent. */
  form: FormKind.optional(),
});
export type Section = z.infer<typeof Section>;

/** A change seen by a watch. */
export const ResourceChange = z.object({
  uri: ResourceUri,
  change: z.enum(['added', 'changed', 'removed']),
  version: z.string().optional(),
});
export type ResourceChange = z.infer<typeof ResourceChange>;

/** Which resources a sectioner is for. */
export const SectionMatch = z.object({
  format: z.string().optional(),
  mime: z.string().optional(),
  /** Glob over the URI. */
  glob: z.string().optional(),
  /** The form a sectioner reads (`table` for any spreadsheet's tables). */
  form: FormKind.optional(),
});
export type SectionMatch = z.infer<typeof SectionMatch>;

/** A link attachment: to a resource (or one of its sections), a URL, stored content, or a run. */
export const Link = z.union([
  z.object({ resource: ResourceUri, section: SectionKey.optional(), title: z.string().optional() }),
  z.object({ url: z.url(), title: z.string() }),
  z.object({ file: ContentRef, title: z.string() }),
  z.object({ run: RunId, title: z.string() }),
]);
export type Link = z.infer<typeof Link>;

/** One hit of a resource search. */
export const ResourceHit = z.object({
  uri: ResourceUri,
  section: SectionKey.optional(),
  title: z.string(),
  preview: z.string(),
  score: z.number(),
});
export type ResourceHit = z.infer<typeof ResourceHit>;
