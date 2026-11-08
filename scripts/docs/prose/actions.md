An **action** is a typed message the system's renderers send it ("pin", "approve", "load more"). Declare it with
`action({ description, input, returns?, state?, expires? })`: without `returns` it returns nothing, `state` declares
session state fields it reads and writes (like a fn's), and `expires` drops it if it can't be delivered within that
many ms (default: never).

<!-- include: scripts/docs/example/shared/index.ts#action -->

The hub **stores every action before delivering it**, so nothing is lost: if the system is offline it waits and is
delivered, in order, when the system connects. A renderer sends one with `view.system.send.pin({ id, pinned })` and gets a
`Delivery` whose `status` is live and whose `result` resolves with the typed result. The server implements each as
`async (input, ctx) => result`; `ctx` has the asker (`ctx.user`, `ctx.session`), the run whose renderer sent it
(`ctx.run`, when there is one), the delivery id, session state, and the run services.

<!-- include: scripts/docs/example/server/impl.ts#impl-action -->

To start a run from a renderer instead (a "run again" button), use `view.system.run.<fn>(args)`: the new run shows in
the chat like any other, with its own approval, status, cost and undo.
