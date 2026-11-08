# Resources, build 2: storage, converted versions, fetching, viewers and the browser

Research for build 2's resource work: what `@aeye/resources` does today, what harness does with it, what product
planned (`product/design/resources.md`), and a proposal for raw storage on the hub, converted versions for LLMs,
sectioning from the converted version, resource-to-context, http(s) fetching with rendering, viewers for every common
type and the resource browser's views. The last sections split the work between the library lane
(`@aeye/resources`) and the hub, web and systems lanes.

Sources read (2026-11-07): `aits/packages/resources` (branch `harness`, v0.3.9: `src/**`, the four `aeye-resources*.md`),
harness `packages/core/src/{resources,link,web}.ts`, `records/content.ts`, `records/tables.ts`,
`packages/hub/src/link/resources.ts`, `index/{sectioners,sectioning,indexer}.ts`, `api/files.ts`, `boot/hub-fns.ts`,
`packages/sdk/src/{client,hub}.ts`, `systems/fs/server/{resources,documents}.ts`, `packages/web/src/chat/components/ResourceView.vue`,
`admin/views/ResourcesView.vue`, `ui/markdown/highlight.ts`, `ui/UiImageViewer.vue`, `@ayepi/files` (`FileStore`, `mountFiles`),
cletus's `operations/internet.tsx` (prior art for Tavily and puppeteer).

Contents:

1. What `@aeye/resources` does today
2. What harness does today, and the gaps
3. What product planned that still applies
4. The model: a resource, its original and its converted versions
5. Storage: hub files by default, the database as an option
6. Converting: which version each format gets
7. Sectioning from the converted version
8. Resource to context, and resource to message content
9. http(s): fetching, rendering script-heavy pages, the web system
10. Fns the chat LLM needs
11. Viewers for every common type, with preview and source modes
12. The resource browser: list, thumbnails, groups and folders
13. Who builds what: `@aeye/resources` vs the hub, web and systems
14. Contract changes for the orchestrator
15. Tunables
16. Dependencies to install
17. Phasing and tests
18. Open questions

---

## 1. What `@aeye/resources` does today

Pipeline: **resolve** (input → `ResourceSource`) → **parse** (`ParsedResource`: `parts`, `links`, `children`) →
**slice** (`ResourceSlice[]` with `embedText`). `ResourceRegistry.load/parse/parseSource/slice`, everything registry
driven, per-type config through `configureType`. `createDefaultResourceRegistry()` (`@aeye/resources/default`)
registers all built-ins.

**Type detection.** `inferType(location, mime?)` from registry maps (extensions longest-suffix first, mime patterns win,
Dockerfile by name). Types are free strings: `markdown`, `html`, `pdf`, `docx`, `excel`, `csv`, `tsv`, `image`, `zip`,
`json`, `yaml`, `xml`, `svg`, `toml`, `ini`, `text`, and every `CODE_TYPES` language. No `audio`, `video`, `pptx`,
`notebook` or `mermaid` type.

**Parsers (what it converts).**

| Type | Parser (priority) | Output |
|---|---|---|
| text, json, csv*, tsv*, yaml, xml, svg, toml, ini | `textParser` | one UTF-8 text part; bare URLs; `href`/`src` for markup types (xml, svg) |
| markdown | `markdownParser` | one text part, markdown links + URLs, slicer `markdown` |
| html | `htmlParser` | `htmlToMarkdown` (hand-rolled: headings, `li`, `br`, `img`, block breaks; `script`/`style` stripped) and `href`/`src` links. Calls `options.renderUrl(url)` first when the source is http(s) and a renderer is configured |
| code (all `CODE_TYPES`) | `codeParser` | text part; import/require links; slicer `code` |
| image | `imageParser` | an image part (bytes) plus optional text parts from `transcribeImage` (OCR-like) and `describeImage` callbacks |
| pdf | `pdfRenderParser` (10) → `pdfParser` (0) | render: poppler page images as children, optional transcription per page; base: `pdf-parse` text as **one** part, `metadata.pages` |
| excel, csv, tsv | `excelPdfParser` (10) → `excelParser` (0) | via PDF when `convertToPdf` + `renderPages`; base: `xlsx`, one text part per sheet holding markdown tables, table regions split on empty rows, `metadata.structuredTables: ExtractedTable[]` (`headers`, `rows` as strings) |
| docx | `docxPdfParser` (10) → `docxParser` (0) | via PDF, or `mammoth` → HTML → markdown |
| zip | `zipParser` | entries parsed through the registry as children |

Optional peers, loaded lazily: `pdf-parse`, `mammoth`, `xlsx`, `jszip`, `node-poppler`, `@langchain/textsplitters`. They
are installed in `aits/node_modules`, and because harness links the package, the dynamic imports resolve from there.
Poppler binaries are on this machine's PATH (`pdftoppm`); LibreOffice (for `convertToPdf`) and tesseract are not.

**Slicers / sectioners.** `text` (any type, boundary split), `markdown` (heading-aware, for markdown and html),
`code` (top-level declarations, import prefixes). Stable structural keys: `sectionKeys`, `splitMarkdownSections`,
`splitCodeBlocks` (harness's hub sectioners use these). Pluggable `TextSegmenter` (lossless default, LangChain for
overlap/tokens). `summarize` callback adds resource and section summaries, cached on `resource.metadata`.

