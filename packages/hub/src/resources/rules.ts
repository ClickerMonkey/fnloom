/**
 * The pure rules the resources module follows: which form is a resource's primary one, which model-made forms a
 * resource can have, how text is sized for budgets, how raw bytes are read as text, and how hub resources are named.
 * Every rule is one function here, so the browser badges, the reader, sectioning and the LLM agree.
 */
import {
  familyOf, FormKind, HUB_RESOURCE_ROOT, isConvertedKind, linkTargetKey, ResourceUri, type FormatFamily, type MadeFormKind, type ResourceRecord, type ResourceStat,
} from '@harness/core';

/** Characters per token for sizing forms before any model is chosen (a model-free estimate; models refine it). */
export const CHARS_PER_TOKEN = 4;

/** The estimated tokens of a text, for choosing what fits a small budget without reading it. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The key a link to a whole resource is stored under (`resource:<uri>`), for counting what refers to it. */
export function resourceLinkKey(uri: ResourceUri): string {
  return linkTargetKey({ kind: 'resource', uri });
}

/** Whether a URI is one of the hub's own resources (`hub://resources/…`). */
export function isHubUri(uri: string): boolean {
  return uri.startsWith(HUB_RESOURCE_ROOT);
}

/** A resource's family, from its stat. */
export function familyOfStat(stat: ResourceStat): FormatFamily {
  return familyOf(stat.format, stat.mime);
}

/** The model-made forms a resource of a family can have, best first. */
export function madeKindsFor(family: FormatFamily): readonly MadeFormKind[] {
  switch (family) {
    case 'image': return ['description', 'ocr'];
    case 'audio': case 'video': return ['transcript'];
    case 'document': case 'code': case 'table': case 'web': case 'data': case 'archive': case 'folder': case 'other': return [];
  }
}

/**
 * The form sectioning, the index and the LLM read by default, of those that exist: the converted version (markdown
 * for pages and documents, tables for spreadsheets, pages for a pdf, pretty json), else the best model-made form of
 * its family (an image's description, a recording's transcript), else none (the raw text).
 */
export function primaryOf(family: FormatFamily, forms: readonly FormKind[]): FormKind | undefined {
  return forms.find(isConvertedKind) ?? madeKindsFor(family).find((kind) => forms.includes(kind));
}

/** Leading bytes checked for a NUL byte, the sign of binary content. */
const SNIFF_BYTES = 8_000;

/** Raw bytes as text, or undefined when they look binary (a NUL byte near the start) or aren't UTF-8. */
export function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) { return undefined; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A name made safe to be one segment of a hub resource's path: no slashes, no control characters, never empty. */
export function safeSegment(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, '-').replace(/\p{Cc}/gu, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'resource' : cleaned;
}

/** A path made of safe segments (`docs/notes` stays, `../x` loses its `..`). */
export function safePath(path: string): string {
  return path.split(/[\\/]+/).filter((part) => part !== '' && part !== '.' && part !== '..').map(safeSegment).join('/');
}

/** A hub resource's URI from its folder path and name. */
export function hubUri(path: string, name: string): ResourceUri {
  const folder = safePath(path);
  return ResourceUri.parse(`${HUB_RESOURCE_ROOT}${folder === '' ? '' : `${folder}/`}${encodeURIComponent(safeSegment(name))}`);
}

/** The day a time falls on, as `2026-11-07` (UTC), for upload folders. */
export function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Query parameters that carry credentials, left out of the names and descriptions made from a URL. */
const CREDENTIAL_PARAMS = /^(?:key|api[-_]?key|token|access[-_]?token|auth|password|passwd|secret|sig|signature|x-amz-[a-z-]+|code)$/i;

/** A URL without its credentials (user info, and query parameters that carry them): what a name may show. */
export function withoutCredentials(url: string): URL {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (CREDENTIAL_PARAMS.test(key)) { parsed.searchParams.delete(key); }
  }
  return parsed;
}

/** The forms a record lists, its primary one first, as the browser's badges show them. */
export function badges(record: Pick<ResourceRecord, 'forms' | 'primary'>): FormKind[] {
  const forms = record.forms ?? [];
  return record.primary === undefined ? [...forms] : [record.primary, ...forms.filter((kind) => kind !== record.primary)];
}

/** The forms of some form rows, each kind once, in `FormKind` order. */
export function kindsOf(forms: ReadonlyArray<{ kind: FormKind }>): FormKind[] {
  const present = new Set(forms.map((form) => form.kind));
  return FormKind.options.filter((kind) => present.has(kind));
}
