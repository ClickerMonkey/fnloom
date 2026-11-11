/**
 * The mock hub's resource library: a resource of every common type (markdown with a diagram and math, TypeScript,
 * csv, a two-sheet workbook, a png, an svg, a pdf, json, an html page, a log, a wav with its transcript, and a
 * folder), each with the forms the hub would make, real bytes served at `/api/mock-files/<id>`, facets for every
 * grouping, forms made on request, and uploads and URL imports kept as hub resources. Every record goes through the
 * hub's schemas, so the browser sees what a real hub sends.
 */
import { fixture } from './fixture.ts';
import { createHash } from 'node:crypto';
import { versionText } from '@aeye/resources/versions';
import {
  ConvertedVersion, FormKind, FormRecord, HUB_RESOURCE_ROOT, ResourceRecord, familyOf, isConvertedKind,
  type ConvertedKind, type FormOffer, type ResourceFacet, type ResourceQuery, type ResourceReadArgs, type ResourceReadResult, type ResourceUri,
} from '@harness/core';
import { CODE, CSV, HTML, JSON_TEXT, LOG, MARKDOWN, pdf, png, SVG, utf8, wav } from './samples.ts';
import type { z } from 'zod';

/** Where the mock serves bytes (under `/api`, so the dev and preview proxies pass it). */
export const MOCK_FILES = '/mock-files/';
/** Where the mock takes presigned uploads. */
export const MOCK_UPLOADS = '/mock-uploads/';

/** The format an uploaded file's extension reads as (as `@aeye/resources` names them). */
const FORMATS: Readonly<Record<string, string>> = {
  md: 'markdown', ts: 'typescript', csv: 'csv', json: 'json', svg: 'svg', html: 'html', log: 'text', txt: 'text', png: 'image', jpg: 'image', pdf: 'pdf', wav: 'audio', mp3: 'audio', xlsx: 'excel',
};

const HASH = 'b'.repeat(64);
const DAY = 86_400_000;

/** One resource in the library: its record, raw bytes or text, its converted versions and its made forms. */
interface Entry {
  record: ResourceRecord;
  bytes: Uint8Array;
  mime: string;
  versions: Partial<Record<ConvertedKind, ConvertedVersion>>;
  made: Partial<Record<FormKind, string>>;
  offers: FormOffer[];
}

/** The library. */
export class MockResources {
  readonly #entries = new Map<string, Entry>();
  readonly #uploads = new Map<string, { readonly name: string; readonly mime: string; readonly bytes: Uint8Array }>();
  readonly #content = new Map<string, { readonly name: string; readonly mime: string; readonly bytes: Uint8Array }>();
  readonly #now: number;
  #next = 1;

