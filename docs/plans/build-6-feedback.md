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
