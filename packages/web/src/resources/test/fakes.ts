/**
 * Test doubles for the resources area: resource records of every common type (parsed through the hub's schemas, so
 * they are real records), the forms the hub would have made for them, callers answering from them, a `fetch` for
 * presigned URLs, and the stores built on them.
 */
import {
  ConvertedVersion, FormRecord, ResourceQuery, ResourceRecord, ResourceRoot, ResourceStat, ResourceUri, type FormKind, type FormOffer, type ResourceFacet,
} from '@harness/core';
import { ref } from 'vue';
import { fakeSender } from '../../chat/test/fakes.ts';
import { fakeCaller } from '../../test/fakes.ts';
import type { FetchUrl, ResourceChange, ResourceEvents } from '../api/resources.ts';
import { ResourcesStore } from '../state/resources.ts';
import type { SystemViewers } from '../state/viewer.ts';

const HASH = 'a'.repeat(64);
const SEEN = 1_700_000_000_000;

/** A resource record, parsed through the hub's schema. */
export function record(uri: string, stat: { name: string; format?: string; mime?: string; size?: number; type?: 'file' | 'folder' | 'page' }, extra: { forms?: FormKind[]; system?: string } = {}): ResourceRecord {
  return ResourceRecord.parse({
    uri, system: extra.system ?? 'fs', links: [], seenAt: SEEN,
    stat: { uri, type: 'file', version: '1', ...stat },
    ...(extra.forms === undefined ? {} : { forms: extra.forms }),
  });
}

/** One of each common type. */
export const FIXTURES: readonly ResourceRecord[] = [
  record('fs://work/README.md', { name: 'README.md', format: 'markdown', size: 1_200 }, { forms: ['markdown'] }),
  record('fs://work/src/main.ts', { name: 'main.ts', format: 'typescript', size: 480 }),
  record('fs://work/data/people.csv', { name: 'people.csv', format: 'csv', size: 90 }, { forms: ['table'] }),
  record('fs://work/data/book.xlsx', { name: 'book.xlsx', format: 'excel', size: 9_000 }, { forms: ['table'] }),
  record('fs://work/art/logo.png', { name: 'logo.png', format: 'image', mime: 'image/png', size: 3_000 }, { forms: ['description'] }),
  record('fs://work/art/mark.svg', { name: 'mark.svg', format: 'svg', mime: 'image/svg+xml', size: 300 }),
  record('fs://work/docs/guide.pdf', { name: 'guide.pdf', format: 'pdf', size: 40_000 }, { forms: ['pages'] }),
  record('fs://work/package.json', { name: 'package.json', format: 'json', size: 220 }),
  record('hub://resources/uploads/talk.mp3', { name: 'talk.mp3', format: 'audio', mime: 'audio/mpeg', size: 80_000 }, { forms: ['transcript'], system: 'hub' }),
];

/** The raw text of the text fixtures, by URI. */
export const TEXTS: Readonly<Record<string, string>> = {
  'fs://work/README.md': '# Harness\n\nA hub and systems.\n\n```mermaid\ngraph TD; A-->B\n```\n\n$$e = mc^2$$',
  'fs://work/src/main.ts': "import { start } from './app';\n\nstart();\n",
  'fs://work/data/people.csv': 'name,age\nAda,36\n"Lovelace, Ada",37\n',
  'fs://work/package.json': '{ "name": "harness", "private": true, "workspaces": ["packages/core"] }',
  'hub://resources/uploads/talk.mp3': '',
};

/** The converted versions of the fixtures, by URI and form. */
export const VERSIONS: Readonly<Record<string, ConvertedVersion>> = {
  'fs://work/data/book.xlsx#table': ConvertedVersion.parse({
    kind: 'table', converter: 'xlsx', from: 'excel',
    tables: [{ name: 'People', sheetName: 'People', headers: ['name', 'age'], rows: [['Ada', '36'], ['Grace', '45']] }, { name: 'Places', headers: ['city'], rows: [['London']] }],
  }),
  'fs://work/data/people.csv#table': ConvertedVersion.parse({ kind: 'table', converter: 'csv', from: 'csv', tables: [{ headers: ['name', 'age'], rows: [['Ada', '36']] }] }),
  'fs://work/docs/guide.pdf#pages': ConvertedVersion.parse({ kind: 'pages', converter: 'pdf', from: 'pdf', pages: ['Page one text.', 'Page two text.'] }),
};