  constructor(now: number) {
    this.#now = now;
    const add = (uri: z.input<typeof ResourceUri>, stat: { name: string; format?: string; mime: string; type?: 'file' | 'folder' | 'page' }, bytes: Uint8Array, extra: Partial<Pick<Entry, 'versions' | 'made' | 'offers'>> & { system?: string; ago?: number; links?: ResourceRecord['links'] } = {}): void => {
      this.#put(uri, { ...stat, size: bytes.length }, bytes, stat.mime, extra);
    };
    add('fs://work/README.md', { name: 'README.md', format: 'markdown', mime: 'text/markdown' }, utf8(MARKDOWN), { ago: 0.1 });
    add('fs://work/packages/web/src/main.ts', { name: 'main.ts', format: 'typescript', mime: 'text/typescript' }, utf8(CODE), { ago: 0.5 });
    // the file the build 5 feedback pass searches for and opens
    add('fs://work/scripts/hub-client.ts', { name: 'hub-client.ts', format: 'typescript', mime: 'text/typescript' }, utf8(CODE), { ago: 0.6 });
    add('fs://work/data/people.csv', { name: 'people.csv', format: 'csv', mime: 'text/csv' }, utf8(CSV), {
      ago: 2, versions: { table: fixture(ConvertedVersion, { kind: 'table', converter: 'csvConverter', from: 'csv', tables: [{ name: 'people', headers: ['name', 'age', 'joined'], rows: [['Ada', '36', '2024-01-04'], ['Grace', '45', '2023-06-12'], ['Hopper, Grace', '46', '2023-06-13'], ['Alan', '41', '2025-02-20']] }] }) },
    });
    add('fs://work/data/book.xlsx', { name: 'book.xlsx', format: 'excel', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, new Uint8Array([80, 75, 3, 4]), {
      ago: 3, versions: { table: fixture(ConvertedVersion, { kind: 'table', converter: 'xlsxConverter', from: 'excel', tables: [
        { name: 'People', sheetName: 'People', sheetIndex: 0, headers: ['name', 'age', 'city'], rows: Array.from({ length: 260 }, (_, i) => [`Person ${i + 1}`, String(20 + (i % 50)), i % 2 === 0 ? 'London' : 'Arlington']) },
        { name: 'Cities', sheetName: 'Cities', sheetIndex: 1, headers: ['city', 'people'], rows: [['London', '9000000'], ['Arlington', '238000']] },
      ] }) },
    });
    add('fs://work/art/logo.png', { name: 'logo.png', format: 'image', mime: 'image/png' }, png(96, 64), { ago: 5, made: { description: 'A soft blue gradient, darker at the top left.' }, offers: [{ kind: 'ocr', model: 'openai/gpt-4o-mini', estimate: 0.0004 }] });
    add('fs://work/art/mark.svg', { name: 'mark.svg', format: 'svg', mime: 'image/svg+xml' }, utf8(SVG), { ago: 6 });
    add('fs://work/docs/guide.pdf', { name: 'guide.pdf', format: 'pdf', mime: 'application/pdf' }, pdf(), {
      ago: 8, versions: { pages: fixture(ConvertedVersion, { kind: 'pages', converter: 'pdfConverter', from: 'pdf', pages: ['Harness guide\nA hub and its systems.', 'Systems connect over WebSocket.', 'The hub owns every model call.'] }) },
    });
    add('fs://work/package.json', { name: 'package.json', format: 'json', mime: 'application/json' }, utf8(JSON_TEXT), { ago: 12 });
    add('fs://work/logs/hub.log', { name: 'hub.log', format: 'text', mime: 'text/plain' }, utf8(LOG), { ago: 30 });
    add(`${HUB_RESOURCE_ROOT}web/example.com/release-notes`, { name: 'Release notes', format: 'html', mime: 'text/html', type: 'page' }, utf8(HTML), {
      system: 'hub', ago: 1,
      versions: { markdown: fixture(ConvertedVersion, { kind: 'markdown', converter: 'htmlConverter@2', from: 'html', title: 'Release notes', text: '# Release notes\n\nThe **fs** system can watch folders.\n\n- Faster search\n- Live runs\n' }) },
    });
    // build 4: a web crawl keeps its pages under one folder named for the site and the time
    for (const [path, title] of [['docs/intro', 'Introduction'], ['docs/install', 'Install'], ['docs/guides/pairing', 'Pairing a system'], ['blog/launch', 'We launched']] as const) {
      add(`${HUB_RESOURCE_ROOT}web/crawls/docs.example.com-20261108-1430/docs.example.com/${path}`, { name: title, format: 'html', mime: 'text/html', type: 'page' }, utf8(HTML), {
        system: 'hub', ago: 0.3,
        versions: { markdown: fixture(ConvertedVersion, { kind: 'markdown', converter: 'htmlConverter@2', from: 'html', title, text: `# ${title}\n\nFrom docs.example.com.\n` }) },
      });
    }
    add(`${HUB_RESOURCE_ROOT}uploads/2026-11-07/walkthrough.wav`, { name: 'walkthrough.wav', format: 'audio', mime: 'audio/wav' }, wav(), {
      system: 'hub', ago: 0.2, made: { transcript: '[0:00] Welcome to the harness walkthrough.\n[0:00.4] First, pair a system.\n[0:00.8] Then ask the chat to read a file.' },
    });
    add('fs://work/docs', { name: 'docs', mime: 'inode/directory', type: 'folder' }, new Uint8Array(), {
      ago: 40, links: [{ uri: 'fs://work/docs/guide.pdf', raw: 'guide.pdf', kind: 'child', title: 'guide.pdf' }],
    });
  }

  #put(uri: z.input<typeof ResourceUri>, stat: { name: string; format?: string; mime: string; size: number; type?: 'file' | 'folder' | 'page' }, bytes: Uint8Array, mime: string, extra: Partial<Pick<Entry, 'versions' | 'made' | 'offers'>> & { system?: string; ago?: number; links?: ResourceRecord['links'] }): ResourceRecord {
    const versions = extra.versions ?? {};
    const made = extra.made ?? {};
    const forms = [...Object.keys(versions), ...Object.keys(made)].filter((key): key is FormKind => FormKind.safeParse(key).success);
    const record = fixture(ResourceRecord, {
      uri, system: extra.system ?? 'fs', links: extra.links ?? [], seenAt: this.#now - (extra.ago ?? 1) * DAY, forms,
      stat: { uri, type: stat.type ?? 'file', name: stat.name, mime: stat.mime, size: stat.size, version: '1', modifiedAt: this.#now - (extra.ago ?? 1) * DAY, ...(stat.format === undefined ? {} : { format: stat.format }) },
      ...(uri.startsWith(HUB_RESOURCE_ROOT) ? { source: { from: 'upload', by: 'act_admin' } } : {}),
      ...(forms[0] === undefined ? {} : { primary: forms[0] }),
    });
    this.#entries.set(uri, { record, bytes, mime, versions, made, offers: extra.offers ?? [] });
    return record;
  }

  /** The value a record has in a grouping (its family, source, folder or day). */
  #groupOf(record: ResourceRecord, group: NonNullable<ResourceQuery['group']>, under: string): { value: string; label: string } | undefined {
    switch (group) {
      case 'type': { const family = familyOf(record.stat.format, record.stat.mime); return { value: family, label: `${family.charAt(0).toUpperCase()}${family.slice(1)}` }; }
      case 'source': return record.system === 'hub' ? { value: 'upload', label: 'Uploads and web' } : { value: `system:${record.system}`, label: `${record.system} system` };
      case 'path': {
        const rest = record.uri.slice(under.length);
        const parts = rest.split('/').filter((p) => p !== '');
        if (under === '') { const root = /^[a-z]+:\/\/[^/]+/.exec(record.uri)?.[0]; return root === undefined ? undefined : { value: `${root}/`, label: root }; }
        return parts.length > 1 && parts[0] !== undefined ? { value: `${under}${parts[0]}/`, label: parts[0] } : undefined;
      }
      case 'date': {
        const age = (this.#now - record.seenAt) / DAY;
        return age < 1 ? { value: 'today', label: 'Today' } : age < 2 ? { value: 'yesterday', label: 'Yesterday' } : age < 7 ? { value: 'week', label: 'This week' } : { value: 'earlier', label: 'Earlier' };
      }
    }
  }

  /** A page of resources for a query, with the facets of its grouping. */
  browse(query: ResourceQuery): { items: ResourceRecord[]; facets: ResourceFacet[]; cursor?: string } {
    const words = (query.search ?? '').toLowerCase();
    const under = query.under ?? '';
    const group = query.group ?? 'type';
    const matching = [...this.#entries.values()].map((e) => e.record).filter((r) => (words === '' || `${r.uri} ${r.stat.name}`.toLowerCase().includes(words))
      && (query.system === undefined || r.system === query.system) && (query.family === undefined || familyOf(r.stat.format, r.stat.mime) === query.family)
      && (under === '' || r.uri.startsWith(under)) && (query.form === undefined || r.forms?.includes(query.form) === true)
      && (query.missing === undefined || r.forms?.includes(query.missing) !== true))
      .sort((a, b) => b.seenAt - a.seenAt);
    const counts = new Map<string, ResourceFacet>();
    for (const r of matching) {
      const g = this.#groupOf(r, group, under);
      if (g !== undefined) { counts.set(g.value, { value: g.value, label: g.label, count: (counts.get(g.value)?.count ?? 0) + 1 }); }
    }
    const items = query.in === undefined ? matching : matching.filter((r) => this.#groupOf(r, group, under)?.value === query.in);
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const end = start + (query.limit ?? 60);
    return { items: items.slice(start, end), facets: [...counts.values()], ...(end < items.length ? { cursor: String(end) } : {}) };
  }

  #entry(uri: string): Entry {
    const entry = this.#entries.get(uri);
    if (entry === undefined) { throw new Error(`No resource ${uri}`); }
    return entry;
  }

  #formRecords(entry: Entry): FormRecord[] {
    return (entry.record.forms ?? []).map((kind) => fixture(FormRecord, { hash: HASH, kind, converter: kind in entry.versions ? `@aeye/resources:${kind}@1` : 'model:openai/gpt-4o-mini', content: { hash: HASH, size: 100, mime: 'application/json' }, chars: 400, tokens: 110, createdAt: this.#now }));
  }

  forms(uri: ResourceUri): { record: ResourceRecord; forms: FormRecord[]; offers: FormOffer[] } {
    const entry = this.#entry(uri);
    return { record: entry.record, forms: this.#formRecords(entry), offers: entry.offers };
  }

  read(args: ResourceReadArgs): ResourceReadResult {
    const entry = this.#entry(args.uri);
    const form = args.form ?? entry.record.primary ?? 'raw';
    const version = form !== 'raw' && isConvertedKind(form) ? entry.versions[form] : undefined;
    const text = form === 'raw' ? new TextDecoder().decode(entry.bytes) : version !== undefined ? versionText(version) : entry.made[form] ?? '';
    const offset = args.offset ?? 0;
    const max = args.maxChars ?? 200_000;
    return { uri: args.uri, form, text: text.slice(offset, offset + max), offset, total: text.length, truncated: text.length > offset + max, forms: entry.record.forms ?? [], offers: entry.offers };
  }

  /** Make a form now (a description, a transcript): it appears on the record and is announced. */
  convert(uri: ResourceUri, kind: FormKind): FormRecord {
    const entry = this.#entry(uri);
    entry.made[kind] = kind === 'ocr' ? 'HARNESS' : `The ${kind} of ${entry.record.stat.name}.`;
    entry.offers = entry.offers.filter((o) => o.kind !== kind);
    entry.record = fixture(ResourceRecord, { ...entry.record, forms: [...new Set([...(entry.record.forms ?? []), kind])] });
    return fixture(FormRecord, { hash: HASH, kind, converter: 'model:openai/gpt-4o-mini', content: { hash: HASH, size: 40, mime: 'text/plain' }, chars: 40, tokens: 10, createdAt: this.#now });
  }

  download(uri: ResourceUri, form: FormKind | undefined, base: string): { url: string; mime: string; size: number } {
    const entry = this.#entry(uri);
    const id = encodeURIComponent(`${uri}${form === undefined ? '' : `#${form}`}`);
    return { url: `${base}${MOCK_FILES}${id}`, mime: form === undefined ? entry.mime : 'application/json', size: entry.bytes.length };
  }

  /** The bytes served for a mock file id, or undefined. */
  file(id: string): { bytes: Uint8Array; mime: string } | undefined {
    const [uri = '', form] = decodeURIComponent(id).split('#');
    const entry = this.#entries.get(uri);
    if (entry === undefined) { return undefined; }
    if (form === undefined) { return { bytes: entry.bytes, mime: entry.mime }; }
    const kind = FormKind.safeParse(form);
    if (!kind.success) { return undefined; }
    const version = isConvertedKind(kind.data) ? entry.versions[kind.data] : undefined;
    return version === undefined ? { bytes: utf8(entry.made[kind.data] ?? ''), mime: 'text/plain' } : { bytes: utf8(JSON.stringify(version)), mime: 'application/json' };
  }

  importUrl(url: string): ResourceRecord {
    const host = new URL(url).host;
    return this.#put(`${HUB_RESOURCE_ROOT}web/${host}/page-${this.#next++}`, { name: `${host} page`, format: 'html', mime: 'text/html', size: HTML.length, type: 'page' }, utf8(HTML), 'text/html', { system: 'hub', ago: 0 });
  }

  /** A presigned upload: where the bytes go, and the id `uploaded` takes. */
  presign(name: string, mime: string): { url: string; upload: string } {
    const upload = `up_${this.#next++}`;
    this.#uploads.set(upload, { name, mime, bytes: new Uint8Array() });
    return { url: `/api${MOCK_UPLOADS}${upload}`, upload };
  }

  /** Bytes PUT to a presigned upload; false when there is no such upload. */
  receive(upload: string, bytes: Uint8Array): boolean {
    const known = this.#uploads.get(upload);
    if (known === undefined) { return false; }
    this.#uploads.set(upload, { ...known, bytes });
    return true;
  }

  /** A finished upload's content ref (kept by the hash the mock gives it). */
  uploaded(upload: string): { hash: string; size: number; mime: string } {
    const known = this.#uploads.get(upload);
    if (known === undefined) { throw new Error(`No upload ${upload}`); }
    const hash = createHash('sha256').update(known.bytes).digest('hex');
    this.#content.set(hash, known);
    return { hash, size: known.bytes.length, mime: known.mime };
  }

  /** The file name an upload came as, by its content hash. */
  nameOf(hash: string): string | undefined {
    return this.#content.get(hash)?.name;
  }

  /** An uploaded file imported as a hub resource, its format read off its name. */
  importUpload(name: string, hash: string): ResourceRecord {
    const content = this.#content.get(hash);
    const bytes = content?.bytes ?? new Uint8Array();
    const mime = content?.mime ?? 'application/octet-stream';
    const format = FORMATS[name.split('.').pop()?.toLowerCase() ?? ''];
    const versions: Partial<Record<ConvertedKind, ConvertedVersion>> = format === 'csv'
      ? { table: fixture(ConvertedVersion, { kind: 'table', converter: 'csvConverter', from: 'csv', tables: [{ headers: ['name', 'age', 'joined'], rows: [['Ada', '36', '2024-01-04']] }] }) }
      : format === 'html' ? { markdown: fixture(ConvertedVersion, { kind: 'markdown', converter: 'htmlConverter@2', from: 'html', text: '# Release notes' }) }
        : format === 'pdf' ? { pages: fixture(ConvertedVersion, { kind: 'pages', converter: 'pdfConverter', from: 'pdf', pages: ['Harness guide'] }) } : {};
    return this.#put(`${HUB_RESOURCE_ROOT}uploads/2026-11-07/${name}`, { name, mime, size: bytes.length, ...(format === undefined ? {} : { format }) }, bytes, mime, {
      system: 'hub', ago: 0, versions, ...(format === 'audio' ? { made: { transcript: '[0:00] A tone.' } } : {}),
    });
  }

  rename(uri: ResourceUri, name: string): ResourceRecord {
    const entry = this.#entry(uri);
    entry.record = fixture(ResourceRecord, { ...entry.record, stat: { ...entry.record.stat, name } });
    return entry.record;
  }

  remove(uri: ResourceUri): { deleted: boolean; referencedBy: number } {
    return { deleted: this.#entries.delete(uri), referencedBy: 0 };
  }
}
