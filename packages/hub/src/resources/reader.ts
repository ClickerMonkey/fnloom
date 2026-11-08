/**
 * Reading resources for people and LLMs (`ResourceReader`): any form or the raw text, one section, a window of
 * characters (so a small model reads a long page in pieces), or a range of rows of one table. Sections are the index's
 * when it has cut this version in this form, else the best-matching hub sectioner's (headings for markdown, tables
 * for a table form, pages for a pdf). Downloads are presigned (with Range, for audio and video); a converted form downloads as its text.
 */
import { reject } from '@ayepi/core';
import { tableToMarkdown, versionMimeType, versionText } from '@aeye/resources/versions';
import {
  isConvertedKind, type ConvertedVersion, type FormKind, type FormRecord, type ResourceReadArgs, type ResourceReadResult, type ResourceRecord, type ResourceUri,
  type Section,
} from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import { allRows } from '../catalog/rows.ts';
import { hubSectioners, matchScore, type Sectioner } from '../index/sectioners.ts';
import type { HubStore } from '../store/index.ts';
import { tableRowCounts } from './converters.ts';
import type { Asking, FormService, ResourceReader } from './index.ts';
import { kindsOf, textOf } from './rules.ts';

/** How many characters a read gives when the caller doesn't say. */
export const READ_CHARS = 20_000;

/** File extensions of downloaded converted forms, by the media type of their text. */
const EXTENSIONS: Readonly<Record<string, string>> = { 'text/markdown': '.md', 'text/plain': '.txt', 'application/json': '.json', 'application/yaml': '.yaml' };

/** What the reader needs. */
export interface FormReaderOptions {
  readonly store: HubStore;
  readonly content: ContentStore;
  readonly forms: FormService;
}

/** The text of one form of a resource, its version when converted, and its form record. */
interface FormText {
  readonly form: FormKind | 'raw';
  readonly text: string;
  readonly version?: ConvertedVersion;
  readonly record?: FormRecord;
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
    const chosen = await this.#formText(record, args.form ?? record.primary ?? 'raw', forms, who);
    const base = { uri: args.uri, form: chosen.form, forms: kindsOf(forms), offers };
    if (args.rows !== undefined) { return { ...base, ...this.#rows(args.uri, chosen, args.rows) }; }
    let text = chosen.text;
    if (args.section !== undefined) {
      const section = (await this.#sections(record, chosen)).find((s) => s.key === args.section);
      if (section === undefined) { throw reject(404, 'NO_SECTION', `${args.uri} has no section ${args.section} in its ${chosen.form} form`); }
      text = text.slice(section.start, section.end);
    }
    const offset = Math.min(args.offset ?? 0, text.length);
    const max = args.maxChars ?? READ_CHARS;
    return { ...base, text: text.slice(offset, offset + max), offset, total: text.length, truncated: offset + max < text.length };
  }

  async outline(uri: ResourceUri, who: Asking): Promise<Section[]> {
    const { record, forms } = await this.#o.forms.forms(uri, who);
    const chosen = await this.#formText(record, record.primary ?? 'raw', forms, who);
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

  /** One form's text: the raw text, an existing form, or a form made now. */
  async #formText(record: ResourceRecord, form: FormKind | 'raw', forms: readonly FormRecord[], who: Asking): Promise<FormText> {
    if (form === 'raw') {
      const raw = (await this.#o.forms.snapshot(record.uri, who)).raw;
      const text = textOf(await this.#o.content.read(raw, 0, raw.size));
      if (text === undefined) {
        throw reject(422, 'NOT_TEXT', `${record.uri} is ${raw.mime}, not text; read one of its forms (${kindsOf(forms).join(', ') || 'none yet'})`);
      }
      return { form, text };
    }
    const found = forms.find((candidate) => candidate.kind === form) ?? await this.#o.forms.ensure(record.uri, form, who);
    if (!isConvertedKind(found.kind)) { return { form, text: await this.#o.forms.text(found), record: found }; }
    const version = await this.#o.forms.version(found);
    return { form, text: versionText(version), version, record: found };
  }

  /** Rows `from` to `to` of one table of a table form, as a markdown table. */
  #rows(uri: ResourceUri, chosen: FormText, rows: NonNullable<ResourceReadArgs['rows']>): Pick<ResourceReadResult, 'text' | 'offset' | 'total' | 'truncated'> {
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
    return { text: tableToMarkdown({ ...table, rows: table.rows.slice(rows.from, to) }), offset: rows.from, total, truncated: to < total };
  }

  /**
   * The sections of a form: the index's when it cut this version in this form, else what the best-matching hub
   * sectioner cuts (the same choice the index makes when no rule or system sectioner applies).
   */
  async #sections(record: ResourceRecord, chosen: FormText): Promise<Section[]> {
    const form = chosen.form === 'raw' ? undefined : chosen.form;
    if (record.indexedVersion === record.stat.version) {
      const rows = await allRows(this.#o.store.table('sections'), { uri: record.uri, version: record.stat.version });
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
