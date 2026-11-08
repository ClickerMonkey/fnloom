### The notes system, whole

The worked example of this guide, `scripts/docs/example`: every file, verbatim. It is compiled by `npm run typecheck`
and its tests run with `npm test`, so it is a correct, complete system for this version of the SDK. Copy its patterns.

<!-- generate: example-system -->

### The fs system's contract

The fs system (`systems/fs`) gives agents files and a shell over chosen folders. Its contract is the reference for a
real system's declarations: a named type with a method, a setting, an attachment, fns with status words, undo, state,
progress and handlers, a hook, a mention provider, static and dynamic context, and an agent.

<!-- generate: fs-contract -->
