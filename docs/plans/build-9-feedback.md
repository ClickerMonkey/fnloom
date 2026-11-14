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

## 2026-11-14 (OpenAI strict mode and gin's TypeDef schema)

Asked how gin-type tool args should reach OpenAI, after strict mode failed outright on gin's full TypeDef schema
(make_code / make_api `signature`: finish reason "length", no output):

> the schema files and prompt clas in aeye core should handle that behavior already. Make sure the right schema rules are being applied because there should be no error.  But also see if the schema can be made smaller by just changing which types are named and ref'd. I am interested in you fixing it because aeye is suppose to handle anything for the dev

What this means:

- **aeye handles any schema.** A tool schema a dev hands aeye never errors at the provider: aeye core's schema rules
  (dialect descriptors, budget, strict/non-strict choice, cycle breaking) and its Prompt class must apply so the
  request goes through. A schema that reaches the provider and fails is an aeye bug to fix in aeye, not worked around
  in harness.
- **Smaller by naming.** gin's TypeDef schema is made smaller by choosing which types are named `$defs` and referenced,
  not by dropping structure.

## 2026-11-14 (gin's strict new values; why make_api / make_code fail)

Asked whether gin's strict `new` schema should take a plain value where a field is a primitive or enum:

> Yeah let's update gin to support that. And figure out further why any make API or code call falls and fix it. Whether it's missing or incorrect examples or docs in the prompt.... Make sure what's sent to the llm is accurate

What this means:

- **gin's strict `new`:** a primitive or enum slot of a `new` value takes its plain value (`method: "GET"`) or an
  expression, so authoring programs use `newStrict` typed values and the model never writes objects as pairs.
- **make_api / make_code work end to end on the live model.** Each failure is traced to its cause (missing or wrong
  examples, docs or prompt text, schema or decoding) and fixed there.
- **What the LLM is sent is accurate:** prompts, examples, docs and tool schemas agree with what the code accepts.

## 2026-11-14 (published libraries; orchestrate through agents)

> Fyi I had another agent make the ayepi and aeye repos publish on commit I know we're working with local copies but once everything is done and tested we should switch to live libraries and that flow when I give the signal
> Just pass my requests and the context you have that's need to agents and you orchestrate from now on

What this means:

- **Libraries:** ayepi and aeye now publish on commit. harness keeps using the local `harness` branches (linked) until
  the owner signals; then harness switches to the published packages and that publish flow. Until then nothing on
  those branches is pushed.
- **Orchestration:** the main session orchestrates. It passes the owner's requests, with the context an agent needs,
  to agents that do the work, and reviews, verifies and commits what they return.

## 2026-11-14 (widget chrome: data context visible, the rest in a hover menu)

> Let's update the look of the widgets so that what you see by default is only stuff that when you're thinking about what data am I looking at, it helps tell you. So it would be something like the filters, stuff like that is what would be visible. And then if the settings has a subset of the valid widgets that the user agent has pre-selected, those would be in a little toggle. But a lot of the other icons and toggles that you have at the top of widgets right now, it's a whole lot going on. So let's put it in a 3-dot menu that is in the top right and only shows up on widget hover. And we should be able to, if supported, export image or export as JSON or CSV. And full screen a widget. And the settings just to change it visually and to save it.

What this means:

- **Visible by default:** only what tells you what data you're looking at (title, filters and similar context).
- **Visual toggle:** when the widget's settings carry a subset of valid visuals pre-selected (by the user or the
  agent), they show as a small toggle to switch between them.
- **Everything else** moves to a 3-dot menu at the top right, shown on widget hover: export image, JSON or CSV (where
  supported), full screen, and settings (change the look visually, save it).

## 2026-11-14 (fn modal fails on the mock; drill-downs from every widget)

Looking at the mock data on the phone, the fn modal for `database/shop.sample` showed "Couldn't load this fn.":

> Not good! Also was drill downs implemented? There's a drilldownify and and maybe paginate or something functions that take a gin query and make them safe to use for widgets so all can support pagination and drilldowns. If the query doesn't support drilldowns it throws an error or something. So every widget if I click on a part of it that basically represents a group and should be sent to a drilldownify query which flattens a query to produce the rows that made that group - in turn another widget could be displayed in a modal. Default to table.

What this means:

- **The fn modal loads every fn** it can be opened on, in the real app and the mock.
- **Drill-downs come from the query, not a hand-bound fn:** `@aeye/query`'s `drillDown` (with `autoPaginate`) turns a
  grouped query into the query for the rows behind one group. Every widget whose query supports it can be drilled:
  clicking a part that stands for a group (a bar, a slice, a grouped row) runs that query for the group and shows its
  rows as another widget in a modal, a table by default. A query that can't be drilled says so (the transform
  refuses) and its parts aren't clickable.

## 2026-11-14 (human-friendly labels; the data tab's empty state)

> For widgets let's have a rule where all labels (like fields) are passed through a human friendly function to convert id to ID and title to Title and due_date to Due date etc. the title attribute for those things can have the original value of the person is curious.
>
> I saw task in data tab and it says 128 rows but when I click on it it says no records yet. Either there are and we shouldn't show that message until we know for sure or a loading visual

What this means:

- **Widget labels are humanized:** every label a widget shows from a name (columns, fields, axes, legends, chips,
  crumbs) goes through one human-friendly function (`id` → ID, `title` → Title, `due_date` → Due date). An explicit
  label still wins. The original name is the element's `title` attribute, for anyone curious.
- **No false empty state:** a type the data tab lists with rows never says "No records yet" while its records load; it
  shows a loading state until the answer is known, and the empty message only when there truly are none.

## 2026-11-14 (no data types in column headers)

> Hmm let's remove data type from the table columns or anywhere else, not particularly useful for user but you could add that info to tooltip

What this means:

- **Data types aren't shown as labels:** table headers (and anywhere else a field's data type sits beside its name)
  show only the friendly name. The type moves into the tooltip, beside the raw name (e.g. `due_date · date`).
