**Where data lives.** Data a system keeps for people (notes, tasks, contacts, anything shared or looked up later)
lives in the hub as **records of a stored type**, never in a file or database of the system's own. The hub keeps them,
checks each against the type, versions every change, controls who sees them, searches them in its database (by words
and by meaning) and shows them on the Data page, where people browse, filter, edit and turn them into widgets. A
system's own folder (`ctx.dataDir`) holds only what is the system's alone: its keys, a cache, a working copy of
something it syncs. An external database stays where it is (the database system reads it).

A type is **stored** when it declares `records`:

<!-- include: scripts/docs/example/shared/index.ts#note-type -->

- `shape`: `table` for many records (the usual), `value` for exactly one (a system's shared list or settings). A save
  to a `value` type leaves out `id`.
- `owner`: `shared` (everyone who can see the type sees every record) or `person` (each record its writer's; only they
  and admins see it). A `person` type is read and written in runs, as the run's person; hooks, mentions, context and
  lifecycle code have no person, so they can't read it.
- `search.text`: the top-level text fields text search matches, in order of weight; `search.embed`: whether records
  are embedded too, so search finds them by meaning (a model call the hub makes and pays for).

The record carries the id (`rec_…`), version, times and who changed it; the value is only the type's fields. A type
that cards and methods need with its id (the notes' `NoteEntry`) is a separate named type the fns return.

**Reading and writing: `ctx.data`.** Every context has it (it needs `grants: { hub: ['data'] }`). In a run it acts as
the run's person, elsewhere as the system. Every read is a query with a page: filters and sorts on the type's
top-level fields (`ListQuery`: `filters`, `sort`, `limit`, `cursor`) and `search`; the hub runs them in its database.
**Never load every record to filter, count or search in code.**

<!-- include: scripts/docs/example/server/impl.ts#impl-find -->

- `ctx.data.find(Type, { search?, query? })`: one page, best match first when searching; `cursor` when there are more.
- `ctx.data.get(Type, id)`: one record, `undefined` when it is gone or not the asker's.
- `ctx.data.save(Type, value, { id?, expect? })`: add (no `id`) or replace. With `expect` (the version read), the save
  fails when someone changed the record meanwhile, instead of losing their change.
- `ctx.data.remove(Type, id)`: remove it; its versions stay.
- `ctx.data.table(Type, { search?, query?, offset?, limit? })`: the same records as a `ResultTable` (a column per field,
  then `id` referring to the type), which widgets draw.

Work over many records a page at a time, following `cursor` with a stable sort, as `tidy` does:

<!-- include: scripts/docs/example/server/impl.ts#impl-tidy -->

The hub's own fns read and write records too (`hub/records_find`, `hub/record_get`, `hub/records_table`,
`hub/record_save`, `hub/record_remove`, `hub/data_sets`), so the chat can work with a system's data without the system
writing a fn for every question. In tests the fake hub keeps records in memory (`kit.records(type)`, **Testing**).
