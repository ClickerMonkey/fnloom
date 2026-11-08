### Resources

A system can **serve resources**: things with a URI that the hub lists, indexes, searches, shows and hands to the LLM
(files, pages, records). The implementation's optional `resources` is a `ResourceProvider`:

- `roots()`: the roots it serves (`{ uri, name, description, index: 'all' | 'on-read' | 'none', ignore, watch }`).
- `list(uri, cursor?)`: a page of stats under a URI (`{ items, cursor? }`; `cursor` absent on the last page).
- `stat(uri)`: what is known without reading (`ResourceStat`: name, type, mime, `format` for picking a sectioner
  and a viewer, size, modified time, and a `version` that changes whenever the content does), or `undefined`.
- `read(uri, want)`: `want` lists `text`, `links` and `bytes`; small text goes inline (`{ inline }`), large text and
  bytes by `ContentRef`.
- `watch(uris, onChange)`, optional: report changes until the returned function is called.

URIs are absolute (`notes://all/n1`, `file:///…`) and belong to the system whose root contains them. Every reader
goes through the hub (`ctx.resources.text(uri)` from any system), which routes each URI to the system that serves it.
Build readers on `@aeye/resources` where they fit; the fs system serves folders this way.

The notes system serves each note as markdown under `notes://all/`, so the hub indexes and searches them:

<!-- include: scripts/docs/example/server/impl.ts#impl-resources -->

### Embedders

An **embedder** is an embed function the hub can index with. Declare it with `embedder({ dimensions, maxInput,
pricePerMillionTokens })` and implement it as `async (texts) => vectors`, one vector of `dimensions` numbers per text,
in order. The embedder system (`systems/embedder`) is the reference.

### Sectioners

A **sectioner** is a way of cutting resources into sections for search and context, offered to people as a choice for
matching resources. Declare it with `sectioner({ description, match })`, where `match` picks resources by `format`,
`mime`, a `glob` over the URI, or a `form` (`table` for any spreadsheet's tables). Implement it as
`async (text, stat) => sections`. Section keys must come from structure (a heading path, a symbol name), never from
position, so they survive edits: make them with `sectionKeys(paths)`, which joins each outline path with ` > ` and
numbers repeats (` ~2`) the same way the hub's own sectioners do.
