/**
 * Which viewer draws a resource and which modes its panel offers, from one table. `viewerFor(stat, forms, offers,
 * systems)` reads the resource's family and format, the forms the hub has made, the forms it could make, and the
 * systems' viewers for the format, and answers the modes in order: Preview and Source for types with both, then the
 * systems' own tabs, one tab per form (Markdown, Table, Pages, Description, Text in image, Transcript), and Info.
 * Each mode says what draws it and what it reads (the raw text, the raw bytes by URL, a form's text, or a converted
 * version's structure), so the viewer's store loads exactly that. A form that could be made but isn't yet is drawn as
 * "make it". A system viewer registered as `replace` draws the Preview instead; one registered as `tab` adds its
 * mode. The mode is in the URL (`mode=`). Pure, so it is tested alone.
 */
import type { ConvertedKind, FormatFamily, FormKind, FormOffer, ResourceStat } from '@harness/core';
import { FORM_LABEL, familyOfStat, languageOf } from './formats.ts';

/** What draws a mode. */
export type ViewerKind =
  | 'image' | 'svg' | 'diagram' | 'markdown' | 'code' | 'html' | 'table' | 'pdf' | 'pages' | 'audio' | 'video' | 'json' | 'text' | 'folder'
  | 'binary' | 'system' | 'offer' | 'info';

/** What a mode reads: the raw text, the raw bytes (by URL), a form's text, a converted version's structure, or nothing. */
export type ModeRead =
  | { readonly as: 'text'; readonly form: FormKind | 'raw' }
  | { readonly as: 'url' }
  | { readonly as: 'version'; readonly form: ConvertedKind }
  | { readonly as: 'none' };

/** One mode of the viewer's switch. */
export interface ViewMode {
  /** Its id in the URL: `preview`, `source`, `info`, the form kind (`markdown`), or `system:<system>`. */
  readonly id: string;
  readonly label: string;
  readonly draws: ViewerKind;
  readonly reads: ModeRead;
  /** The form it shows (and an offer's form). */
  readonly form?: FormKind;
  /** The system whose viewer draws it. */
  readonly system?: string;
  /** What making the form would use, for a form that doesn't exist yet. */
  readonly offer?: FormOffer;
  /** The highlighter's language, for code. */
  readonly language?: string;
}

/** A system's viewer for the resource's format, as the plan needs it. */
export interface SystemViewerInfo {
  readonly system: string;
  readonly mode: 'replace' | 'tab';
  readonly label: string;
}

/** The plan for one resource: its family, its modes in order, and the mode it opens on. */
export interface ViewerPlan {
  readonly family: FormatFamily;
  readonly modes: readonly ViewMode[];
  readonly initial: string;
}

/**
 * What a type's Preview draws and reads, and what its Source draws. A Preview that needs a form (a workbook's
 * table, a document's markdown) names it; without that form it is drawn as "make it" (or the binary card).
 */
interface Shape {
  readonly preview?: { readonly draws: ViewerKind; readonly reads: ModeRead };
  readonly source?: ViewerKind;
}

const RAW_TEXT: ModeRead = { as: 'text', form: 'raw' };
const URL_READ: ModeRead = { as: 'url' };
const NONE: ModeRead = { as: 'none' };

/** The one table: what each format draws, before its family's default. */
const BY_FORMAT: Readonly<Record<string, Shape>> = {
  svg: { preview: { draws: 'svg', reads: URL_READ }, source: 'code' },
  mermaid: { preview: { draws: 'diagram', reads: RAW_TEXT }, source: 'code' },
  markdown: { preview: { draws: 'markdown', reads: RAW_TEXT }, source: 'code' },
  html: { preview: { draws: 'html', reads: RAW_TEXT }, source: 'code' },
  csv: { preview: { draws: 'table', reads: RAW_TEXT }, source: 'code' },
  tsv: { preview: { draws: 'table', reads: RAW_TEXT }, source: 'code' },
  excel: { preview: { draws: 'table', reads: { as: 'version', form: 'table' } } },
  ods: { preview: { draws: 'table', reads: { as: 'version', form: 'table' } } },
  pdf: { preview: { draws: 'pdf', reads: URL_READ } },
  docx: { preview: { draws: 'markdown', reads: { as: 'text', form: 'markdown' } } },
  pptx: { preview: { draws: 'markdown', reads: { as: 'text', form: 'markdown' } } },
  odt: { preview: { draws: 'markdown', reads: { as: 'text', form: 'markdown' } } },
  rtf: { preview: { draws: 'markdown', reads: { as: 'text', form: 'markdown' } } },
  notebook: { preview: { draws: 'markdown', reads: { as: 'text', form: 'markdown' } }, source: 'code' },
  json: { preview: { draws: 'json', reads: RAW_TEXT }, source: 'code' },
  jsonl: { preview: { draws: 'json', reads: RAW_TEXT }, source: 'code' },
  text: { source: 'text' },
};

/** What each family draws when its format isn't in `BY_FORMAT`. */
const BY_FAMILY = {
  document: { source: 'text' },
  code: { source: 'code' },
  image: { preview: { draws: 'image', reads: URL_READ } },
  table: { preview: { draws: 'table', reads: { as: 'version', form: 'table' } } },
  audio: { preview: { draws: 'audio', reads: URL_READ } },
  video: { preview: { draws: 'video', reads: URL_READ } },
  web: { preview: { draws: 'html', reads: RAW_TEXT }, source: 'code' },
  data: { source: 'code' },
  archive: { preview: { draws: 'folder', reads: NONE } },
  folder: { preview: { draws: 'folder', reads: NONE } },
  other: { preview: { draws: 'binary', reads: NONE } },
} as const satisfies Record<FormatFamily, Shape>;