/** A form record of a kind. */
export function formRecord(kind: FormKind): FormRecord {
  return FormRecord.parse({ hash: HASH, kind, converter: 'test@1', content: { hash: HASH, size: 10, mime: 'text/plain' }, chars: 10, tokens: 3, createdAt: SEEN });
}

/** The facets of a grouping over the fixtures. */
function facetsOf(records: readonly ResourceRecord[], group: ResourceQuery['group']): ResourceFacet[] {
  if (group === undefined) { return []; }
  const counts = new Map<string, number>();
  for (const r of records) {
    const value = group === 'source' ? r.system : group === 'path' ? r.uri.split('/').slice(0, 3).join('/') : r.stat.format ?? 'other';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, label: value, count }));
}

/** The resource callers, answering from the fixtures. `offers` are forms that could be made for every resource. */
export function fakeResourcesApi(options: { records?: readonly ResourceRecord[]; offers?: readonly FormOffer[] } = {}) {
  const records = [...(options.records ?? FIXTURES)];
  const find = (uri: string): ResourceRecord => {
    const found = records.find((r) => r.uri === uri);
    if (found === undefined) { throw new Error(`no resource ${uri}`); }
    return found;
  };
  const browse = (query: ResourceQuery): Promise<{ items: ResourceRecord[]; facets: ResourceFacet[] }> => {
    const words = (query.search ?? '').toLowerCase();
    const items = records.filter((r) => (words === '' || r.uri.toLowerCase().includes(words)) && (query.under === undefined || r.uri.startsWith(query.under))
      && (query.in === undefined || facetsOf([r], query.group)[0]?.value === query.in));
    return Promise.resolve({ items: items.slice(0, query.limit ?? 60), facets: facetsOf(items, query.group) });
  };
  return {
    browse: fakeCaller<'browseResources'>((query) => browse(ResourceQuery.parse(query ?? {}))),
    browseGroup: fakeCaller<'browseResources'>((query) => browse(ResourceQuery.parse(query ?? {}))),
    find: fakeCaller<'browseResources'>((query) => browse(ResourceQuery.parse(query ?? {}))),
    forms: fakeCaller<'resourceForms'>(({ uri }) => {
      const found = find(uri);
      return Promise.resolve({ record: found, forms: (found.forms ?? []).map(formRecord), offers: [...(options.offers ?? [])] });
    }),
    read: fakeCaller<'readResource'>(({ uri, form }) => {
      const text = form === undefined || form === 'raw' ? TEXTS[uri] ?? '' : `The ${form} of ${uri}`;
      return Promise.resolve({ uri, form: form ?? 'raw', text, offset: 0, total: text.length, truncated: false, forms: find(uri).forms ?? [], offers: [] });
    }),
    convert: fakeCaller<'convertResource'>(({ kind }) => Promise.resolve(formRecord(kind))),
    download: fakeCaller<'downloadResource'>(({ uri, form }) => Promise.resolve({ url: `https://files.test/${encodeURIComponent(uri)}${form === undefined ? '' : `#${form}`}`, mime: find(uri).stat.mime ?? 'application/octet-stream', size: 10 })),
    importResource: fakeCaller<'importResource'>((args) => Promise.resolve(record(`hub://resources/${'url' in args ? 'web/page' : args.name}`, { name: 'url' in args ? 'page' : args.name }, { system: 'hub' }))),
    rename: fakeCaller<'renameResource'>(({ uri, name }) => Promise.resolve(record(uri, { name }, { system: 'hub' }))),
    remove: fakeCaller<'deleteResource'>(() => Promise.resolve({ deleted: true, referencedBy: 0 })),
    contextFrom: fakeCaller<'contextFromResource'>(() => Promise.resolve({ created: [], updated: [], links: 0 })),
    upload: fakeCaller<'upload'>(({ name }) => Promise.resolve({ url: `/_files?put=${name}`, upload: `up_${name}` })),
    uploaded: fakeCaller<'uploaded'>(() => Promise.resolve({ hash: HASH, size: 3, mime: 'text/plain' })),
    systemRead: fakeCaller<'resource'>(({ uri }) => Promise.resolve({ stat: { uri, name: 'system.md', type: 'file', format: 'markdown', version: '1' }, text: { inline: '# From the system' } })),
    exploreRoots: fakeCaller<'exploreRoots'>(() => Promise.resolve([EXPLORE_ROOT])),
    exploreList: fakeCaller<'exploreList'>(({ uri }) => Promise.resolve({ items: [...(EXPLORE_TREE[uri] ?? [])] })),
    exploreRead: fakeCaller<'exploreRead'>(({ uri }) => Promise.resolve({ stat: exploreEntry(uri, 'file'), text: { inline: `// ${uri}\nexport const answer = 42;\n` } })),
  };
}

/** The explorer's one root on the fake fs instance, and its folders' entries by uri. */
export const EXPLORE_ROOT = ResourceRoot.parse({ uri: 'file:///work', name: 'work', description: 'The work folder', index: 'none', ignore: [], watch: false });
/** An entry of the fake explorer tree. */
export function exploreEntry(uri: string, type: 'folder' | 'file'): ResourceStat {
  return ResourceStat.parse({ uri, name: uri.split('/').at(-1), type, version: '1', ...(type === 'file' ? { size: 1_200, modifiedAt: 1_789_000_000_000 } : {}) });
}
export const EXPLORE_TREE: Readonly<Record<string, readonly ResourceStat[]>> = {
  'file:///work': [exploreEntry('file:///work/src', 'folder'), exploreEntry('file:///work/README.md', 'file')],
  'file:///work/src': [exploreEntry('file:///work/src/app.ts', 'file'), exploreEntry('file:///work/src/lib', 'folder')],
  'file:///work/src/lib': [],
};

/** The fake resource callers. */
export type FakeResourcesApi = ReturnType<typeof fakeResourcesApi>;

/** A `fetch` for presigned URLs: converted versions from `VERSIONS` (by URI and form), anything else as bytes. */
export const fakeFetch: FetchUrl = (url) => {
  const key = decodeURIComponent(url.replace('https://files.test/', ''));
  const version = VERSIONS[key];
  return Promise.resolve(version === undefined ? new Response(new Uint8Array([1, 2, 3])) : new Response(JSON.stringify(version), { headers: { 'content-type': 'application/json' } }));
};

/** A resource-change channel a test pushes changes into. */
export function fakeResourceEvents(): { readonly subscribe: ResourceEvents; push(change: ResourceChange): void; readonly listeners: number } {
  const listeners = new Set<(change: ResourceChange) => void>();
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push: (change) => { for (const listener of listeners) { listener(change); } },
    get listeners() { return listeners.size; },
  };
}

/** No system viewers, with a version a test can bump. */
export function fakeSystemViewers(viewers: ReturnType<SystemViewers['viewers']> = []): SystemViewers {
  return { viewers: () => viewers, client: () => ({ online: true, send: {}, run: {} }), version: ref(0) };
}

/** The resources store on fakes. */
export function fakeResources(options: { api?: FakeResourcesApi; systems?: SystemViewers } = {}) {
  const api = options.api ?? fakeResourcesApi();
  const events = fakeResourceEvents();
  const sender = fakeSender();
  const resources = new ResourcesStore({ api, events: events.subscribe, sender, fetch: fakeFetch, systems: options.systems ?? fakeSystemViewers(), prepare: () => Promise.resolve() });
  return { resources, api, events, sender };
}

/** A URI, parsed. */
export const uri = (text: string): ResourceUri => ResourceUri.parse(text);
