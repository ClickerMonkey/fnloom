# Build 9: owner feedback

Binding for build 9's remaining phases; it wins over earlier docs where they conflict.

## 2026-11-13 (testing the stable stack, build 8 + widget pass)

The owner asked the chat to add a Todo table to the database. "Create table" failed twice with
`ginTypeToTable: Todo must …`, a third call was declined, and the turn ended "Cancelled."

> Tried to test creating a table:
>
> I need you to have unit tests around these things so I don't hit these during my testing which should be more about ux and not functional since I've communicated functional to you.
>
> Use luna gpt 6 for testing since I exhausted free calls. Don't run a test more than once unless you're doing a final test across them all after you handle each individually.
>
> In system page when I click on a fn it expands - I think a modal should open up - we should have one already - that tells you everything about that fn and also has a toggle there to turn it off and look at its stats, etc. fn modal and page should share same stuff since I asked that the chat open a modal and not take the user away from where they are

What this means:

- **Functional testing is ours, not the owner's.** Every flow the owner has described (creating tables, widgets,
  records, fns, approvals, and so on) gets unit or API-level tests of its real code path, including the shapes a
  model actually sends, so the owner's own testing is about UX. A bug the owner hits gets a regression test with
  its fix.
- **Model for tests:** e2e and live-model tests use the "luna gpt 6" model (the free models' daily limit is used up),
  not the free model.
- **Run each test once.** Fix and run a failing test on its own once; run the whole set again only as the final run
  after each failure was handled.
- **Fn modal:** clicking a fn on a system page opens the fn modal (not an inline expand). The modal shows
  everything about the fn, the on/off toggle and its stats. The fn modal and the fn page show the same content from
  the same components, so chat and other pages can open a fn without taking the person away from where they are.

## 2026-11-13 (why create_table's tool call failed)

> The fns signature should be using gin to convert it to a strict tool call with zod etc and all the work I did in aeye. Please report back why it had a tool call problem

Why it failed: `create_table`'s `type` arg was core's `GinTypeDef`, a `z.custom` that only checks for a `name`. The
SDK's zod→gin bridge turned every `z.custom` into gin `any`, so the hub sent the model an empty schema for it (marked
strict, with nothing to enforce) and its own arg check accepted anything. GPT-6 Luna guessed a key/value list, `null`
and a JSON string; `null` reached an approval and the others failed deep in `ginTypeToTable`.

What this means:

- **Gin types in fn args are gin `typ<T>`.** `GinTypeDef` maps to `typ<any>` and the row type to `typ<obj>`. In aeye,
  `typ<T>`'s value schema is the strict TypeDef schema from `buildSchemas` (the class schemas of the types compatible
  with `T`, named types by name, inline extensions), refined by parsing the definition, so the model sees the shape
  and the hub refuses a wrong one before anyone is asked.
- **One shape.** The database's lenient row-type reader (column maps, key/value lists, JSON strings) is removed.
- **No empty schemas.** A test walks every fn a model can call and fails on an arg position with no schema, except
  an explicit allow-list where each entry says why.

## 2026-11-13 (queries are described, not written, by the chat agent)

Asked whether to fix the two open positions the tool-schema audit found (a query draft's `query` and the rules' `when`):

> Yes fix both, but to be clear normal chat agent shouldn't be able to specify query object, only text descriptions for editing and creating given the json can be very complex and there can be tons of tables and that's why product has progressive disclosure for all that

What this means:

- **The chat agent never sends query JSON.** Creating or editing a saved query takes a description in words (and, for
  an edit, which query); the query-authoring agent, which discloses tables, columns and examples progressively, writes
  and checks the `@aeye/query` JSON. Fns that take query JSON are not visible to the chat model.
- **`when` is a gin expression.** The policy and MCP-rule `when` is typed as a gin predicate over the args, so its
  tool schema is gin's strict expression schema.