**Fetch.** `urlResolver`: `fetch` with timeout (30 s) and byte cap (50 MiB), streaming body, `Last-Modified`,
`Content-Length`, `HEAD` stat; relative links resolved against an http(s) base. `buildResourceGraph` crawls (bounded:
same origin, 1000 nodes). No rendering implementation is shipped: `renderUrl` is only a callback type.

**Shortfalls for build 2** (each becomes a library task in section 13):

- `metadata` is `Record<string, unknown>` everywhere; tables (`structuredTables`), page counts and the HTML original
  are untyped, so harness can't read them without casts.
- No notion of "converted versions": a parse yields parts; the markdown of an html page and the tables of a workbook are
  not named outputs.
- `htmlToMarkdown` loses link targets (`<a>` becomes plain text), tables, `pre`/`code` fences, emphasis, blockquotes, and
  keeps nav/header/footer boilerplate.
- `pdfParser` emits one part with pages joined by `\n\n` (pdf-parse 1.1.4 `ret.text += '\n\n' + pageText`). Harness's
  `hub/pages` sectioner splits on `\f`, so **every PDF is one "page" today**.
- Table cells are strings; no column types, no row cap for huge sheets, CSV goes through `xlsx` (fine, but a 200 MB CSV
  is read whole).
- No `renderUrl` implementation, no "does this page need rendering" check, no final-URL-after-redirect, no charset
  handling (decoded as UTF-8 always), no injectable `fetch`.
- No audio/video/pptx/notebook types, no thumbnail capability, no parser version (cached conversions can't tell they
  are out of date when the library improves).
- Still open from build 1: a folder resolver.

## 2. What harness does today, and the gaps

- **Contracts** (`core/resources.ts`): `ResourceStat` (`type` folder/file/page/record/other, `mime`, `format`, `size`,
  `version`), `ResourceRead` (`stat`, `links`, `text` inline or by ref, `bytes` ref), `Section` (key, path, title,
  offsets), `ResourceRoot`, `ResourceLink`, `Link`, `ResourceHit`. `ReadWant` = links | text | bytes.
- **Hub router** (`link/resources.ts`, `PeerResourceRouter`): routes a URI to the system whose root holds it (longest
  root), read/list/stat/sections over the link, large text fetched in chunks. The hub itself **serves no resources**:
  there is no hub root, so an upload, a fetched web page or a fn's output cannot be a resource.
- **Hub record** (`ResourceRecord`): uri, system, stat, links, indexed version, sectioner, seenAt. **No raw data, no
  converted data, no source** (upload, web, system) stored.
- **Content store** (`api/files.ts`, `FileContentStore`): content-addressed bytes on an `@ayepi/files` `FileStore`
  (`content/<sha-256>`), presigned upload and download (`mountFiles`, which sets `Content-Length` and supports Range).
  This is the right foundation for raw storage; it is only used for chat uploads and attachments now.
- **Sectioning** (`index/sectioners.ts`, `sectioning.ts`): hub sectioners `whole`, `headings` (markdown), `symbols`
  (code globs), `pages` (pdf, splits on `\f`, see above), `paragraphs`; user rules beat system defaults; they cut the
  text the system returned from `read`.
- **fs system** (`systems/fs/server/{resources,documents}.ts`): converts through `@aeye/resources` itself and returns
  `text` inline. It **never returns `bytes`**, even when asked, and returns nothing at all above `textMax`, so the hub
  can't show an image, a PDF, audio or video, and large files show "too large".
- **Web** (`ResourceView.vue`): markdown rendered, everything else in `UiCodeBlock` (the in-house highlighter knows ~12
  language families), a system's own viewer when registered. No images, PDF, tables, media, JSON tree, preview/source
  switch, or converted-version switch. `ResourcesView.vue` is a flat list with search and a system filter.
- **LLM fns**: only `hub/search_resources`. The chat LLM can't read a resource, a section or a converted version, can't
  import a URL and can't turn a resource into context.

## 3. What product planned that still applies

From `product/design/resources.md`, worth carrying over (adapted to harness's names):

- **A resource always has a text form.** Images fall back to their description, audio/video to a transcript, binaries to
  their extracted markdown. The text form is what LLMs and sectioning use.
- **Resource → message content is per part and model-aware** (`resourceToContent(resource, modelCaps)`): an image goes
  as an image part only to a vision model, else as its description text; a PDF as a file part only when the model takes
  files, else its text; audio likewise; text formats always as text. It never fails: worst case one text part.
- **Describe/transcribe/render hooks wired to the hub's AI** (`describeImage`, `transcribeImage`, `renderUrl`,
  `renderPdfPages`).
