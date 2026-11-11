/**
 * The template system's contract (`shared/`): its name and everything it offers, with no implementation. Other systems
 * import it to call its fns through typed refs, its server implements it (`server/impl.ts`) and its client draws it
 * (`client/index.ts`). It must stay safe to import anywhere, the browser included: no Node imports here.
 *
 * TODO: say in one sentence what this system offers, here and in `description` below (and in `system.json`).
 *
 * The full guide is `packages/sdk/AUTHORING.md` (the `fs/system-authoring` context, `/new-system`, in the chat).
 */
import { system } from '@harness/sdk';

// Shapes used by more than one declaration go here, each written once with `g` and named for what it is:
//   export const Thing = g.obj({ ... });
// TODO: add shared shapes, or delete this comment.

/** The template system's contract. */
export const template = system('template', { description: 'TODO: what this system offers, in one sentence.' })
  .with({
    // config: what the system needs before it can be used, as one gin object type (`g.obj({ ... })`). An admin sets
    // the value in the hub (it is checked against this type); every implementation reads it, typed, as `ctx.config`.
    // TODO: declare config, or delete this comment.

    // types: named types other systems can use as fields, each made with `type({ description, shape, display, methods })`.
    // A type's methods are native fns called on a value of it (`methods: { open: fn({ ... }) }`).
    // TODO: declare types, or delete this comment.

    // settings: typed per-actor controls an admin sets for users, groups or agents, each made with
    // `setting({ description, type, appliesTo, merge, editableBy })`. Runs read them with `ctx.setting(ref)`.
    // TODO: declare settings, or delete this comment.

    // attachments: kinds of data this system's fns attach to assistant messages, each made with
    // `attachment({ description, data })` and drawn by a renderer in `client/`.
    // TODO: declare attachments, or delete this comment.

    // kinds: fn kinds this system runs, each made with `kind({ description, applicability, payload, approveChanges, status })`.
    // Fns of a kind are declared with `kinds.<name>.fn({ ... })` in a later `.with`.
    // TODO: declare kinds, or delete this comment.

    // fns: native fns, each made with `fn({ description, args, returns, ... })`. Optional parts change what the server
    // must implement: `undo` (an undo implementation), `resume` (it can pause), `progress` (`linear` or `steps`),
    // `handlers` (`handler({ ... })`), `deps` (fn refs it may call), `state`, `form`, `status`, `display`, `tags`.
    // Every fn needs `instructions` written for the model (when to use it, how, what it returns, pitfalls), `examples`
    // (`{ args, result?, note? }`, checked against its types) and `effects` (`{ mode, reads, writes, free }`).
    // TODO: declare fns, or delete this comment.

    // hooks: user-message hooks that add information before the LLM sees a message, each made with
    // `hook({ description, order, timeout })`.
    // TODO: declare hooks, or delete this comment.

    // embedders: embed functions the hub can index with, each made with `embedder({ dimensions, maxInput, pricePerMillionTokens })`.
    // TODO: declare embedders, or delete this comment.

    // sectioners: ways of cutting resources into sections, each made with `sectioner({ description, match })`.
    // TODO: declare sectioners, or delete this comment.

    // actions: typed messages this system's renderers send it, each made with
    // `action({ description, input, returns, state, expires })`.
    // TODO: declare actions, or delete this comment.
  });

// Declarations that refer to what is declared above go in another `.with`, given a function of the refs so far:
//   .with(({ fns, types, context }) => ({
//     context: { ... },   // `context({ description, content | command, fns, imports, ... })`: static or dynamic context
//     mentions: { ... },  // `mention({ title, description, target, of })`: `@` mention providers
//     fns: { ... },       // `agent({ ... })` agents and `kinds.<name>.fn({ ... })` fns of a kind
//   }))
// TODO: chain a `.with` like this onto `template` above, or delete this comment.
