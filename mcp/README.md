# Harness test MCP server

A small MCP server for checking the harness's MCP integration. It serves the same tools, resources and prompts over
any transport and with any sign-in method, so each combination can be pointed at from the harness.

Requires Node 22.18 or later (the repo's `engines`). Run it from the repo root.

```
npx tsx mcp/server.ts --transport http    --auth oauth
npx tsx mcp/server.ts --transport sse     --auth token --token my-token
npx tsx mcp/server.ts --transport command --auth headers --header X-Api-Key=abc
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--transport` | `http` | `http`, `sse` or `command` (stdio) |
| `--auth` | `none` | `none`, `token`, `headers` or `oauth` |
| `--token` | `test-token` | the bearer token `token` mode accepts |
| `--header NAME=VALUE` | `X-Api-Key=test-key` | a header `headers` mode requires; repeatable; replaces the default |
| `--port` | `4400` | HTTP port (not used by `command`) |
| `--host` | `0.0.0.0` | HTTP bind address; use this to reach it over the LAN |
| `--oauth-ttl` | `3600` | access token lifetime in seconds, for testing refresh |

## Transports

| Transport | Endpoint | Notes |
| --- | --- | --- |
| `http` | `/mcp` | Streamable HTTP (`@ayepi/mcp`'s `mcpHttp`) |
| `sse` | `/sse` (stream), `/messages?sessionId=…` (POST) | The older HTTP + SSE transport (2024-11-05), written here |
| `command` | stdin/stdout | newline-delimited JSON; logs go to stderr only |

## Sign-in

| `--auth` | HTTP and SSE | `command` |
| --- | --- | --- |
| `none` | open | open |
| `token` | `Authorization: Bearer <--token>`; anything else is `401` | the process env `MCP_TEST_TOKEN` must equal `--token`, or every request is refused with `-32001` |
| `headers` | every `--header` must be sent with its value; missing is `401`, wrong is `403` | env `MCP_HEADER_<NAME>` (upper case, `-` → `_`) must equal each value |
| `oauth` | built-in authorization server: metadata, dynamic registration, PKCE `authorize`, `token` (authorization_code and refresh_token). Protected routes answer `401` with `WWW-Authenticate` pointing at the protected resource metadata | not supported: stdio takes credentials from its environment (MCP spec), so the process exits with an error |

OAuth endpoints: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`,
`/authorize`, `/token`. `/authorize` approves at once with no login page.

## What it serves

- **Tools:** `echo` (read-only), `add` (structured result), `now` (read-only), `whoami` (reports the session and the
  subject the sign-in let in), `delete_note` (marked destructive, so approval gates should catch it), `boom` (always an
  error result).
- **Resources:** `demo://readme`, `demo://config.json`, `demo://blob.bin` (binary), and the template
  `demo://notes/{id}` (ids `1` and `2`).
- **Prompts:** `greet` (`name` required, `tone` optional), `summarize` (`text` required).

## Files

- `server.ts`: the command line and the transports.
- `fixtures.ts`: the tools, resources and prompts.
- `auth.ts`: the `none`, `token` and `headers` sign-ins, and the refusal shape.
- `oauth.ts`: the OAuth authorization server.
- `sse.ts`: the HTTP + SSE transport.

`@ayepi/mcp` has the Streamable HTTP and stdio servers and the clients for all three transports, but no server for
HTTP + SSE and no OAuth authorization server. Those two are written here, on the library's `McpServer.handle`.
