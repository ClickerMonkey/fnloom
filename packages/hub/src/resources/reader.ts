/**
 * Reading resources for people and LLMs (`ResourceReader`): any form or the raw text, one section, a window of
 * characters (so a small model reads a long page in pieces), or a range of rows of one table. Sections are the index's
 * when it has cut this version in this form, else the best-matching hub sectioner's (headings for markdown, tables
 * for a table form, pages for a pdf). Downloads are presigned (with Range, for audio and video); a converted form downloads as its text.
 */
import { reject } from '@ayepi/core';
import { tableToMarkdown, versionMimeType, versionText } from '@aeye/resources/versions';
import {
  isConvertedKind, partialNote, type ConvertedVersion, type FormKind, type FormOffer, type FormRecord, type ResourceReadArgs, type ResourceReadResult, type ResourceRecord, type ResourceUri,
  type Section,
} from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import { allRows } from '../store/rows.ts';
import { hubSectioners, matchScore, type Sectioner } from '../index/sectioners.ts';
import type { HubStore } from '../store/index.ts';
import { tableRowCounts } from './converters.ts';
import type { Asking, FormService, ResourceReader } from './index.ts';
import { familyOfStat, kindsOf, madeKindsFor, textOf } from './rules.ts';

/** File extensions of downloaded converted forms, by the media type of their text. */
const EXTENSIONS: Readonly<Record<string, string>> = { 'text/markdown': '.md', 'text/plain': '.txt', 'application/json': '.json', 'application/yaml': '.yaml' };

/** What the reader needs. */
export interface FormReaderOptions {
  readonly store: HubStore;
  readonly content: ContentStore;
  readonly forms: FormService;
  /** How many characters a read gives when the caller doesn't say (`HARNESS_READ_CHARS`). */
  readonly readChars: number;
}

/** The text of one form of a resource, its version when converted, and its form record. */
interface FormText {
  readonly form: FormKind | 'raw';
  readonly text: string;
  readonly version?: ConvertedVersion;
  readonly record?: FormRecord;
}

/** Whether a resource has a form, or can have it made on asking (a model-made form of its family). */
function hasForm(record: ResourceRecord, kind: FormKind, forms: readonly FormRecord[]): boolean {
  return forms.some((form) => form.kind === kind) || (!isConvertedKind(kind) && madeKindsFor(familyOfStat(record.stat)).includes(kind));
}

/** The note on a read of another form than the one asked for. */
function insteadNote(uri: ResourceUri, asked: FormKind | 'raw', read: FormKind, forms: readonly FormRecord[]): string {
  const lacks = asked === 'raw' ? 'is not text' : `has no ${asked} form`;
  return `Read as ${read}: ${uri} ${lacks}. Its forms: ${kindsOf(forms).join(', ')}. Leave out form to read its primary form.`;
}

/** Why a resource can't be read in a form, and what it has instead: its forms, the forms a model can make, or a look. */
function lacking(uri: ResourceUri, asked: FormKind | 'raw', forms: readonly FormRecord[], offers: readonly FormOffer[]): string {
  const has = kindsOf(forms);
  const what = asked === 'raw' ? 'It' : `${uri} has no ${asked} form; it`;
  if (has.length > 0) { return `${what} has ${has.join(', ')}: read one with form set to it, or leave out form for its primary form.`; }
  const made = offers.map((offer) => offer.kind);
  const make = made.length === 0 ? '' : ` A model can make ${made.join(' or ')} with hub/resource_convert.`;
  return `${what} has no form that reads as text yet.${make} Look at it with hub/resource_send instead.`;
}

/** When a table form keeps only the first rows of its tables: a line saying so, for a whole read; else undefined. */
function cappedRows(chosen: FormText): string | undefined {
  const version = chosen.version;
  if (version?.kind !== 'table') { return undefined; }
  const counts = tableRowCounts(version);
  const cut = version.tables.flatMap((table, i) => {
    const total = counts[i] ?? table.rows.length;
    return total > table.rows.length ? [`${table.name ?? table.sheetName ?? String(i + 1)} (rows 1–${table.rows.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')})`] : [];
  });
  return cut.length === 0 ? undefined : `Partial: the hub keeps only the first rows of ${cut.join(', ')}; the rest can't be read here (the raw file has them all). Don't state what the left-out rows say.`;
}

/** Reading over the forms service. */
export class FormReader implements ResourceReader {
  readonly #o: FormReaderOptions;
  readonly #sectioners = hubSectioners();

  constructor(options: FormReaderOptions) {
    this.#o = options;
  }

