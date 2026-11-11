# Build 6: owner feedback

Binding for build 6's remaining phases; it wins over earlier docs where they conflict.

## 2026-11-11

> The alignment of the pills in the search and spacing doesn't look good enough.

The screenshot is the Runs page on a phone (390 wide), with the pills "Status: Awaiting approval" and "System: fs".
- **Box size:** the pills sit on a tall two-row box with empty space under them. The box should grow only when the
  pills wrap.
- **Alignment:** the pills, the clear button and the filter icon must sit on one baseline, vertically centred.
- **Typing room:** the text input takes the remaining width beside the pills.
- **Spacing:** padding is consistent with the rest of the UI.
- **Sort row:** the sort button, the count ("0") and "Needs approval" sit on one tidy row without odd gaps.
- **Check:** with a screenshot at 390x844 and 1440x900, with zero, two and many pills.

> Also when looking at a system I should be able to disable all context from system like I can for fns and also view all context and types etc. anything that came from that system.

- **One switch:** the system page has an on/off switch for all of the system's context, like the one for its fns.
- **Everything it added:** the system page has tabs or sections for everything the system contributed: fns, context,
  types, kinds, resources and roots, commands, components and registry contributions, examples and providers. Each
  item shows its origin (contract or runtime), its version and its visibility, and opens to its detail.
- **Per item:** each item can be turned on or off.

> Also having hub connection issues - is from the code being edited behind the scenes? If so maybe we run a build that won't be affected by code changes?

- **Done outside the build:** the owner's stack now runs from a separate checkout with watch off (see README,
  "Running a stable stack").
- **Build 6 adds** a first-class way to do this: `npm run live`, which runs a pinned checkout or build with no file
  watching. It reuses the main data dir, and it is not restarted by edits in the working tree or by library dist
  rebuilds until it is restarted on purpose.

> Hmm had this issue, something to add to fix round of that workflow

The screenshot shows the chat on the stable stack (build 5 code, :4320). The person typed `/gollum what can you do for
me?` and sending failed with the toast "Couldn't send. The hub had a problem. Try again in a moment."

What the hub logged:
`ChatError: /gollum can't be used now: memory has never connected.` (`packages/hub/src/chat/turns.ts:352`, in
`#commands`, called from `send`), answered as a 500. `/gollum` is a `/command` on a memory, which is context the hub
made itself.

What to fix:
- **Commands on the hub's own context are served by the hub.** The command lookup treats a hub-made context's origin
  ("memory") as a system that has to be connected. Hub-made context (memories, context made from resources) is always
  available.
- **The composer offers only commands that can run.** One that can't is shown greyed out with its reason, not offered
  and then refused.
- **A refused command is a 4xx with the reason the person can read** ("/x can't be used now: …"), not a 500 shown as
  "The hub had a problem". Look for other ChatErrors (and other expected refusals) that come back as 500s.
- **A test** sends a message with a memory's `/command`.

> And also a fn should declare if it creates things like fns of a certain type, context ,etc. so the chat agent knows it has those side effects

- **Declared effects:** a fn declares what it creates, updates or removes in the hub. Each entry gives:
  - the kind of thing: fns (optionally of a given fn kind, e.g. `database/query`), types, context, resources, kinds,
    components, examples, runs awaiting approval, secrets or connections
  - the action: create, update or remove

  It sits beside the fn facts: reads/writes types, mode, and free or not.
- **The kind can declare them too.** For example, `get_query` creates `database/query` fns, `save_form` creates
  `input/form` fns, and `table_fns_generate` creates and updates `database/query` fns. Fns that use other fns get the
  effects of what they use, worked out deeply like the other fn facts.
- **The chat model sees them** in the fn's description, in one short line. Examples: "Creates fns (database/query)."
  and "Adds context.". `fns_search` can filter on them. The chat mode and the auto classifier take them into account.
- **The hub checks them:** if a fn makes a runtime registry change it didn't declare, the change is refused (or
  logged in dev). Tested.
