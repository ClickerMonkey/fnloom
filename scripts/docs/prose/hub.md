The hub is a system too, named `hub`, declared with the same SDK as the contract `hub` (`import { hub } from
'@harness/sdk'`). Systems use it like any other contract: depend on its fns (`deps: { ask: hub.fns.ask_user }`), give
them to agents (`tools: [hub.fns.search_resources]`), use its types as fields (`hub.types.ContentRef`,
`hub.types.LongText`), declare agents with its `llm` kind (`agent()` does), and refer to its sectioners. The hub's
fns cover searching and loading fns and context, following runs, asking people, resources, context, memory, metrics
and configuration (admin fns are tagged `admin` and run only for admins).

This is the hub contract as the SDK declares it now:

<!-- generate: hub-contract -->