/** The forms in the order their tabs come. A made form not listed still gets a tab, after these. */
const FORM_ORDER: readonly FormKind[] = ['markdown', 'table', 'pages', 'code', 'text', 'description', 'ocr', 'transcript'];

/** What a form's tab draws and reads. */
const FORM_MODE = {
  markdown: { draws: 'markdown', reads: { as: 'text', form: 'markdown' } },
  text: { draws: 'text', reads: { as: 'text', form: 'text' } },
  code: { draws: 'code', reads: { as: 'text', form: 'code' } },
  pages: { draws: 'pages', reads: { as: 'version', form: 'pages' } },
  table: { draws: 'table', reads: { as: 'version', form: 'table' } },
  description: { draws: 'markdown', reads: { as: 'text', form: 'description' } },
  ocr: { draws: 'text', reads: { as: 'text', form: 'ocr' } },
  transcript: { draws: 'text', reads: { as: 'text', form: 'transcript' } },
  thumbnail: { draws: 'image', reads: { as: 'url' } },
} as const satisfies Record<FormKind, { readonly draws: ViewerKind; readonly reads: ModeRead }>;

/** The form a read needs, if it needs one. */
function formOf(read: ModeRead): FormKind | undefined {
  return read.as === 'text' ? (read.form === 'raw' ? undefined : read.form) : read.as === 'version' ? read.form : undefined;
}

/**
 * Whether a form's tab would repeat the Preview: the form the Preview already draws, a thumbnail, or a form drawn the
 * same way as a Preview of the raw text (a markdown file's markdown form, a csv's table).
 */
function repeats(form: FormKind, shape: Shape): boolean {
  const preview = shape.preview;
  if (form === 'thumbnail' || preview === undefined) { return form === 'thumbnail'; }
  return formOf(preview.reads) === form || (preview.reads.as === 'text' && preview.reads.form === 'raw' && FORM_MODE[form].draws === preview.draws);
}

/** The viewer plan for a resource. */
export function viewerFor(
  stat: Pick<ResourceStat, 'format' | 'mime' | 'type'>,
  forms: readonly FormKind[],
  offers: readonly FormOffer[] = [],
  systems: readonly SystemViewerInfo[] = [],
): ViewerPlan {
  const family = familyOfStat(stat);
  const svg = stat.mime?.startsWith('image/svg') === true ? BY_FORMAT['svg'] : undefined;
  const shape: Shape = (stat.format === undefined ? undefined : BY_FORMAT[stat.format]) ?? svg ?? BY_FAMILY[family];
  const language = languageOf(stat.format) || 'text';
  const made = new Set(forms);
  const modes: ViewMode[] = [];

  const replacing = systems.find((s) => s.mode === 'replace');
  if (replacing !== undefined) {
    modes.push({ id: 'preview', label: 'Preview', draws: 'system', reads: NONE, system: replacing.system });
  } else if (shape.preview !== undefined) {
    const needs = formOf(shape.preview.reads);
    const offer = needs === undefined ? undefined : offers.find((o) => o.kind === needs);
    if (needs === undefined || made.has(needs)) {
      modes.push({ id: 'preview', label: 'Preview', ...shape.preview, ...(needs === undefined ? {} : { form: needs }) });
    } else {
      modes.push(offer === undefined
        ? { id: 'preview', label: 'Preview', draws: 'binary', reads: NONE }
        : { id: 'preview', label: 'Preview', draws: 'offer', reads: NONE, form: offer.kind, offer });
    }
  }
  if (shape.source !== undefined) {
    modes.push({ id: 'source', label: modes.length === 0 ? 'Text' : 'Source', draws: shape.source, reads: RAW_TEXT, ...(shape.source === 'code' ? { language } : {}) });
  }
  for (const s of systems.filter((v) => v.mode === 'tab')) { modes.push({ id: `system:${s.system}`, label: s.label, draws: 'system', reads: NONE, system: s.system }); }

  const ordered = [...FORM_ORDER, ...forms.filter((f) => !FORM_ORDER.includes(f))];
  for (const form of ordered) {
    if (repeats(form, shape)) { continue; }
    if (made.has(form)) {
      modes.push({ id: form, label: FORM_LABEL[form], ...FORM_MODE[form], form, ...(form === 'code' ? { language } : {}) });
      continue;
    }
    const offer = offers.find((o) => o.kind === form);
    if (offer !== undefined) { modes.push({ id: form, label: FORM_LABEL[form], draws: 'offer', reads: NONE, form, offer }); }
  }
  modes.push({ id: 'info', label: 'Info', draws: 'info', reads: NONE });
  return { family, modes, initial: modes[0]?.id ?? 'info' };
}

/** The mode for an id from the URL, or the plan's first when the id names none of them. */
export function modeOf(plan: ViewerPlan, id: string | undefined): ViewMode {
  const fallback: ViewMode = { id: 'info', label: 'Info', draws: 'info', reads: NONE };
  return plan.modes.find((m) => m.id === id) ?? plan.modes.find((m) => m.id === plan.initial) ?? fallback;
}

/** A key for what a read loads, so two modes reading the same thing share one load. */
export function readKey(read: ModeRead): string {
  switch (read.as) {
    case 'text': return `text:${read.form}`;
    case 'url': return 'url';
    case 'version': return `version:${read.form}`;
    case 'none': return 'none';
  }
}