  async read(args: ResourceReadArgs, who: Asking): Promise<ResourceReadResult> {
    const { record, forms, offers } = await this.#o.forms.forms(args.uri, who);
    const picked = this.#formFor(record, args.form, forms, offers);
    const { chosen, note } = await this.#readable(record, picked, args.form, forms, offers, who);
    const base = { uri: args.uri, form: chosen.form, forms: kindsOf(forms), offers, ...(note === undefined ? {} : { note }) };
    if (args.rows !== undefined) { return { ...base, ...this.#rows(args.uri, chosen, args.rows) }; }
    let text = chosen.text;
    if (args.section !== undefined) {
      const section = (await this.#sections(record, chosen)).find((s) => s.key === args.section);
      if (section === undefined) { throw reject(404, 'NO_SECTION', `${args.uri} has no section ${args.section} in its ${chosen.form} form; hub/resource_outline lists its sections`); }
      text = text.slice(section.start, section.end);
    }
    const offset = Math.min(args.offset ?? 0, text.length);
    const max = args.maxChars ?? this.#o.readChars;
    const shown = text.slice(offset, offset + max);
    const truncated = offset + max < text.length;
    const how = [`uri: "${args.uri}"`, ...(args.form === undefined ? [] : [`form: "${chosen.form}"`]), ...(args.section === undefined ? [] : [`section: "${args.section}"`])].join(', ');
    const window = partialNote({
      unit: 'characters', offset, shown: shown.length, total: text.length,
      rest: `call hub/resource_read again with ${how} and offset: ${offset + shown.length}${args.section === undefined ? ' (or read one section from hub/resource_outline)' : ''}`,
    });
    const capped = cappedRows(chosen);
    const partial = [window, capped].filter((line) => line !== undefined).join(' ');
    return { ...base, text: shown, offset, total: text.length, truncated: truncated || capped !== undefined, ...(partial === '' ? {} : { partial }) };
  }

  async outline(uri: ResourceUri, who: Asking): Promise<Section[]> {
    const { record, forms } = await this.#o.forms.forms(uri, who);
    const { chosen } = await this.#readable(record, { form: record.primary ?? 'raw' }, undefined, forms, [], who);
    return (await this.#sections(record, chosen)).map(({ embedText: _embedText, ...section }) => section);
  }

  async download(uri: ResourceUri, form: FormKind | undefined, who: Asking): Promise<{ url: string; mime: string; size: number }> {
    const { content, forms } = this.#o;
    const record = await forms.snapshot(uri, who);
    if (form === undefined) {
      return { url: await content.presignDownload(record.raw, record.stat.name), mime: record.raw.mime, size: record.raw.size };
    }
    const made = await forms.ensure(uri, form, who);
    if (!isConvertedKind(made.kind)) {
      return { url: await content.presignDownload(made.content, `${record.stat.name} (${form}).txt`), mime: made.content.mime, size: made.content.size };
    }
    const version = await forms.version(made);
    const mime = versionMimeType(version);
    const ref = await content.put(new TextEncoder().encode(versionText(version)), mime);
    return { url: await content.presignDownload(ref, `${record.stat.name}${EXTENSIONS[mime] ?? '.txt'}`), mime, size: ref.size };
  }

  /**
   * The form to read: the one asked for when the resource has it (or can have it made: an image's description), else
   * its primary form (else any form it has) with a note saying so; with none to read, a refusal naming what there is.
   */
  #formFor(record: ResourceRecord, asked: ResourceReadArgs['form'], forms: readonly FormRecord[], offers: readonly FormOffer[]): { form: FormKind | 'raw'; note?: string } {
    const wanted = asked ?? record.primary ?? 'raw';
    if (wanted === 'raw' || hasForm(record, wanted, forms)) { return { form: wanted }; }
    const instead = record.primary ?? kindsOf(forms)[0];
    if (instead === undefined) { throw reject(404, 'NO_FORM', lacking(record.uri, wanted, forms, offers)); }
    return { form: instead, note: insteadNote(record.uri, wanted, instead, forms) };
  }

  /** A picked form's text, the raw text of binary content giving way to a form the resource has (or a refusal naming them). */
  async #readable(record: ResourceRecord, picked: { form: FormKind | 'raw'; note?: string }, asked: ResourceReadArgs['form'], forms: readonly FormRecord[], offers: readonly FormOffer[], who: Asking): Promise<{ chosen: FormText; note?: string }> {
    const chosen = await this.#formText(record, picked.form, forms, who);
    if (chosen !== undefined) { return { chosen, ...(picked.note === undefined ? {} : { note: picked.note }) }; }
    const instead = kindsOf(forms)[0];
    const read = instead === undefined ? undefined : await this.#formText(record, instead, forms, who);
    if (instead === undefined || read === undefined) {
      const raw = (await this.#o.forms.snapshot(record.uri, who)).raw;
      throw reject(422, 'NOT_TEXT', `${record.uri} is ${raw.mime}, not text. ${lacking(record.uri, 'raw', forms, offers)}`);
    }
    return { chosen: read, note: insteadNote(record.uri, asked ?? 'raw', instead, forms) };
  }

  /** One form's text: the raw text (undefined when the raw content isn't text), an existing form, or a form made now. */
  async #formText(record: ResourceRecord, form: FormKind | 'raw', forms: readonly FormRecord[], who: Asking): Promise<FormText | undefined> {
    if (form === 'raw') {
      const raw = (await this.#o.forms.snapshot(record.uri, who)).raw;
      const text = textOf(await this.#o.content.read(raw, 0, raw.size));
      return text === undefined ? undefined : { form, text };
    }
    const found = forms.find((candidate) => candidate.kind === form) ?? await this.#o.forms.ensure(record.uri, form, who);
    if (!isConvertedKind(found.kind)) { return { form, text: await this.#o.forms.text(found), record: found }; }
    const version = await this.#o.forms.version(found);
    return { form, text: versionText(version), version, record: found };
  }

  /** Rows `from` to `to` of one table of a table form, as a markdown table. */
  #rows(uri: ResourceUri, chosen: FormText, rows: NonNullable<ResourceReadArgs['rows']>): Pick<ResourceReadResult, 'text' | 'offset' | 'total' | 'truncated' | 'partial'> {
    const version = chosen.version;
    if (version?.kind !== 'table') { throw reject(422, 'NOT_A_TABLE', `rows can only be read from a table form; ${uri} was read as ${chosen.form}`); }
    const index = version.tables.findIndex((table, i) => table.name === rows.table || table.sheetName === rows.table || String(i + 1) === rows.table);
    const table = version.tables[index];
    if (table === undefined) { throw reject(404, 'NO_TABLE', `${uri} has no table ${rows.table} (it has ${version.tables.map((t, i) => t.name ?? String(i + 1)).join(', ')})`); }
    const total = tableRowCounts(version)[index] ?? table.rows.length;
    // the hub keeps the first `HARNESS_TABLE_ROWS` rows of a table (the library converts a sheet whole, with no row
    // window); a range starting past them is refused, never answered empty as if the table ended there
    if (rows.from >= table.rows.length && rows.from < total) {
      throw reject(422, 'ROWS_NOT_KEPT', `${uri} keeps rows 0-${table.rows.length} of its ${total.toLocaleString('en-US')}; rows from ${rows.from} can't be read here (export the raw file for the rest)`);
    }
    const to = Math.max(rows.from, Math.min(rows.to, table.rows.length));
    const kept = table.rows.length;
    const rest = to < kept
      ? `call hub/resource_read again with uri: "${uri}" and rows: { table: "${rows.table}", from: ${to}, to: ${Math.min(kept, to + Math.max(1, rows.to - rows.from))} }`
      : `use the raw file: the hub keeps only the first ${kept.toLocaleString('en-US')} rows of this table, so the rest can't be read here`;
    const partial = rows.from < total ? partialNote({ unit: 'rows', offset: rows.from, shown: to - rows.from, total, rest }) : undefined;
    return { text: tableToMarkdown({ ...table, rows: table.rows.slice(rows.from, to) }), offset: rows.from, total, truncated: to < total, ...(partial === undefined ? {} : { partial }) };
  }

  /**
   * The sections of a form: the index's when it cut this version in this form, else what the best-matching hub
   * sectioner cuts (the same choice the index makes when no rule or system sectioner applies).
   */
  async #sections(record: ResourceRecord, chosen: FormText): Promise<Section[]> {
    const form = chosen.form === 'raw' ? undefined : chosen.form;
    if (record.indexedVersion === record.stat.version) {
      const rows = await allRows(this.#o.store.table('sections'), { where: { uri: record.uri, version: record.stat.version } });
      const ofForm = rows.filter((row) => row.form === form);
      if (ofForm.length > 0) { return ofForm.sort((a, b) => a.start - b.start).map(({ uri: _uri, version: _version, hash: _hash, ...section }) => section); }
    }
    const input = { text: chosen.text, stat: record.stat, ...(form === undefined ? {} : { form }), ...(chosen.version === undefined ? {} : { version: chosen.version }) };
    let best: { sectioner: Sectioner; score: number } | undefined;
    for (const sectioner of this.#sectioners) {
      const score = matchScore(sectioner.match, record.stat, form);
      if (score !== undefined && (best === undefined || score > best.score)) { best = { sectioner, score }; }
    }
    return best?.sectioner.sections(input) ?? [];
  }
}
