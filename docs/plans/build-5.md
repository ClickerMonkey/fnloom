# Build 5

Build 5 of 7. Same rules as builds 3 and 4: efficient in tokens and time.

## The request, verbatim

> Build 5
> - database system that during configuration lets you specify new sqlite database, existing, postgres, or SQL server connections. Adds query kind like in product. Also get_query which behaves like get_input except all created query fns are saved automatically for quicker reuse next time. Make sure multiple database systems are supported. Add edit_query(query name, instructions). If it returns a query it also returns the results and if a fn existed or was created it returns that signature for easier subsequent calling. A query fn args are dictated by params, limit & offset if applicable, and sorters. Checkout product to see what was intended there. Make sure llm response to query fn or anything with results its clear that these results will be communicated to the user and the llm can summarize it if it's a lot of content but otherwise let the UI show the user the data. The UI should display this data as a table by default but a future widget system could piggy back on this.... So a system should be able to contribute to another systems component registry. Basically the query visual registry is a list of components and each has logic as to whether the data matches the component or not and by how well the visual will display all the data. Table is lowest priority but default visual. What's needed in this build in query visual stuff is just that logic and a way for user to toggle back and forth between valid visuals on that data. A database system can be configured for read only data, or write allowed. Same with schema, if schema is allowed then we want to allow creating/updating table backed types like similar to product. We take gin type and the dialect converts that to create command or it's given a current state of the db schema and produces alterations. All of those operations need user approval. Also admin can configure those fns to only be accessible to certain people or public, etc. look at how I thought about things for the product project. At configuration or startup of the system it rescans the db and rebuilds the types and any missing from hub it recreates or adjusts or maybe something in admin page needs to be accepted. Systems should be able to add a run but not run it and require user approval (maybe that's a native kind in query system?). Goal here is that all tables in db are represented as types. We should also do type enrichment with an llm call (another option to config of database system) where it takes simple type generated from schema and adds in more specificity - to the max of what gin type system supports. Types and queries (fns) are stored in hub and database system searches through them semantically to avoid recreation. Could use decision model if that's available to decide on existing or to create new. Think of all the fn results from the perspective of the llm, I don't want to exclude something it needs to do well

## Prior art to read first

- `@aeye/query` (`C:\Users\pdiff\Documents\GitHub\aits\packages\query`: README.md, aeye-query.md, src): the query
  builder, backing, dialects. Use it fully; library changes go on aits's `harness` branch.
- Product's design (`C:\Users\pdiff\Documents\GitHub\product\design`): types-as-orm.md, queryable-system-types.md,
  query-type-updates.md, query-visuals.md, query-transforms.md, query-library-asks.md, type-agent.md,
  multi-type-authoring.md, lazy-type-properties.md, type-renderers.md, widget-kind.md (only for the registry idea).
  Take the intent, not the code.
- Harness's own: the input system and `get_input` (build 4), kinds (docs/harness.md "Kinds derive fns"), the
  visibility model (build 4), suggestions and the decision model (build 3), the query/filter standard (build 3).

## Decided (by me, from the request; the owner can overrule)

- **Database system:** `systems/database`, one system that can run as many instances (one per database; the fleet
  model), each with its own config: a connection (new SQLite file, existing SQLite file, Postgres URL, SQL Server
  connection), a label, `data: read-only | read-write`, `schema: none | allowed`, `enrich types: on | off` (+ model),
  and the people who may use it (visibility). Connection secrets go in hub secrets, never in plain config. Drivers:
  better-sqlite3 (or node:sqlite), pg, mssql (tedious), behind one dialect interface from `@aeye/query` where it has
  one.
- **Tables are types:** on configure and on every start, the system scans the schema and makes a gin type per table
  (columns, keys, nullability, defaults, relations as refs). The hub stores types; missing ones are created, changed
  ones adjusted. Changes that would break existing query fns, or drop a type, wait for an admin to accept in the
  system's admin page (a diff view).
- **Enrichment:** when on, an LLM call per new or changed table refines the simple type to the most specific gin can
  express (enums from check constraints or small distinct sets, formats like email/url/uuid/date, ranges, descriptions,
  examples), cached by a hash of the table's schema so it only runs when the schema changes. Model calls tracked.
- **Query kind:** payload is a query (the `@aeye/query` form) plus its params; the kind derives the fn's args (params,
  plus `limit`/`offset` when the query is a list, plus `sort` from allowed sorters), returns (the row type), deps (the
  tables/types it touches) and whether it writes. Query fns live in the hub like any fn, with visibility.
- **get_query(detailedDescription):** like `get_input`: search saved query fns and types semantically (embeddings +
  names), reuse a good match (decision model when configured, else score), else an agent writes the query against the
  types; every created query is saved as a fn automatically. Returns, for the LLM: the fn's name and signature (for
  calling it again), the query itself (readable SQL plus the structured form), whether it was reused or created, and
  the results (below).
- **edit_query(name, instructions):** an agent changes the named query fn; saves the new version (old kept in
  history); returns the same shape as get_query including fresh results.
- **Results for the LLM:** every fn that returns rows returns a result block that says plainly: these rows are shown
  to the person as a table (or another visual), so don't repeat them; summarize or point out what matters if useful.
  It includes: columns with types, the row count, total when known, whether it was truncated (and how to page: the
  `limit`/`offset` args), the first rows up to a token budget, the sort used, and the fn signature. The full rows go to
  the UI, not the model.
- **Writes and schema changes need approval:** inserts/updates/deletes (when `read-write`) and creating or altering
  tables (when `schema: allowed`) don't run straight away. The system adds a run in an `awaiting approval` state (a
  native hub mechanism: any system can add a run that needs approval; the person sees what it will do, SQL and a
  preview of affected rows or the DDL diff, and approves or declines; then it runs). Declines tell the model why.
- **Table-backed types:** with schema allowed, a gin type can be turned into a table: the dialect turns the type into
  `CREATE TABLE`, or given the current schema produces the `ALTER` steps. Always via approval.
- **Visual registry (cross-system):** a system can contribute components to another system's registry (here: the
  database system's query visuals). Each visual declares a match function over the result's columns and rows that
  returns whether it fits and a score for how much of the data it shows well. Table is the default and lowest score,
  always valid. The result view picks the best and offers a toggle between all valid visuals. This build: the registry,
  matching, toggle, the table, and one more simple visual to prove it (e.g. a bar chart for one label + one number
  column, or a single-value card for one row and one column).
- **Multiple databases:** several instances at once; fns and types are tagged with their instance; get_query picks the
  right database from the description (or asks with the input system when unclear).
- **The LLM's view:** every fn result in this system is written for the model: what happened, what the person sees,
  how to page or call again, what needs approval and its state. Nothing the model needs to do well is left out.

## Carry-overs from build 4

Whatever build 4 leaves open (its finish report).

## Rules for this build

- Lean. Browser tests only for what needs rendering; screenshots only of changed screens at 390x844 and 1440x900.
- Postgres and SQL Server: test with Docker if it is available; otherwise unit tests against the dialect output, and a
  live test skipped without a server. SQLite is tested for real.
- One review round, a second only if the first finds critical or major problems.
