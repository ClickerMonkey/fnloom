A system that calls a remote service (an MCP server, an HTTP API) is a fleet: one instance per service, added from
the browser with its config (`instances: "many"` in `system.json`). Its sign-in is core's `RemoteAuth` in that config:
`none`, `bearer` (a token), `headers` (named header values) or `oauth`, each `per: 'shared'` (the instance's own config
secrets, the same for everyone) or `per: 'person'` (each person connects their own). List the secret paths in
`configSecrets` (core's `REMOTE_AUTH_SECRETS` under `auth`), so the hub seals them and never shows them again.

**Connections per instance.** Declare `connect` with `scope: 'instance'`: then every fn that runs on the instance acts
as the person, and each instance tells the hub how people connect to it with `ctx.instanceConnect(...)`
(`InstanceConnects`, on the system context and on the running system). Say it in `started` and `configured`; the SDK
keeps the latest and says it again on every reconnect. `instanceConnectOf(label, auth)` works it out from the auth:
OAuth (an admin's sign-in shared with everyone when `per: 'shared'`), a form for a per-person token or headers
(`connectForm`), or nothing to connect. With nothing to connect, calls need no connection; otherwise a person without one
finds the instance's fns unavailable until they connect on the Connections page.

**Credentials.** A form connection's `connectFinish` reads the filled form with `credentialsFromForm(auth, form)` into
core's `RemoteCredentials` (or a problem to show), which the hub keeps as the person's connection; `accountLabel` names
it without the secret. In a run, `ctx.connection.credentials` carries it back: `readCredentials` reads it and `credentialHeaders`
turns it into the headers to send; `sharedHeaders(auth)` gives the instance's own. OAuth tokens a run refreshes go back
with `ctx.updateConnection`. Never log a secret: `maskHeaders(headers, secretHeaderNames(auth))` is what a trace or a
log may show.

```ts
const auth = ctx.config.auth;
const credentials = ctx.connection === undefined ? undefined : readCredentials(ctx.connection.credentials);
if (usesConnections(auth) && credentials === undefined) { return ctx.fail('caller', 'Connect to this service first.'); }
const headers = credentials === undefined ? sharedHeaders(auth) : credentialHeaders(credentials);
```

The MCP client itself is `@ayepi/mcp` (`McpClient` over Streamable HTTP, HTTP + SSE or stdio with `spawnStdioClient`
from `@ayepi/mcp/node`, its OAuth client functions, and its server-request handlers for elicitation and roots); read
its `ayepi-mcp.md` before using it.
