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