- **Shared front-end pieces**: a viewer (zoom/pan, PDF page nav and thumbnails, original ↔ markdown side by side,
  highlighted code, audio/video), a thumbnail chip, an action menu (download, replace, rename, delete with "referenced by
  N", convert to context, run a fn on it, refresh, reprocess), a picker and an uploader (drop, paste, URL), and a
  resource page with list and thumbnail views, filters on every property, folders and bulk select.
- **Credentials in URLs**: strip credential-bearing query parameters from the stored name and description, keep the
  full URL only as the location (product's decided approach). Harness should do the same from day one.

What does not carry over: product's single `resource` table with `parentId` folders. In harness resources are served by
systems at URIs, so folders come from the URI path, and the hub stores only what it owns (section 4).

## 4. The model: a resource, its original and its converted versions

Words used below:

- **Original**: the resource's own bytes, as served or uploaded.
- **Version**: harness already uses `ResourceStat.version` for "which content". A **converted version** of one content
  version is a **form** (a plain word, and it doesn't collide): `markdown`, `text`, `tables`, `description`, `ocr`,
  `transcript`, `pages`, `thumbnail`, `outline`. "Each of these versions could be displayed" in the owner's words maps to
  "each form can be viewed".
- **Primary form**: the one LLMs, sectioning and the index use by default (markdown for documents, tables for
  spreadsheets, the text for text and code, description + OCR for images, transcript for media).

Two kinds of resources:

1. **System resources** (fs files, a database row, ...): the system serves the original at its URI, as today. The hub
   keeps a **snapshot**: the original's content ref when it was fetched, and the forms made from it.
2. **Hub resources**: the hub is the owner, under a hub root `hub://resources/`. Sources: an upload, a URL fetched by the
   web system or by `hub/resource_import`, a fn's output (an attachment, a generated image, a transcription), a message
   attachment. Their originals live only in the hub's content store.

**Forms are cached by content hash, not by URI.** A form's key is `(original hash, form kind, converter id, converter
version)`. The same bytes at two URIs, or a file that is renamed, are converted once; an image is described once no
matter how many messages attach it; a library upgrade (new converter version) redoes only what it touches. A resource
version points at its original hash; its forms are found through that hash.

## 5. Storage: hub files by default, the database as an option

**Originals and forms both go in the content store** (`ContentStore`, content-addressed, chunked reads, presigned
downloads with Range). Nothing new is needed for the default: `FileContentStore` over `fsFiles({ root: <data>/content })`.

**The database option** is a second `FileStore` implementation over the hub's database (a `blobs` table: key, bytes,
mime, size, createdAt), selected by an env tunable (`HARNESS_CONTENT_AT=files|database`). Because `FileContentStore`
and `mountFiles` take any `FileStore`, choosing the database is a different store at boot, with no other code changing.
This belongs in `@ayepi/sqlite` (`sqliteFiles(db)`), since ayepi already owns `FileStore`, `fsFiles` and `s3Files`;
record it as a library ask. Until it exists the store lane can add a `TableFiles implements FileStore` over
`HubStore` (the interface is five methods) and drop it once ayepi has one.

Notes:

- SQLite handles blobs well into the tens of MB; very large originals (video) are better on files. Allow a per-store
  cap (`HARNESS_CONTENT_DB_MAX`, above which `database` mode still writes to files and records where), or simply
  document that database mode is for small deployments. Recommendation: keep one mode per hub, no mixing, and refuse
  imports above `maxImport` in either mode.
- **Snapshots of system resources** are a cache: an LRU by total bytes (`HARNESS_SNAPSHOT_MAX`) may drop the original of
  a system resource (the system can serve it again) but keeps its small forms (markdown, tables, description), which are
  the expensive part. Hub resources are never evicted: the hub is their only home.
- **Deleting**: a content hash is removed when nothing refers to it (resource versions, messages, attachments, forms).
  A sweep finds unreferenced hashes; product's "unreferenced report" becomes an admin view of the same query.

Records (sketch, core owns the final shape):

```ts
/** A converted form of some content. */
export const FORM_KINDS = ['markdown', 'text', 'tables', 'description', 'ocr', 'transcript', 'pages', 'thumbnail', 'outline'] as const;
export const FormKind = z.enum(FORM_KINDS);

/** Where a resource came from. */
export const ResourceSource = z.discriminatedUnion('from', [
  z.object({ from: z.literal('system'), system: SystemName }),
  z.object({ from: z.literal('upload'), by: ActorId }),
  z.object({ from: z.literal('web'), url: z.url(), fetchedAt: Timestamp, rendered: z.boolean(), finalUrl: z.url().optional() }),
  z.object({ from: z.literal('run'), run: RunId, fn: QualifiedName }),
]);

/** One stored form: what made it, and where its bytes are. */
export const FormRecord = z.object({
  hash: z.string().regex(CONTENT_HASH),   // the original's hash
  kind: FormKind,
  converter: z.string(),                   // `@aeye/resources:html-parser@3`, or `model:<id>` for a description
  content: ContentRef,                     // the form's bytes (markdown text, tables JSON, png pages...)
  /** The model call that made it, when one did (descriptions, OCR, transcripts): its cost is on that record. */
  call: ModelCallId.optional(),
  createdAt: Timestamp,
});

// ResourceRecord gains:
//   source: ResourceSource
//   original: ContentRef.optional()         (absent until fetched, for system resources)
//   forms: z.array(FormKind)                (which forms exist for the current version, for the browser badges)
//   primary: FormKind.optional()            (what sectioning and the LLM use)
```

`tables` content is JSON of a typed `TableSet` schema (section 6), so the browser and the LLM fns parse it with one zod
schema.

## 6. Converting: which form each format gets

Conversion runs **on the hub** with one shared registry configuration (`createDefaultResourceRegistry()` plus the hub's
callbacks), from the original's bytes. Systems may still send forms they made themselves (fs already converts, and has
the file locally); a system-supplied form is stored the same way, under its converter id. One converter config means a
markdown file looks the same whichever path produced it.

| Format family | Original kept | Forms (primary first) | How |
|---|---|---|---|
| markdown, text, code, json, yaml, toml, xml, log | yes | `text` (it is its own text) and `outline` (headings/symbols) | registry text/markdown/code parsers |
| html (file or fetched) | yes (the fetched or rendered HTML) | `markdown`, `outline` | better `htmlToMarkdown` (section 13), main-content extraction on by default for web pages |
| svg, mermaid | yes | `text` (source) | the source is the LLM form; preview is the viewer's job |
| pdf | yes | `markdown` (per-page text, pages separated so `pages` works), `pages` (page images, on demand), `ocr` (scanned pages, on demand), `thumbnail` (page 1) | pdf-parse per page; poppler render; vision model for scanned pages |
| docx, odt, rtf | yes | `markdown`, `outline` | mammoth (docx); others later |
| pptx | yes | `markdown` (one section per slide, speaker notes), `thumbnail` | new parser (jszip + slide XML) |
| xlsx, xls, ods, csv, tsv | yes | `tables` (typed), `markdown` (capped preview of each table) | xlsx; streamed CSV for large files |
| image (png, jpg, gif, webp, avif, bmp, heic) | yes | `description`, `ocr`, `thumbnail` | vision model through the hub provider (a `ModelCall`), lazily |
| audio (mp3, wav, m4a, ogg, flac) | yes | `transcript` | the transcription model the admin picks (build 2 adds that setting) |
| video (mp4, webm, mov) | yes | `transcript` (audio track), `thumbnail` (a frame, later) | transcription; frame grab needs ffmpeg, so later |
| zip | yes | `text` (entry list); entries become child resources | zipParser |
| ipynb | yes | `markdown` (cells, outputs as text) | new small parser |

**Tables, typed** (library schema, exported with zod-free TS types the hub mirrors in core with zod, pinned by an
`Equal` test, or the library exports zod schemas; see section 13):

```ts
TableSet = { tables: Table[] }
Table    = { name: string; sheet?: string; columns: { name: string; type: 'text' | 'number' | 'integer' | 'boolean' | 'date' | 'empty' }[];
             rows: Cell[][]; rowCount: number; truncated: boolean }
Cell     = string | number | boolean | null   // dates as ISO strings, typed by the column
```

Column types are inferred from the cells (all numbers → number; all ISO-ish dates → date). `rows` is capped
(`maxTableRows`) with `rowCount` telling the real size; the LLM fns can page rows (section 10).

**When forms are made.** Cheap forms (text, markdown, tables, outline) are made when a resource is indexed or first
read. Model-made forms (description, ocr, transcript) are made **on demand** by default: when the LLM reads the resource,
when a user presses "Describe" / "Transcribe" in the viewer, or when the root's index policy says `all` and the admin
turned on `describeOnIndex`. Each such call is a `ModelCall` attributed to the run or indexing job that asked (build 2's
"nothing bypasses the hub"), so its cost shows. A run that needs a form waits on one conversion job per (hash, kind),
so two readers never pay twice.

**OCR where available.** No OCR engine is installed. OCR is "transcribe the text in this image" through a vision model
(the `transcribeImage` callback), which also covers scanned PDF pages (render with poppler, transcribe each page). A
local engine (`tesseract.js`, pure JS/WASM) is an optional later converter registered with a higher priority than the
model path when present; the form records which converter made it.

## 7. Sectioning from the converted version

Sections are cut from the **primary form** by default, not from the raw bytes:

- html → its markdown, so `hub/headings` works on web pages (today the markdown slicer already handles html in the
  library; the hub's `headings` matches `format: 'markdown'` only).
- pdf → per-page markdown; `hub/pages` splits on the page separator the library emits (`\f`, which the library fix adds),
  and `hub/headings` is offered when the text has headings.
- spreadsheets → a new hub sectioner `hub/tables`: one section per table, large tables split into row groups
  (`Sheet1 > rows 1-200`) with the header row repeated in each section's embed text. Keys from structure (sheet, table
  name, row range bucket), so adding a row at the end changes only the last group.
- images → one section over description + OCR; audio/video → transcript sections by time (`00:05:00-00:10:00`) when the
  transcriber returns segments, else paragraphs.
- pptx → one section per slide (`Slide 3: Title`).

Contract: `Section` gains `form: FormKind` (offsets are into that form's text); `SectionMatch` gains `form?: FormKind`
so a rule can pick a sectioner per form (for example `tables` for any `tables` form). A user's section rule may also
choose the form (`markdown` vs `text` for an html file, to cut the raw source instead). `SectionDiff` and stale context
work unchanged, since they compare keys.

The hub's own sectioners then all run in the hub over a form's text; a system sectioner still runs on its system and
receives the form kind with the call.

## 8. Resource to context, and resource to message content

**Resource → context.** Build 2 makes context a graph (decided: context items link to context, fns, types and
resources with weighted edges). A resource becomes context in three ways:

1. **`hub/context_from_resource`** (an fn, also a button in the viewer and the browser's action menu): makes a context
   item from a resource or chosen sections, with a name, description and `/command` name. Two modes:
   - `live`: the item's content is read from the resource's primary form at load time (always current; stale-free);
   - `snapshot`: the text is copied now; the item is marked stale when a source section changes (the existing
     `SectionDiff` rule).
   The item records its sources (`{ resource, sections, version }`) and gets a `resource` edge back to them, so the graph
   contextor can walk from the context to the resource and from a resource to the context made from it.
2. **Section hits as context**: the graph contextor (build 2) may pull sections it scores highly straight into the
   prompt as context, budgeted by the model's context and output limits; a section is context-shaped already (title,
   path, text, resource name).
3. **System-declared context** that refers to resources (an fs `guide` that points at `docs/`).

Budgeting for small models: every form records its size in characters and an estimated token count, so the contextor
can choose `outline` or a summary over the full markdown when the budget is small, without reading the text first.

**Resource → message content** (chat attachments, an agent's resource arg, `hub/resource_send`): one hub function,
`toMessageContent(resource, model): MessageContent[]` (aeye core's `MessageContent`), with the downgrade rules from
section 3 using `@aeye/models` capabilities of the model actually chosen for the request. It lives in the hub's execution
module (it needs the chosen model), and it calls the forms service for the text fallbacks, so an image attached for a
text-only local model is described once and sent as text.

## 9. http(s): fetching, rendering script-heavy pages, the web system

Build 2 adds a **web system** (Tavily search plus fetching). Split:

- **Web system** (`systems/web`, its own process, so Chromium is not in the hub): fns `web/search` (Tavily),
  `web/fetch` (a URL into a hub resource), `web/crawl` (bounded `buildResourceGraph`). It serves the `https://` and
  `http://` roots as resources: a read fetches the URL through `@aeye/resources`' `urlResolver` and, when the page needs
  it, the puppeteer renderer; it returns the original bytes (the rendered HTML for a rendered page) by content ref and
  the final URL. Puppeteer is already a harness dev dependency; the web system makes it a real dependency.
- **The hub** stores the snapshot (original + forms) as for any resource, converts with the shared registry, and keeps
  the `web` source (url, final url, fetched at, rendered or not). Re-fetching makes a new version when the hash changes.
- **`@aeye/resources`** owns the fetch and render mechanics (section 13): `createPuppeteerRenderer()` (an optional peer,
  like poppler), a `needsRendering(html, response)` check, redirects, charset, an injectable `fetch`.

**When to render** (`renderMode: 'auto' | 'always' | 'never'`, per call and as a tunable, default `auto`). `auto` fetches
plainly first, then renders when the plain HTML looks script-built: little visible text after stripping (under ~500
characters) while scripts are large or many, an empty app root (`<div id="root"></div>`, `id="app"`, `__next`), a
`<noscript>` asking to enable JavaScript, or a known SPA marker. The check is a pure function, unit-tested on fixtures.

Renderer behaviour: one shared browser, a page per fetch (bounded concurrency), `waitUntil: networkidle2` with a cap,
images, fonts and media blocked (faster, less data), a fixed user agent, and the final URL and status returned.
`page.content()` after load gives the HTML the html parser converts. Screenshots of the page (a `thumbnail` form) are
cheap here and good for the browser's thumbnail view.

Safety: the fetcher refuses private and loopback addresses unless an admin allows them (SSRF; the hub's own data must
not be reachable by asking the LLM to fetch `http://127.0.0.1:4300/...`), honours the byte cap and timeout, and strips
credential query parameters from names and descriptions (section 3).

## 10. Fns the chat LLM needs

The chat LLM must be able to do and see everything (build 2 request). Hub fns, all with gin signatures in the hub's
contract, read-tagged where they only read:

| Fn | What it does |
|---|---|
| `hub/search_resources` (exists) | search sections by meaning and words |
| `hub/resource_list` | list a folder or root, or hub resources by source, type, date; paged |
| `hub/resource_read` | read a resource: `form` (default primary), `section`, `offset`/`maxChars` for paging, `rows` range for tables; returns which forms exist |
| `hub/resource_outline` | the sections (keys, titles, sizes) without the text, for choosing what to read on a small budget |
| `hub/resource_convert` | make a form now (`describe`, `ocr`, `transcribe`, `pages`); returns when done |
| `hub/resource_import` | a URL or content ref into a hub resource (URLs go to the web system when connected; plain fetch otherwise) |
| `hub/resource_send` | show a resource to the LLM as message content (image to a vision model) on the next step |
| `hub/context_from_resource` | section 8 |
| `hub/resource_delete`, `hub/resource_rename` | hub resources only; not read-tagged, so they ask the user |

Results are typed gin values (`ResourceStat`, form lists, `Section` lists), so their renderers can show resource cards.

## 11. Viewers for every common type, with preview and source modes

A **viewer** is chosen by the resource's format family and its available forms; a system's own viewer for its format
(`client({ resources })`) wins, as today. The panel shows a **mode switch** (`UiSegmented`) built from what exists:
`Preview` / `Source` for types with both, then one tab per form (`Markdown`, `Table`, `Description`, `Text in image`,
`Transcript`, `Pages`), and an info tab (size, type, source, versions, sections, links, used-by). The mode is in the URL
(`?uri=...&view=source`), as every panel is. A form that doesn't exist yet but could be made shows a "Make it" button
(describe, OCR, transcribe) with the model and an estimated cost.

| Family | Preview | Source | Notes |
|---|---|---|---|
| image | `UiImageViewer` (exists: fit, zoom, pan) | — | EXIF/dimensions in info; description and OCR tabs |
| svg | `<img>` from a blob URL (scripts in an svg do not run inside `<img>`) | highlighted XML | never inline the SVG markup |
| markdown | `UiMarkdown` with mermaid fences drawn as diagrams | highlighted | relative links navigate to the resource they name (exists) |
| mermaid (`.mmd`, `.mermaid`) | diagram | highlighted | `mermaid` loaded lazily, `securityLevel: 'strict'`, theme follows light/dark |
| code (every language) | — | highlighted with line numbers, wrap toggle, go to line, symbols outline from sections | see highlighting below |
| html | sandboxed `<iframe sandbox srcdoc>` (no scripts, no same-origin) | highlighted | plus the Markdown tab (what the LLM sees) |
| csv, tsv, xlsx, ods | table grid: sheet tabs, sticky header and first column, column types, sort, filter, virtual rows | csv/tsv highlighted text | from the `tables` form; "showing 1,000 of 52,000 rows" with paging through `resource_read` |
| pdf | pages with a page strip and page numbers in the URL (`#page=3`), zoom, text selection | — | `pdfjs-dist` lazily (the browser's built-in viewer varies, and on iOS shows only the first page in an iframe); Text tab |
| docx, pptx | the markdown form rendered (slides as cards) | — | download for the original |
| audio | `<audio controls>`, transcript beside it, clicking a line seeks | — | needs Range (the content route has it) |
| video | `<video controls playsinline>`, transcript | — | same |
| json, jsonl | collapsible tree: search, expand to depth, copy path and value, large arrays paged | highlighted | parse in a worker over a size cap |
| yaml, toml | — | highlighted | a tree view later, by parsing to JSON |
| text, log | — | plain with line numbers, wrap, follow-tail for a watched log | |
| zip, folder | entries as a list or grid (the browser's own views, section 12) | — | |
| anything else | info card, download, "open as text" when the bytes look like text | hex peek of the first bytes | |

**Highlighting.** The in-house highlighter (`ui/markdown/highlight.ts`) is safe (tokens drawn as text, never HTML) but
covers ~12 language families with keyword-level colouring. "Syntax highlighting of code" for every common type wants a
real grammar engine. Recommendation: **Shiki** (`shiki`, its fine-grained core with the JavaScript regex engine, grammars
loaded lazily per language), using `codeToTokens` and drawing the tokens as spans exactly as `UiCodeBlock` does now,
so the "never HTML" rule holds. Its `css-variables` theme maps token colours to design tokens, so light and dark follow
the design system. Keep `highlight.ts`'s `highlight(code, language)` signature as the interface, with Shiki as the
implementation and the current tokenizer as the synchronous fallback while a grammar loads.

**Code layout (web lane).** `packages/web/src/resources/`: `logic/viewers.ts` (pure: `viewerFor(stat, forms)` → viewer id
and modes; one table mapping families to viewers), `logic/families.ts` (or from core, see below), `state/resource.ts`
(the opened resource, its forms, the mode, loading of each form, made in the store not the component), `api/` callers,
and `viewers/` (`ImageViewer.vue`, `PdfViewer.vue`, `TableViewer.vue`, `JsonTree.vue`, `MediaViewer.vue`,
`HtmlPreview.vue`, `MermaidDiagram.vue`, `CodeViewer.vue`, `MarkdownViewer.vue`, `FolderViewer.vue`, `InfoPanel.vue`),
and `ResourceViewer.vue` that composes them and is provided under `RESOURCE_VIEWER` for system renderers (compact mode
for chat cards: a thumbnail and the first lines). The current `chat/components/ResourceView.vue` is replaced by it.

**Systems adding viewers** (decided yes in build 2): a system's `client({ resources: { <format>: Component } })` viewer
either replaces the preview for that format or adds a mode tab (a `mode: 'replace' | 'tab'` and a tab label in the
declaration), so a system can add, say, a "Schema" view of `.sql` files without losing the source view.

## 12. The resource browser: list, thumbnails, groups and folders

One page (`/resources`, today under admin; it deserves a top-level place in the app nav as well), everything in the URL:
`?view=list|grid|groups&group=type|source|path|date&path=<uri>&q=&system=&form=&uri=<opened>&mode=`.

- **List**: today's rows plus type icon, family, size, source, forms badges (`Markdown`, `Table`, `Described`), indexed
  state, modified time; sortable columns at wide sizes, a compact two-line row on phones.
- **Grid (thumbnails)**: cards with the `thumbnail` form (images: the image itself, downscaled by the browser with
  `loading=lazy`; pdf: page 1; web pages: the rendered screenshot; others: a large type glyph with the first lines of
  text). Card size slider; responsive columns.
- **Groups**: automatic grouping by
  - **type**: family (documents, code, images, tables, audio, video, web pages, data, archives, folders, other);
  - **source**: system (fs, each fs instance in a fleet), uploads, web by domain, fn outputs by fn;
  - **path**: a folder tree from URI segments (the left rail is a tree; selecting a folder narrows the list); a hub
    resource's path is its import path or `uploads/<date>`;
  - **date**: today, yesterday, this week, this month, earlier by month (modified time, or imported time for hub
    resources).
  Each group is a collapsible section with a count and its first page; "show all" narrows to that group (a URL change).
- **Filters**: search (words and meaning, from the index), family, source, forms present or missing ("not yet
  context", "not described"), size range, date range, "unused".
- **Actions** (product's action menu): open, download, rename/delete (hub resources), make context, describe/transcribe,
  re-fetch (web), reprocess (forms), copy URI, run a fn on it (fns whose first arg takes a resource), with bulk select in
  list and grid.
- **Uploader**: drop files or a folder, paste an image, paste a URL (goes through `hub/resource_import`).

Server side: the `resources` admin endpoint gains `group` and returns **facets** (counts per group value) with the page,
so groups and the tree don't need every row in the browser. Grouping keys are computed in the hub from one source:
a `FORMAT_FAMILY` map in core (format → family), also used by the web for icons and viewer choice.

Realtime: the browser follows `resources.changed` (exists) and a new `resources.forms` event (a form was made), so a
thumbnail or "Described" badge appears without a reload.

## 13. Who builds what: `@aeye/resources` vs the hub, web and systems

**`@aeye/resources` (library lane).** Everything about turning bytes or a URL into typed content, with no harness
knowledge:

1. **Named, typed forms**: a `convert(source, options)` result (or typed fields on `ParsedResource`) carrying
   `markdown?`, `text?`, `tables?: TableSet`, `pages?: { number, text }[]`, `outline?`, `images?` (page images), plus
   `converter: { id, version }`. Replace the untyped `metadata` reads harness needs (`structuredTables`, `pages`,
   `convertedFrom`) with typed fields. Export zod schemas for `TableSet` (and the form result) so harness derives its
   types from them, or export precise TS types and harness pins its zod mirror with a compile-time `Equal` test.
2. **Per-page PDF text**: pdf-parse `pagerender` collecting each page; one part per page with `pageNumber`; the combined
   text joins pages with `\f`.
3. **Typed tables**: column type inference, row cap with real row count, streamed CSV/TSV for large files, sheet and
   table names; markdown preview capped.
4. **Better `htmlToMarkdown`**: links as `[text](href)` (absolute against the base), tables, `pre`/`code` fences with
   language from the class, emphasis, blockquotes, `hr`, nested lists, entity decoding; a **main-content** option (drop
   `nav`, `header`, `footer`, `aside`, `form`, cookie banners; prefer `main`/`article`) on by default for http(s)
   sources. Pure, fixture-tested. (Owning it in the library beats adding a dependency in harness.)
5. **Fetching**: injectable `fetch` (tests, proxies), final URL after redirects on the source, charset from
   `Content-Type`/`<meta charset>`, `ETag`/`If-None-Match` and `If-Modified-Since` for cheap re-fetch, a
   `refusePrivateAddresses` option.
6. **Rendering**: `createPuppeteerRenderer({ launch?, concurrency, timeout, waitUntil, blockTypes, userAgent })`
   returning a `RenderUrlFn` that also reports final URL and status (extend `RenderUrlFn`'s result to
   `{ html, url, status }`), with `isPuppeteerAvailable()`; `needsRendering(html)` heuristic; `renderMode` option on the
   html parser (`auto` | `always` | `never`).
7. **New types and parsers**: `audio` and `video` types with a `transcribeAudio` callback (like `describeImage`);
   `pptx` parser (slides + notes → markdown); `notebook` (ipynb); `mermaid` and `svg` stay text types.
8. **Thumbnails**: a `renderThumbnail` callback option and a poppler first-page helper for pdf (image thumbnails can
   stay the image itself until a resize library is chosen).
9. **Converter versions** on every parser (`version: number`), so cached forms know when they are out of date.
10. **Table sectioning helper**: `splitTableSections(table, maxRows)` with structural keys (so the hub's `hub/tables`
    sectioner is a thin wrapper, like `headings` over `splitMarkdownSections`).
11. **Folder resolver** (open from build 1).

**`@ayepi/sqlite` (record as an ask):** `sqliteFiles(db)`, a `FileStore` over a SQLite table, for the database option.

**Hub (store, index, execution and api lanes; a new `resources/` module is cleanest):**

- `ResourceLibrary`: hub resources (`hub://resources/...`), imports (upload, URL, run output), rename/delete, the hub's
  own root registered with the router as a local provider.
- `Forms`: make, cache and look up forms by (hash, kind, converter); one job per key on `@ayepi/work`; model-made forms
  through the hub provider as `ModelCall`s; the snapshot cache and its eviction.
- Content store choice at boot (files or database), env slice.
- Sectioning from forms (`Section.form`), the `hub/tables` sectioner, `hub/pages` on the new separator.
- `toMessageContent(resource, model)` in execution; `hub/context_from_resource` in chat/context.
- The LLM fns in section 10, admin endpoints with facets, `resources.forms` events.

**Systems:**

- **fs**: return `bytes` (a content ref) when asked, for every file up to the import cap, so the hub can view and
  convert images, PDFs and media; keep sending its text as a form when it has it.
- **web** (new): search, fetch, crawl, the http(s) roots, puppeteer (section 9).

**Web (web lane):** the viewers and modes (section 11), the browser (section 12), the uploader and picker, the action
menu, `RESOURCE_VIEWER` compact mode.

## 14. Contract changes for the orchestrator

In `@harness/core`:

- `FormKind`, `FormRecord` (+ a `forms` table keyed by `hash, kind, converter`), `ResourceSource`, `TableSet` (derived from
  or pinned to the library's), `FORMAT_FAMILY` map and `FormatFamily` enum.
- `ResourceRecord`: `source`, `original?`, `forms`, `primary?`.
- `Section` / `SectionRow`: `form`; `SectionMatch`: `form?`.
- `ReadWant`: add `forms` (the system may include forms it made); `ResourceRead`: `forms?: { kind, converter, text?:
  ReadText, content?: ContentRef }[]`, `finalUri?` (web).
- Link spec: `sections` call carries `form`.
- Web spec: `find.resource` gains `form` and `mode`; `admin.resources` gains `group` and returns facets; new endpoints
  `resources.forms` (list forms of a resource), `resources.convert`, `resources.import` (URL or uploaded ref),
  `resources.delete`/`rename`; a `resources.forms` user event.
- Hub contract (SDK `hub.ts`): the fns in section 10 and the `hub/tables` sectioner.

## 15. Tunables

An `@ayepi/env` slice beside the hub's resources module (names illustrative, milliseconds without unit suffix):

| Name | Default | Meaning |
|---|---|---|
| `HARNESS_CONTENT_AT` | `files` | `files` or `database` |
| `HARNESS_IMPORT_MAX` | 200 MiB | largest original accepted |
| `HARNESS_SNAPSHOT_MAX` | 2 GiB | bytes of system-resource originals kept before LRU eviction |
| `HARNESS_TABLE_ROWS` | 5000 | rows kept per table in the `tables` form |
| `HARNESS_DESCRIBE_ON_INDEX` | `false` | describe/OCR images while indexing (else on demand) |
| `HARNESS_FORM_CONCURRENCY` | 2 | conversions at once |
| `HARNESS_FETCH_TIMEOUT` | 30000 | URL fetch timeout (web system and hub fallback) |
| `HARNESS_RENDER_MODE` | `auto` | `auto`, `always`, `never` (web system) |
| `HARNESS_RENDER_TIMEOUT` | 20000 | page render cap (web system) |
| `HARNESS_FETCH_PRIVATE` | `false` | allow fetching private and loopback addresses |

The describer and OCR models are picked in the admin's model settings, next to the transcription and dictation models
build 2 adds (a model category per job: describe images, transcribe audio).

## 16. Dependencies to install

- **web system**: `puppeteer` (already a root dev dependency; becomes the system's dependency), `@tavily/core`.
- **web app**: `shiki` (code highlighting), `mermaid` (diagrams), `pdfjs-dist` (PDF pages); all loaded lazily so the
  first paint doesn't grow.
- **@aeye/resources** (library lane, in aits): `puppeteer` as an optional peer; possibly `tesseract.js` later as an
  optional peer. pdf-parse, mammoth, xlsx, jszip, node-poppler are already there.
- Hub: none new for the default (the content store exists); database mode needs better-sqlite3, already used.

## 17. Phasing and tests

1. **Library**: typed forms, per-page pdf, typed tables, html → markdown, fetch improvements, renderer + heuristic,
   converter versions. Jest tests on fixtures for each (html fixtures from real pages, a scanned and a text PDF, a
   two-sheet workbook with two tables in a sheet, a big CSV); the puppeteer renderer gets one marked live test.
2. **Core + hub**: forms records and service, content store choice (unit tests with both stores through the same
   `FileStore` contract suite), hub resources and imports, sectioning from forms, LLM fns, facets. Injected seams: the
   registry, the model caller (fake describer), the clock, the store.
3. **fs bytes + web system**: fs returns bytes; the web system's search/fetch/roots with an injected `fetch` and
   renderer; one live Tavily test and one live render test, marked.
4. **Web**: viewers (unit tests of `viewerFor`, mode lists, table paging, JSON tree; component tests in happy-dom), the
   browser views, then ui-tests features: open each fixture type, switch preview/source/forms, the grid and each
   grouping, at every layout in light and dark.

## 18. Open questions

- **Does the hub own a top-level `/resources` page, or stay under admin?** Recommendation: both link to one page; it is
  useful to every user, not just the admin.
- **Should fs stop converting** and send only bytes, leaving conversion to the hub? Recommendation: keep fs's text as a
  form for text and code (cheap, local), let the hub convert binaries from bytes, so there is one config for documents.
- **Video frames and image downscaling** need ffmpeg / a resize library (sharp is native). Recommendation: defer;
  browsers downscale images well enough for the grid, and video gets a type glyph until then.
- **Who may see hub resources** once there is more than one user (today there is a single admin): product's
  "caused it" ownership rule is the likely answer; not needed for build 2.
