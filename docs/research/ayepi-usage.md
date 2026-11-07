# ayepi in harness: what to use, where, and what is missing

Research note for the harness build. It covers every package under `ayepi/packages/*`: the exact
APIs harness should use, where each one goes (hub server, system link, web client, queues, auth,
files, config, logs, lifecycle, MCP, UI mocks, docs sync), short sketches, and the library changes
harness needs. Signatures are copied from the ayepi source (`packages/<pkg>/src`) and its
`ayepi-*.md` docs as they stand at `ayepi@0.4.1` (commit `ee3bbfb`).

Read [`docs/harness.md`](../harness.md) first. This note follows its Library map and fills in
the detail.

## 0. Before anything is built

- **Branch.** The ayepi checkout is on `main`. There is no local `harness` branch yet (branches:
  `main`, `fix/product-asks-2026-08`). The library lane creates `harness` before its first change.
- **Linked through `dist/`.** Every package's `exports` points at `dist/*.js` and `dist/*.d.ts`.
  A source change in ayepi does nothing for harness until that package is rebuilt
  (`pnpm -C ../ayepi -r build`, or the one package). Harness `typecheck` reads the built `.d.ts`.
- **Dependencies harness still needs** (not in `harness/package.json` today): `@ayepi/node` (plus
  its peer `ws`), `@ayepi/updown`, `@ayepi/otel`, `@ayepi/cache`, and as dev dependencies
  `@ayepi/mock`, `@ayepi/context`, `@ayepi/stress`. Not needed: `@ayepi/aws`, `@ayepi/redis`,
  `@ayepi/bun`, `@ayepi/deno`.
- **zod.** ayepi packages declare `zod: ^4` as a peer and build against `^4.4.3`. Harness is on
  `^4.6.7`. Peers resolve to harness's copy, but each linked package also has its own
  `node_modules/zod`, so two copies can load and `instanceof`/brand checks can fail. Build order
  step 1 (zod on the latest version everywhere) must land first, with ayepi's own `zod` as a
  dev-only dependency.
- **`exactOptionalPropertyTypes`.** Harness has it on. ayepi option types are `readonly x?: T`, so
  harness code must **leave keys out** rather than pass `undefined` (for example, build
  `wsTransport` options with a conditional spread).

## 1. Package map

| Package | Harness use | Where |
|---|---|---|
| `@ayepi/core` | `spec`/`endpoint`/`events`, `implement`, `server`, middleware defs, `provide`, `localClient`, `ApiError`/`reject`, doers, `retry`, metrics, load shedding, docs | hub server, system SDK (both link directions), shared contracts |
| `@ayepi/core/client` | zod-free `client`, `wsTransport`, `caller`, `connection` | Vue web app (`web/src/api/*`), system SDK's hub client |
| `@ayepi/node` | `createRequestListener`, `handleUpgrade`, `serve` | hub process, mock UI server |
| `@ayepi/plugin` | `plugin(...)`, `createPluginHost(app)`, `PluginHandlers` | one plugin per hub module |
| `@ayepi/work` | `defineWork`, `createWork`, `WorkDelayError`, `RetryAbort`, `onFailure`, deadlines, DLQ, metrics, `skipQueue` | LLM queue, run queue, embed batches, indexing |
| `@ayepi/rate` | `limiter`, `rateLimitedDoer`, `rateLimit` middleware | per-model/provider call starts; sign-in throttling |
| `@ayepi/auth` | `bearerAuth` def, `bearerAuth.server`, `signJwt`/`verifyJwt` | single admin sign-in, browser HTTP + ws, short system tokens |
| `@ayepi/files` | `FileStore`, `fsFiles`, `mountFiles`, `transfer` | uploads, attachments, `ContentRef` bodies, system client bundles |
| `@ayepi/env` | `env(...)`, `.add`, `alias`, `on`, `loadEnv` | one env slice per module; `HubConfig` derived from them |
| `@ayepi/log` | `createLogger`, transports, `interceptConsole`, `sanitize`, `logWith` | hub and every system (system logs forwarded over `HubLink.log`) |
| `@ayepi/otel` | `telemetry` def + `.server` | request/response lines and trace context on every spec |
| `@ayepi/updown` | `updown(opts)`, components with `deps`, `whenDown` | hub and system process start/stop |
| `@ayepi/cache` | `cache` def + `.server`, `memoryCache` | system client bundles, model catalog, capabilities |
| `@ayepi/codec` | `createCodec` | work job codec, browser drafts in `localStorage` |
| `@ayepi/mcp` | `mcpServer`, `serveStdio` (spec-based today) | system SDK's MCP face, after the library change in section 16 |
| `@ayepi/mock` | `mockServer`, `mockHandlers`, `generate` | UI work and puppeteer runs before the real hub exists |
| `@ayepi/context` | `ayepi-context` CLI | `npm run context:sync` copies ayepi agent docs into `docs/ayepi/` |
| `@ayepi/stress` | `benchmarkArchetypes`, `stressTarget` | load test for the SQLite work queue (Risk 8) |
| `@ayepi/aws`, `@ayepi/redis`, `@ayepi/bun`, `@ayepi/deno` | not used (single node, SQLite, Node 22) | — |

## 2. `@ayepi/core`: contracts and the hub server

### 2.1 Specs are the source of truth

```ts
function endpoint<const C extends EndpointConfig>(cfg: C & CheckCfg<C, …>): Endpoint<C, …>
function spec<const S extends SpecShape>(spec: S): S
function manifestFromSpec(spec: AnySpec): Manifest
interface SpecShape {
  readonly endpoints: Readonly<Record<string, AnyEndpoint>>
  readonly events?: Readonly<Record<string, EventConfig>>
  readonly doc?: SpecDoc
}
interface EventConfig {
  readonly params?: z.ZodType; readonly data: z.ZodType
  readonly guard?: readonly AnyMiddleware[]; readonly ws?: string; readonly doc?: EventDoc
}
```

`EndpointConfig` fields used by harness: `params`, `query`, `body`, `response`, `responses`,
`errors`, `method`, `path`, `ws`, `httpOnly`, `streamIn`, `streamOut`, `streamEncoding`,
`download`, `files`, `doc`, and `sideEffects` (marks an idempotent POST as safe for the client's
replay on reconnect).

Harness has three specs. Each lives in a frontend-safe `shared/` file that imports only
`@ayepi/core`, `zod` and middleware **defs**:

- **`hubWebSpec`**: the browser API (`HubWebApi` in `types/hub.ts`) plus the realtime events
  (turn deltas, run status, progress, state changes, deliveries, notifications, system status).
- **`hubLinkSpec`**: what a system calls on the hub (`HubLink`).
- **`systemLinkSpec`**: what the hub calls on a system (`SystemLink`).

The TS interfaces in `types/hub.ts` (`HubLink`, `SystemLink`, `HubWebApi`) are the approved
*design*. In code, the spec is the single source of truth and the interfaces become derived types
(`HandlerFor`, `CallArgs`, `CallReturn`), so the interfaces must not be kept as hand-written
duplicates.

```ts
// hub/shared/link.ts (frontend-safe)
import { spec, endpoint } from '@ayepi/core'
import { z } from 'zod'
import { RunRequest, OutcomeWire, LlmForward, LlmForwardChunk } from './wire'

export const systemLinkSpec = spec({
  endpoints: {
    run: endpoint({ body: RunRequest, response: OutcomeWire, ws: 'run' }),
    control: endpoint({
      body: z.object({ run: RunId, action: z.enum(['cancel', 'pause']) }),
      response: z.object({ accepted: z.boolean(), reason: z.string().optional() }),
      ws: 'control',
    }),
    // … one endpoint per SystemLink method, each with an explicit short `ws` id
  },
})

export const hubLinkSpec = spec({
  endpoints: {
    llm: endpoint({ body: LlmForward, streamOut: LlmForwardChunk, ws: 'llm' }), // typed item stream over ws
    progress: endpoint({ body: z.object({ run: RunId, progress: Json }), ws: 'progress', sideEffects: false }),
    // …
  },
  events: {
    resourcesChanged: { data: z.object({ changes: z.array(ResourceChange) }), ws: 'rc' },
  },
})
```

Give every link endpoint an explicit short `ws` id (`run`, `llm`, …). The frame then carries
`{ type: 'run' }` rather than the method plus URL pattern, which keeps frames small.

**Wire rule (from how core serializes).** `CallReturn` is typed as `z.output` of the response
schema, but the client does **not** parse responses unless `validate: spec` is passed. The server
sends `JSON.stringify(schema.parse(value))`. A `z.date()` field therefore reaches the browser as an
ISO **string** while TypeScript calls it a `Date`. Until the library fixes this (gap G6), every
wire schema must be JSON-shaped: timestamps as `z.number()` epoch ms (`Timestamp` in `types/sdk.ts`
is already a number), no `z.date()`, no `Map`/`Set`, no transforms whose output differs from the
JSON form. gin values cross the link as gin JSON and are parsed by gin on the far side, so fns
still receive `Date` objects.

### 2.2 Handlers, middleware and in-process calls

```ts
implement(spec)
  .middleware(def, impl)          // or .middleware({ def, impl }) from a `.server(...)` binder
  .handlers({ … }) / .handle(name, fn)
server(spec, [builders], opts?: ServerOptions): Server<S>
interface ServerOptions { cors?; broker?; docs?: boolean | DocsOptions; shed?: LoadShedOptions; streamHighWaterMark?: number }
interface Server<S> {
  fetch(req: Request): Promise<Response>; manifest(): Manifest; emit: EmitFn<S>
  openapi(info?); asyncapi(info?)
  call(name, ...args): Promise<unknown>
  install(spec, builders): MountHandle; uninstall(handle: MountHandle): void
  readonly ws: { open(send: (frame: string) => void, req: Request): WsConn; message(conn: WsConn, raw: string): Promise<void>; close(conn: WsConn): void }
}
function localClient<S extends AnySpec>(app: Server<AnySpec>, spec?: S): LocalClient<S>
function provide<const N extends string, V>(name: N, value: V | ((io) => V | Promise<V>)): ProvideMiddleware<N, V>
function middleware<P, R, O>(name: string, opts?: { provides?: Provide<P>; requires?: R; optional?: O; doc?: MiddlewareDoc }): Middleware<P, R, …>
function use(...mws): Stack<…>   // then .path() / .group() / .endpoint()
```

The handler payload has `data`, the merged middleware context at the root, `emit`, `signal`,
`fail(status, data)` (typed by `errors`), `req`, `status`, `header`. Over ws, `io.ws.id` is the
frame id and `io.ws.conn` is the connection.

Hub uses:

- **`provide('hub', services)`** injects hub services into chains where plugin `ctx` is not
  enough (middleware impls).
- **A link-session middleware.** A system socket does not carry a JWT on every frame. The hub keeps
  a `WeakMap<WsConn, LinkSession>` filled by the hello/challenge handshake, and a def
  `linkSession = middleware('linkSession', { provides: ctx<{ system: LinkSession }>() })` whose
  impl reads `io.ws?.conn`, rejects with `reject(401, 'NOT_PAIRED')` when the connection has not
  finished the handshake, and otherwise calls `io.next({ system })`. Every `hubLinkSpec` endpoint
  except `hello`/`prove` goes in `use(linkSession, tel).group({...})`.
- **Errors.** Throw `reject(status, code, message?)`, or `fail(status, data)` for declared typed
  errors. The client gets `ApiError { status; code; data? }`. `FnError` values in outcomes are
  data, not HTTP errors.
- **Docs.** `server(…, { docs: dev })` serves `/docs/swagger`, `/docs/redoc` and `/docs/asyncapi`
  in development only.
- **Load shedding.** `shed: { thresholdMs, sustainedMs, recoverMs, response, exempt }` on the hub,
  with `/healthz` exempt. Its values come from the hub env slice (section 10).
- **Metrics.** `createMetrics({ quantiles: [0.5, 0.95, 0.99] })` is shared with work
  (`createWork({ metrics })`). `formatPrometheus(stats)` serves a `/metrics` endpoint for the admin
  "health" page.
- **Retry.** `retry(fn, { attempts, base, factor, max, jitter, on })` from `@ayepi/core/retry`, for
  outbound calls such as the embedder HTTP call and provider model lists.

### 2.3 Doers (`@ayepi/core/doer`)

```ts
interface DoerTaskOptions { readonly group?: string; readonly priority?: number; readonly createdAt?: number }
interface Doer { available(): number; do(task: () => Promise<void>, opts?: DoerTaskOptions): void; done(): Promise<void> }
function doWith<T>(doer: Doer, fn: () => Promise<T>, opts?: DoerTaskOptions): Promise<T>
function unlimitedDoer(opts?: { available?: number }): Doer
function balancedDoer(opts: BoundedDoerOptions): Doer   // fair across groups, then priority, then age
function priorityDoer(opts: BoundedDoerOptions): Doer   // priority, then age
function ageDoer(opts: BoundedDoerOptions): Doer
interface BoundedDoerOptions { max: number; buffer?: number; now?: () => number; onBacklog?: (i: BacklogInfo) => void; backlogAfterMs?: number; backlogEveryMs?: number }
```

`Priority` (`'urgent' | 'interactive' | 'normal' | 'background'`) maps to a number through
`QueueSettings.priorities`. Higher numbers run first.

### 2.4 The node adapter (`@ayepi/node`)

```ts
function createRequestListener(app: Server<AnySpec>): (req: IncomingMessage, res: ServerResponse) => void
function handleUpgrade(app: Server<AnySpec>, server: http.Server, path?: string): WebSocketServer
function serve(app: Server<AnySpec>, opts: { port: number; hostname?: string; path?: string; onListen? }): () => Promise<void>
```

The hub needs **two** socket paths: `/ws` for browsers, which speaks the hub web server's frames,
and `/link` for systems, which runs a per-connection peer (section 3). `handleUpgrade(app, server,
path)` **destroys** sockets whose path does not match, so two calls on one `http.Server` break each
other (gap G3). Until that is fixed, the hub uses `createRequestListener(app)` for HTTP and its own
`upgrade` listener that routes by pathname into two `new WebSocketServer({ noServer: true })`
instances. `serve()` binds `0.0.0.0` by default, as harness requires.

Frames are read as `String(data)`, so text only. Binary frames are gap G2.

## 3. The system link: both directions on one socket

**What exists.** One side of a socket can be an ayepi *server*, fed by `app.ws.open(send, req)` and
`app.ws.message(conn, raw)`. The other side can be an ayepi *client*, fed by any
`ClientWs { send(frame); onMessage(cb); onState?(cb) }`. Nothing in core lets one socket carry both.

**Why an envelope is not enough.** The two directions use the same frame shapes. A call is
`{ id, type, data }`, an event push is `{ type, params, data }`, a reply is `{ id, $status, data }`,
and streams use `{ id, chunk }` and `{ id, end: true }` in **both** directions (streamIn from the
client, streamOut from the server). `{ id, abort: true }` also flows client to server. A receiver
cannot tell "a chunk for a stream I am serving" from "a chunk for a stream I am consuming".
Telling them apart needs a direction marker: either a harness wrapper `{ d: 'q' | 'r', f: frame }`
or a peer mode in core. harness.md has decided this belongs in ayepi (gap G1).

**The shape harness should code against** (proposed API for the library lane; nothing like it
exists today):

```ts
// @ayepi/core (proposed)
function peer<Local extends AnySpec, Remote extends AnySpec>(opts: {
  serve: Server<Local>                        // the endpoints this side answers
  remote: Manifest | Remote                   // what the other side answers
  socket: PeerSocket                          // { send(frame: string): void; onMessage(cb): void; onState?(cb): () => void }
  req: Request                                // synthetic upgrade request for the local chain
}): { client: ApiClient<Remote>; conn: WsConn; close(): void }
```

- **System side:** `wsTransport(() => hubUrl('/link'), { WebSocket, backoff, heartbeat,
  whileDisconnected: 'queue' })` is the socket. `peer({ serve: server(systemLinkSpec, [impl]),
  remote: hubLinkSpec, socket, req: new Request('ws://system/link') })` gives the typed `hub`
  client used by `ctx.call`, `ctx.llm` and `ctx.resources`.
- **Hub side:** on each `/link` upgrade, `peer({ serve: hubLinkApp, remote: systemLinkSpec, socket:
  wsSocket, req: upgradeRequest })`. The returned `client` is that system's typed `SystemLink`
  caller. The run worker calls `client.call('run', req, { signal })`, and `signal` sends the abort
  frame.
- **Exactly once.** POC 1 (kill either side mid-call) depends on how replies are treated across a
  reconnect. Core rejects in-flight ws calls with `$status: 0 DISCONNECTED`, and callers can
  `replay` on reconnect (`CallerReplayConfig { maxRetries?, timeout?, backoff?, force? }`).
  `run` is not idempotent, so the hub must own an idempotency key per run (the `RunId`). The
  system answers a repeated `run` for a known `RunId` with the stored outcome instead of running
  it again.

## 4. The Vue web client (`@ayepi/core/client`)

```ts
function client<S extends AnySpec>(opts: ClientOptions): ApiClient<S>
interface ClientOptions {
  baseUrl: string; manifest: Manifest | AnySpec
  headers?: Record<string, string> | (() => Record<string, string>)
  fetchImpl?; ws?: ClientWs; prefer?: 'http' | 'ws'; validate?: AnySpec; cache?: ClientCacheOptions
}
interface ApiClient<S> {
  call(name, ...args): CallReturn<…>
  caller(name, options?: CallerOptions<…>): Caller<…>
  url(name, data?): string                         // GET only: downloads, SSE
  on(name, params?, cb): () => void                // events; needs ws
  readonly connection: { readonly status: ConnStatus; subscribe(cb): () => void }
}
interface Caller<E> { call(...args); cancel(): void; invalidate(): void; readonly pending: number }
// CallerOptions: cache { ttl, staleWhileRevalidate, key, tags, store }, debounce, rateLimit, retry,
//   lastOnly, dedupe, invalidates (+ invalidateOn), replay, onStart/onSuccess/onError/onSettled
function wsTransport(url: string | (() => string), opts?: WsTransportOptions): WsTransport
interface WsTransportOptions { protocols?; WebSocket?; whileDisconnected?: 'queue' | 'fail'; backoff?: { initial?; max?; factor?; jitter? }; heartbeat?: { interval?; timeout? } | false; maxRetries?; onStateChange?; onError? }
interface WsTransport extends ClientWs { connect(): void; close(): void; readonly state: 'closed' | 'connecting' | 'open' }
```

**Layout** (state and callers stay out of components, as the owner asked):

```
web/src/api/client.ts      the one ApiClient + wsTransport
web/src/api/manifest.gen.ts  generated from hubWebSpec (never hand-edited)
web/src/api/<area>.ts      callers per area (sessions, messages, runs, systems, admin)
web/src/state/<area>.ts    reactive stores (refs/computed) built on the callers + sdk.on events
web/src/components/**      components get props/emits or a store; they never import the client
```

```ts
// web/src/api/client.ts
import { client, wsTransport } from '@ayepi/core/client'
import type { hubWebSpec } from '@harness/hub/shared/web'   // type-only: no zod in the bundle
import { manifest } from './manifest.gen'
import { authToken } from '../state/auth'

export const socket = wsTransport(
  () => `${location.origin.replace(/^http/, 'ws')}/ws?access_token=${encodeURIComponent(authToken.value)}`,
  { whileDisconnected: 'queue', heartbeat: { interval: 30_000, timeout: 10_000 }, backoff: { initial: 500, max: 15_000 } },
)
export const hub = client<typeof hubWebSpec>({
  baseUrl: `${location.origin}/api`,
  manifest,
  headers: () => (authToken.value === '' ? {} : { authorization: `Bearer ${authToken.value}` }),
  ws: socket,
  prefer: 'ws',
})
```

```ts
// web/src/api/sessions.ts
import { hub } from './client'
export const sessionsCaller = hub.caller('sessions', { cache: { ttl: 15_000, staleWhileRevalidate: 60_000, tags: ['sessions'] }, dedupe: true })
export const createSessionCaller = hub.caller('createSession', { invalidates: ['sessions'] })
export const mentionsCaller = hub.caller('mentions', { debounce: { wait: 120 }, lastOnly: true })
export const messagesCaller = hub.caller('messages', { cache: { ttl: 5_000, tags: (d) => [`session:${d.session}`] } })
```

- **The manifest file is generated TS, not JSON.** A JSON import widens `method` to `string`, which
  is not assignable to `HttpMethod`. A script writes
  `export const manifest = <json> as const satisfies Manifest` from `manifestFromSpec(hubWebSpec)`.
  `npm run check` regenerates it and fails when it is stale, so a spec change breaks the build
  until the manifest matches.
- **Realtime.** `hub.on('turnDelta', { session }, cb)` and similar subscriptions live in
  `state/*.ts`, which unsubscribes when the route changes. `wsTransport` resubscribes live channels
  after a reconnect. After a reconnect the stores also refetch through their callers
  (`invalidate()` then `call`), because events sent while offline are lost.
- **Connection indicator.** `hub.connection.subscribe(status => …)` drives the "reconnecting" pill.
- **Uploads.** `call(name, data, { onUploadProgress })` gives byte progress for attachments.
  Presigned `PUT` (section 9) is used for large files.
- **Token rotation.** The socket URL is resolved again on every reconnect, but a live socket keeps
  the token it opened with, and `close()` is permanent (`connect()` does nothing after it). After a
  refresh the client needs a way to reconnect (gap G7). Until then, the hub keeps access tokens
  valid for the socket's lifetime and checks revocation per frame in `toUser`.

## 5. `@ayepi/plugin`: one plugin per hub module

```ts
function plugin<Name, Spec, State, Deps>(config: { name: Name; requires?: Deps; spec: Spec; state?: (ctx: DepsCtx<Deps, Spec>) => State }): Plugin<…>
  // .handlers((ctx) => PartialHandlers<Spec>)  .middleware(def, (ctx) => impl) | .middleware(bound)  .lifecycle((ctx) => ({ up?, down?, stop? }))
interface PluginCtx<Deps, Spec, State> { deps: { [name]: { state; call; emit } }; emit: EmitFn<Spec>; state: State }
type PluginHandlers<P> / PluginHandler<P, K> / PluginMiddleware<P, M> / CtxOf<P>
function createPluginHost(app: Server<AnySpec>, opts?: { onError?: (err, phase: 'down' | 'stop' | 'remove', plugin: string) => void }): PluginHost
interface PluginHost { install(p): Promise<void>; uninstall(name): Promise<void>; installed(): readonly string[]; shutdown(): Promise<void> }
```

Hub modules, in install order: `store` (state only) → `auth` → `actors` → `systems` (pairing,
manifests, links, installed systems) → `budgets` → `queues` (work engine) → `sessions` (turns,
chat) → `content` (resources, sections, index) → `notifications`. Each module's spec slice is in
`hub/shared/<module>.ts`. Its handlers are in `hub/server/<module>/*.ts`, typed with
`PluginHandlers<typeof moduleDef>[name]`. Its service object is its `state(ctx)`, which dependents
reach through `ctx.deps.<module>.state`.

```ts
// hub/server/sessions/plugin.ts
export const sessionsDef = plugin({ name: 'sessions', requires: [authPlugin, queuesPlugin] as const, spec: sessionsSpec, state: (ctx) => new SessionService(ctx.deps.queues.state) })
export const sessionsPlugin = sessionsDef
  .handlers((ctx) => ({ send: send(ctx), messages: messages(ctx) }))
  .lifecycle((ctx) => ({ down: () => ctx.state.drain() }))
```

- **Shared middleware.** `hubAuth` and `tel` defs are imported by every slice and bound **once**,
  in the `auth` plugin's `.middleware(...)`. Binding them again throws `duplicate implementation`.
- **Client type.** The browser needs one spec type. `hubWebSpec` is assembled in shared code from
  the slices: `spec({ endpoints: { ...authSpec.endpoints, ...sessionsSpec.endpoints, … }, events:
  { … } })`. A key that appears in two slices silently wins at the type level (gap G9: a
  `mergeSpecs` with a compile-time collision error).
- **Namespacing.** Prefix each slice's paths with `.path('/sessions')` and similar.

## 6. `@ayepi/work`: LLM queue, run queue, embed batches

```ts
function defineWork<Name, I, S, G>(name: Name, handler: (input: I, ctx: WorkContext) => WorkResult<S, G> | Promise<…>, opts?: WorkOptions<I>): WorkBuilder<Name, I, S, NonVoidUnion<G>>
function defineBatchWork<Name, I, O>(name: Name, config: { size: number; maxWait: number; run: (inputs: I[]) => O[] | Promise<O[]> } & WorkOptions<I>): WorkBuilder<…>
function createWork<const Defs>(opts?: WorkSystemOptions & { work?: Defs }): WorkSystem<Defs>
interface WorkOptions<I> { retry?; priority?; group?; doer?: Doer; queue?: Queue; options?: (input: I) => WorkInstanceOptions; codec?: JsonCodec; onEvent?; onFailure?: FailureClassifier; logContext?: (input: I) => object; timeout?: number; strictReturn?: boolean; skipQueue?: boolean }
interface WorkInstanceOptions { delay?; runAt?; retry?; priority?; group?; deadline?; timeout?; skipQueue? }
interface WorkContext { id; groupId; attempt; parent?; dependents?; result(v, opts?); queue(items, opts?); void(); states(ids); claim(key) }
interface WorkSystem<Defs> { enqueue(work | name, input?, options?): WorkHandle<Self, Group>; schedule(cfg): () => void; start(); stop(): Promise<void>; list(); active(); stats(); metrics; backend }
class WorkDelayError extends Error { constructor(when: { runAt?: number; delay?: number }, message?: string) }
type FailureDecision = 'retry' | 'abort' | { delay: number } | { runAt: number }
// WorkSystemOptions: queue, pubsub, store, retry, doer, pollInterval, backpressure, visibility, heartbeat, prefix, codec,
//   logWith, logContext, onEvent, onError, onBacklog + backlogAfterMs/backlogEveryMs, onFailure, dlq, redriveCount,
//   metrics, accept, unhandledWorkGroup, strictReturn, generateId, autoStart, now, random
```

```ts
// hub/server/queues/work.ts
const llmIteration = defineWork('llm-iteration', (job: LlmJob, ctx) => llm.iterate(job, ctx), {
  options: (job) => ({ priority: cfg.queues.priorities[job.priority], group: job.session ?? job.turn }),
  doer: priorityDoer({ max: cfg.queues.llmConcurrency }),
  onFailure: (err) => (err instanceof ProviderBusy ? { delay: err.retryAfter } : err instanceof BudgetRefused ? 'abort' : 'retry'),
  logContext: (job) => ({ run: job.run, turn: job.turn, iteration: job.iteration }),
})
const runFn = defineWork('run', (job: RunJob, ctx) => runs.execute(job, ctx), {
  options: (job) => ({ priority: cfg.queues.priorities[job.priority] }),
  doer: balancedDoer({ max: cfg.queues.runConcurrency }),
  retry: { attempts: 1 },                       // a fn's retries are its own choice, not the queue's
})
const embedBatch = defineBatchWork('embed', { size: 32, maxWait: 50, run: (items: EmbedItem[]) => embedder.embed(items), doer: priorityDoer({ max: 2 }) })

export const work = createWork({
  work: [llmIteration, runFn, embedBatch] as const,
  ...sqliteBackend(store),                      // gap G4; until then memoryBackend({ queue: { file } })
  codec: createCodec(),                         // @ayepi/codec satisfies JsonCodec structurally
  metrics, logWith: logger.logWith, onEvent: (e) => runEvents.fromWork(e), onError: (err, phase) => logger.warn('work.engine', { phase }, err),
  autoStart: false,                             // updown starts it
})
```

- **One job per LLM iteration** (harness.md "How a turn runs"). When the last run of an iteration
  settles or goes to the background, the hub enqueues the next `llm-iteration`. Harness keeps that
  barrier itself (a counter row per iteration in the store), for two reasons. `.next(works,
  'all-done')` is built on the dependency type, which **polls** (`poll` default 1000 ms). And
  "move to the background early" (a new user message, or the tool timeout) cannot be expressed as
  a dependency condition. `ctx.queue(...)` is still the right way to fan tool calls out as `run`
  jobs in the turn's group, so `group-done` marks the end of the turn.
- **Limits and 429s.** `WorkDelayError({ delay })` and `onFailure → { delay }` reschedule without
  spending an attempt. Use them when a budget window is full and its rule says "wait", and on
  provider 429s. A refused budget is `'abort'`.
- **Deadlines.** `timeout` on `run` jobs comes from the fn's declared time budget. `'expired'`
  events become run outcomes.
- **Low latency.** Enqueue interactive runs with `{ skipQueue: true }`, so the first attempt runs in
  process. A failure still re-enqueues durably.
- **DLQ.** `dlq: deadQueue, redriveCount: 10`. The admin UI lists `memoryQueue().dead`, or the
  SQLite dead table.
- **Cancel** is missing from work (gap G5), and so is an `AbortSignal` on `WorkContext`. Until it
  lands, the hub keeps a `Map<RunId, AbortController>`. A handler registers its run there, passes
  `signal` to `client.call('run', req, { signal })`, and a job that is cancelled while queued
  returns `ctx.result(cancelledOutcome)` as soon as it starts.
- **Per-system concurrency** (`QueueSettings.runConcurrency` is "per system"). Doers cap a whole
  type, not each group. Interim: one `priorityDoer({ max })` per connected system, used inside the
  handler as `doWith(systemDoer(name), () => link.call('run', …), { priority })` (gap G8: `groupMax`
  on bounded doers).

## 7. `@ayepi/rate`

```ts
function limiter(opts: LimiterOptions): Limiter
interface LimiterOptions { limit: number; window: number; algorithm?: 'fixed-window' | 'sliding-window' | 'token-bucket'; store?: RateLimitStore; prefix?: string; countRejected?: boolean }
interface Limiter { check(key: string, now?: number): MaybePromise<RateLimitResult>; reset(key): MaybePromise<void>; readonly rule: RateLimitRule }
interface RateLimitResult { allowed: boolean; limit: number; remaining: number; reset: number; retryAfter: number }
function rateLimitedDoer(opts: RateLimitedDoerOptions): RateLimitedDoer   // key, groupLimit, groupKey, groupStore, retryFloor, doer (inner), onBacklog…
const rateLimit: { (opts?: { requires?; name? }): RateLimitDef; server(def, opts: RateLimitServerOptions): BoundMiddleware }   // '@ayepi/rate/server'
```

- **Per model and provider call starts.** The model is chosen inside the LLM handler (aeye picks
  it), so a doer cannot key on it when it admits the job. Use one `limiter` per configured
  provider/model rule, checked in the hub `AI`'s `beforeRequest`. When `!allowed`, throw
  `new WorkDelayError({ delay: retryAfter })`. That keeps `priorityDoer`'s ordering intact. Do not
  wrap the LLM queue in `rateLimitedDoer`: its waiting tasks are admitted **oldest-first**, so
  priority is lost while rate-limited (gap G10). `memoryStore` here is rate's own, which clashes by
  name with work's `memoryStore`, so import it with an alias.
- **Dollar and token budgets** stay a hub ledger. Rate counts one hit per call (gap G11: weighted
  hits).
- **Sign-in throttle.** `rateLimit({ name: 'signInRate' })` on `signIn`, bound with
  `rateLimit.server(def, { key: (io) => ip(io.req), limit: 10, window: 60_000, algorithm:
  'sliding-window' })`.

## 8. `@ayepi/auth`: single admin account

```ts
// '@ayepi/auth' (frontend-safe defs)
function bearerAuth<Claims, User, R>(opts?: { requires?: R; name?: string; doc?: MiddlewareDoc }): BearerAuthDef<Claims, User, R>
// '@ayepi/auth/server'
bearerAuth.server(def, { secret: string; claims: z.ZodType<Claims>; toUser: (claims, payload, ctx) => User | null | undefined | Promise<…>; expiresIn?: number /* s */; issuer?; audience?; clockToleranceSec?; getToken?: (io) => string | null | undefined })
function signJwt(claims, opts: { secret; expiresIn?; issuer?; audience? }): { token: string; payload: JwtPayload<Claims> }
function verifyJwt<C>(token: string, opts: { secret; issuer?; audience?; clockToleranceSec? }): C & StandardClaims
class JwtError extends Error
```

Context added to handlers: `{ user, jwt, signToken }`.

```ts
// hub/shared/auth.ts
export const AdminClaims = z.object({ actor: ActorId, session: z.string() })   // session = SignInSession id (revocation)
export const hubAuth = bearerAuth<z.infer<typeof AdminClaims>, UserActor>()
// hub/server/auth/plugin.ts
bearerAuth.server(hubAuth, {
  secret: authEnv.get('HARNESS_JWT_SECRET'), claims: AdminClaims, expiresIn: 900, issuer: 'harness-hub', audience: 'web',
  toUser: (claims) => ctx.state.activeUser(claims.session),   // null once revoked ⇒ 401
})
```

- **Single admin mode.** The first start creates the admin from env (`HARNESS_ADMIN_EMAIL`,
  `HARNESS_ADMIN_PASSWORD` hashed on first use) or from a one-time setup link. `signIn` is a public
  endpoint that verifies the password hash and returns `signJwt` plus a refresh token stored in the
  `SignInSession` table. ayepi auth has no password hashing (gap G12). Until then harness uses
  `node:crypto` `scrypt` behind one `PasswordHasher` interface, so SSO later is another
  implementation and no call site changes.
- **ws.** By default `bearerAuth` reads `?access_token=` from the upgrade URL over ws, and the same
  def guards events through `events: { x: { …, guard: [hubAuth] } }`.
- **Systems** do not use JWTs on the link. They use the link-session middleware (section 2.2). The
  `Welcome.token` for HTTP asset uploads and content is a second def,
  `bearerAuth<SystemClaims, LinkSession>({ name: 'systemAuth' })`, with `expiresIn: 300` and
  `audience: 'system'`.
- `expiresIn` and `clockToleranceSec` are in **seconds**. That is ayepi's unit, an exception to
  harness's ms rule, so the env slice holds ms and converts at the binding site.

## 9. `@ayepi/files`

```ts
interface FileStore { put(key, body: FileBody, opts?: { contentType?; metadata? }): Promise<FileInfo>; get(key): Promise<FileObject | undefined>; head(key); delete(key): Promise<boolean>; list(prefix, opts?: { limit?; cursor? }): Promise<ListResult> }
interface Presigner { presignDownload(key, opts?: { expiresIn?: number }): Promise<string>; presignUpload(key, opts?: { expiresIn?: number; contentType?: string }): Promise<string> }
function fsFiles(opts: { dir: string; onError?: (err, op, key) => void }): FileStore            // '@ayepi/files/fs'
function mountFiles(app: Server<AnySpec>, store: FileStore, opts: { secret: string; basePath?: string; expiresIn?: number; now? }): { handle: MountHandle; presign: Presigner }  // '@ayepi/files/server'
function toStream(body: FileBody): ReadableStream<Uint8Array>; function collect(s): Promise<Uint8Array>; function transfer(src, srcKey, dst, dstKey, opts?): Promise<FileInfo>
```

- **Content refs.** The bytes of a `ContentRef { hash, size }` live under
  `content/<sha256-hex>` in `fsFiles({ dir: cfg.files.dir })`. `put` streams to a temp file and
  renames it, so a reader never sees half a file. The hub hashes as it streams, and the key comes
  from the hash, so identical content is stored once. `HubLink.content` and `SystemLink.content`
  serve chunks with `get(key).stream()` sliced by `offset`/`length`. A large body moves by
  presigned URL instead.
- **Uploads from the browser.** Call `presignUpload('upload/<uuid>', { contentType, expiresIn: 600
  })`, `PUT` with `fetch`, then `send` with the file part. The hub hashes it and moves it into
  `content/` (`transfer`, then `delete`).
- **System client bundles.** The hub keeps them under `systems/<name>/<version>/client/*` and serves
  them through a cached GET endpoint (section 14).
- `mountFiles` installs its routes onto the live server (`ayepiFilesDownload`/`ayepiFilesUpload` at
  `basePath`, default `/_files`), and downloads support HTTP Range. `expiresIn` is in **seconds**.
  Presigned uploads have no size cap and no hash check (gap G13).

## 10. `@ayepi/env`: one slice per module

```ts
function env(input: EnvInput, options?: EnvOptions): Env<T>
interface Env<T> { add(input): Env<T & …>; get(key): T[K]; set(key, value: T[K] | string): void; set(updates): void; parse(): T; on(…): () => void; with(fn); map(fn) }
function alias<S extends z.ZodType>(schema: S, ...keys: string[]): S
function loadEnv(opts?: { files?: string[]; required?: boolean | readonly string[] }): EnvSource   // '@ayepi/env/load'
class EnvError extends Error { issues }
```

Strings are coerced before zod runs, so plain `z.number()` and `z.boolean()` work. Values resolve
lazily and are cached. `set` overrides `process.env`. `on` notifies on change.

```ts
// hub/server/queues/env.ts — the queue module's tunables, defaults in the schema
export const queuesEnv = env({
  HARNESS_LLM_CONCURRENCY: z.int().min(1).default(4),
  HARNESS_RUN_CONCURRENCY: z.int().min(1).default(8),
  HARNESS_TOOL_TIMEOUT: z.int().min(1_000).default(30_000),        // ms
  HARNESS_ACTIVE_WINDOW: z.int().min(1_000).default(120_000),      // ms
})
// hub/server/config.ts — HubConfig is derived, not hand-written
export const hubEnv = env({ HARNESS_PORT: z.int().default(4300), HARNESS_URL: z.url(), HARNESS_DATA: z.string().default('.harness') })
  .add({ HARNESS_DB_FILE: (e) => z.string().default(`${e.HARNESS_DATA}/hub.sqlite`) })
export type HubEnv = ReturnType<typeof hubEnv.parse>
```

- In the entry point, `hubEnv.set(loadEnv({ files: ['.env'] }))` and the slices are `parse()`d once
  at boot, so a bad value fails start-up with one aggregated `EnvError`.
- `types/hub.ts`'s `HubConfig` interface becomes derived from the slices' parsed types. Keeping both
  would give two sources of truth.
- Gaps: no key prefix option (every key repeats `HARNESS_`), no way to merge several slices into one
  `Env`, and no description export for an admin "settings" page or `.env.example` (gap G14).

## 11. `@ayepi/log`: logs and console interception

```ts
function createLogger(config?: LoggerConfig): Logger
interface LoggerConfig { level?; structured?; timestamp?: 'iso' | 'epoch'; transports?: readonly Transport[]; interceptConsole?: boolean; consoleMap?; console?; error?: ErrorConfig; filter?; sanitize?: SanitizeOptions; serializers?: readonly Serializer[]; onError?; now? }
interface Logger { log(level, ...args); debug; info; warn; error; logWith<R>(add: object, inner: () => R): R; context(); setTransports(t); setLevel(l); isLevelEnabled(l); flush(); close(); interceptConsole(): () => void; restoreConsole(): void }
interface Transport { readonly name: string; write(record: LogRecord, text: string): void | Promise<void>; flush?(); close?() }
function consoleTransport(opts?: ConsoleTransportOptions): Transport
function fileTransport(opts: { path; maxSize?; maxFiles?; structured?; strategy?: 'size' | 'date'; flushInterval?; maxBufferBytes?; fs?; onError?; now? }): Transport   // '@ayepi/log/file'
interface SanitizeOptions { filter?; sensitiveKeys?: (string | RegExp)[]; sensitiveValues?; mask?; maxStringLength?; maxArrayLength? }
```

```ts
// shared by hub and SDK: harness/log.ts
export const logger = createLogger({
  level: logEnv.get('HARNESS_LOG_LEVEL'), structured: logEnv.get('HARNESS_LOG_JSON'),
  transports: [consoleTransport(), fileTransport({ path: `${dataDir}/logs/hub.log`, maxFiles: 7, strategy: 'date' })],
  interceptConsole: true,
  sanitize: { sensitiveKeys: ['password', 'authorization', 'cookie', /token$/i, /secret/i, /apikey/i], maxStringLength: 4_000, maxArrayLength: 50 },
})
logger.info('run.settled', { run, fn, status, duration })   // the message is a stable dotted key; fields are structured
```

- **Structured keys.** The message is a stable dotted key (`turn.started`, `link.paired`), and
  everything else goes in a fields object. This matches `HubLink.log({ level, key, fields })`.
- **System logs.** The SDK installs a `linkTransport: Transport` whose `write` sends
  `hub.call('log', …)`. Its own failures go to the local console transport only, never back into
  the logger. The hub writes system logs to its logger under `logWith({ system }, …)`, and to the
  run's record when `run` is in context.
- **Run context.** The run worker wraps each job in `logger.logWith({ run, turn, fn }, …)`, so
  every line and every thrown error inside carries the run.
- **Shutdown.** `logger.close()` runs in updown's last `post` hook.

## 12. `@ayepi/otel`: request telemetry

```ts
function telemetry(opts?: { name?: string; requires?: readonly AnyMiddleware[] }): TelemetryDef     // '@ayepi/otel'
telemetry.server(def, { logger?; logWith?; level?; context?: RequestFieldFlags; request?: RequestFieldFlags | false; response?: ResponseFieldFlags | false; overrides?: Record<string, PerCallOptions>; requestId?: (req) => string; echoRequestId?: boolean | string; extra?: (ctx, req) => object; now? })  // '@ayepi/otel/server'
```

- `tel = telemetry()` goes first in every chain: `use(tel, hubAuth)`, and `use(tel, linkSession)`
  on the link. Bind it with `telemetry.server(tel, { logger, logWith: logger.logWith, echoRequestId:
  true, overrides: { healthz: { request: false, response: false }, progress: { request: false } } })`.
  Over ws, the request id is the frame id.
- Despite its name, it is **not OpenTelemetry**: it does not create spans, export OTLP or propagate
  `traceparent`. The fn tree and the LLM calls are traced by the hub's own records (`Run`,
  `LlmInteraction`), which is what the UI shows. Real OTel export is a later library ask (gap G15).

## 13. `@ayepi/updown`: start and stop

```ts
function updown(opts?: { signals?: readonly Signal[] | false; exit?: boolean; timeout?: number; onError?: (err, phase: 'up' | 'pre' | 'post', name: string) => void; process?: ProcessLike }): UpDown
interface Component { name: string; deps?: readonly string[]; up?(); pre?(); post?() }
interface UpDown { register(c): UpDown; up(); down(); whenDown(); isReady(); isLive(); list(): ComponentStatus[] }
```

```ts
const lc = updown({ signals: ['SIGINT', 'SIGTERM', 'SIGBREAK'], timeout: 30_000, onError: (err, phase, name) => logger.error('lifecycle.failed', { phase, name }, err) })
lc.register({ name: 'store', up: () => store.migrate(), post: () => store.close() })
  .register({ name: 'plugins', deps: ['store'], up: () => installAll(host), post: () => host.shutdown() })
  .register({ name: 'work', deps: ['plugins'], up: () => work.start(), pre: () => work.stop() })
  .register({ name: 'http', deps: ['plugins'], up: () => listen(), pre: () => stopAccepting(), post: () => closeHttp() })
  .register({ name: 'links', deps: ['http'], pre: () => links.announceStopping('shutdown'), post: () => links.closeAll() })
  .register({ name: 'installed', deps: ['links'], up: () => installed.startAll(), pre: () => installed.stopAll() })
  .register({ name: 'log', post: () => logger.close() })
await lc.up(); await lc.whenDown()
```

- **Windows.** Node on Windows does not deliver `SIGTERM` from `kill`; `SIGINT` (Ctrl+C) and
  `SIGBREAK` work. An installed system the hub started is stopped by sending its `stopping`
  lifecycle event over the link with a deadline. `child.kill()` is only a fallback, because on
  Windows it terminates the process at once.
- `/healthz` reports `isLive()` and `/readyz` reports `isReady()`.
- `deps` are plain strings, so a misspelled dependency only fails at `up()` (gap G16: typed names).
  Harness keeps component names in one `const` object to limit the risk.

## 14. `@ayepi/cache`

```ts
function cache(opts?: { requires?; name? }): CacheDef                                   // '@ayepi/cache'
cache.server(def, { ttl: number; staleWhileRevalidate?; methods?; vary?; key?; hash?; checkKey?; store?; maxBytes?; maxEntryBytes?; maxEntries?; shouldCache?; headers?; skip?; onError?; now? })  // '@ayepi/cache/server'
function memoryCache(opts?: { maxBytes?; maxEntryBytes?; maxEntries? }): CacheStore
interface CacheStore { get; set; delete; clear; invalidate(pred: (meta: EntryMeta) => boolean): MaybePromise<number> }
```

Put it last in the chain (`use(tel, hubAuth, cached)`). Use it for GETs whose answer is the same
for every caller: system client bundles (immutable per version), the model catalog, and
`capabilities` (with `vary` by session). Keep the `store` in the systems plugin's state and call
`store.invalidate(m => m.path.startsWith('/systems/'))` when a system's manifest changes. Most UI
read caching happens on the client through callers (section 4), not here.

## 15. `@ayepi/codec`

```ts
function createCodec(options?: { types?: readonly TypeCodec[]; replaceBuiltins?: boolean; tagKey?: string }): Codec
interface Codec { stringify(v): string; parse(t): unknown; encode(v): unknown; decode(v): unknown }
interface TypeCodec<T> { tag: string; test(v): boolean; encode(v: T, recurse); decode(p, recurse): T }
```

- `createCodec()` is the work codec (it structurally satisfies work's
  `JsonCodec { stringify; parse }`), so job inputs keep `undefined`, `Date` and `Error` intact.
  work also ships its own tagged codec (`$ayepi` tag) that repeats this package's job (gap G17:
  work should use `@ayepi/codec`).
- The browser keeps drafts and UI state with `stringify`/`parse` in `localStorage`.
- Not used on the link. gin JSON is the wire form for fn values.

## 16. `@ayepi/mcp`: systems as MCP servers

```ts
function mcpTools(spec: AnySpec, opts?: { include?: (name, cfg) => boolean; namePrefix?: string }): McpTool[]
function mcpServer(app: Server<AnySpec>, spec: AnySpec, opts?: { baseUrl?; serverInfo?; headers?; include?; namePrefix? }): McpServer
interface McpServer { tools(): McpTool[]; handle(request: unknown): Promise<unknown> }
function serveStdio(server: McpServer, opts: { input: LineReader; output: LineWriter }): Promise<void>
```

It maps an ayepi **spec** to tools, one per endpoint, and supports `initialize`, `tools/list` and
`tools/call` (protocol `2024-11-05`). A harness system's fns are **gin-typed and change at
runtime**, not ayepi endpoints. `mcpServer(app, systemLinkSpec)` would expose `run`, `control` and
the rest, not the system's fns. The SDK's `serveMcp` therefore needs the library change first
(gap G18):

```ts
// proposed: @ayepi/mcp
function mcpProtocol(source: {
  listTools(): McpTool[]; callTool(name: string, args: unknown, signal: AbortSignal): Promise<McpToolResult>
  listResources?(cursor?): Promise<…>; readResource?(uri): Promise<…>; listPrompts?(): …; getPrompt?(name, args): …
  onChange?(cb: (what: 'tools' | 'resources' | 'prompts') => void): () => void   // → notifications/*/list_changed
}, info: { name: string; version: string }): McpServer
function serveHttp(server: McpServer, opts): (req: Request) => Promise<Response>   // Streamable HTTP
function mcpClient(transport): McpClient   // for the MCP bridge system (later)
```

The SDK then builds `listTools` from the contract: name `fs_read_file`, description from the fn
docs, `inputSchema` from gin through `toValueSchema` → zod → JSON schema, the same path aeye tool
schemas take. Resources map to the system's roots, prompts to `/name` commands.

## 17. `@ayepi/mock`: UI before the hub

```ts
function mockServer(spec: AnySpec, opts?: MockOptions): Server<AnySpec>
function mockHandlers(spec, opts?): Record<string, Handler>
function generate(schema: z.ZodType, opts?: MockOptions, ctx?: Partial<GenContext>): unknown
interface MockOptions { seed?; deterministic?; arraySize?; limitKeys?; overrides?: { fields?; formats? }; now? }
```

`web/dev/mock.ts` runs `serve(mockServer(hubWebSpec, { seed: 'ui', now: () => fixedNow }), { port:
<given>, path: '/ws' })`. Mock data is deterministic, so puppeteer screenshots stay stable. Use
`{ ...mockHandlers(hubWebSpec), ...realHandlers }` to swap in real pieces as they land, and
`overrides.fields` for ids, names and markdown bodies that read naturally.

Mock emits **no events**, so streaming tokens, run progress and state changes need a small
scripted emitter in the dev server that calls `app.emit('turnDelta', …)` on a timer (gap G19: a
`mockEvents(spec, { rate })`).

## 18. `@ayepi/context`

`"context:sync": "ayepi-context docs/ayepi --prune"` as a dev script. It copies `ayepi.md` and every
installed `ayepi-*.md` into `docs/ayepi/` for agents. Run it again after a library change (the docs
ship inside each package). It reads `node_modules/@ayepi/*`, so it follows the `file:` links.

## 19. `@ayepi/stress`

Use `benchmarkArchetypes()` and `stressTarget(handle, { … })` (`spawnTarget`, `scrapeStats`) to
ramp the hub's SQLite-backed `run` queue in its own process and find where it bends (Risk 8: "the
SQLite work queue still gets a load test"). It also suggests the `shed.thresholdMs` value.

## 20. Not used

- `@ayepi/aws` (`sqsQueue`, `s3Files`) and `@ayepi/redis` (`redisBroker`, `redisStore`,
  `redisPubSub`, `redisCache`) are for multi-instance or cloud deployments. Harness is one hub
  process on SQLite. The ports they implement (`Broker`, `Queue`/`Store`/`PubSub`, `FileStore`,
  `CacheStore`) are the same ones harness codes against, so they can be dropped in later.
- `@ayepi/bun` and `@ayepi/deno`: harness runs on Node 22.

## 21. Library gaps

Each gap gets fixed in the ayepi checkout on the `harness` branch, then rebuilt (`dist/`). Order is
by what blocks the first milestone.

| # | Package | Gap | Blocks | Interim in harness |
|---|---|---|---|---|
| G1 | core | **Peer mode:** both directions on one socket. Today call, reply, event, `chunk`, `end` and `abort` frames are identical in each direction. | system link, POC 1 | none; build order step 1 |
| G2 | core, node | **Binary frames** (MessagePack/CBOR); node reads `String(data)` | frame size | JSON text |
| G3 | node | `handleUpgrade(app, server, path)` destroys sockets on other paths, so two apps cannot share a server. Needs a path → handler map. | `/ws` and `/link` on one port | own `upgrade` router with `noServer` `WebSocketServer`s |
| G4 | work | **SQLite ports** (`Queue`, `Store`, `PubSub`) on better-sqlite3, sharing the hub's database file | durable queues | `memoryBackend({ queue: { file } })` |
| G5 | work | **Cancel** of queued and running work, and `signal: AbortSignal` on `WorkContext` | cancel and pause runs | hub `Map<RunId, AbortController>` |
| G6 | core | Client types say `z.output` but the client skips parsing by default, so `z.date()` and transforms lie. Fix: type the client by the JSON wire form (zod 4 codecs / `z.encode`), or decode by default. | type safety | JSON-shaped wire schemas only |
| G7 | core/client | `wsTransport.reconnect()` (today `close()` is permanent), so a refreshed token can reopen the socket | token rotation | long-lived access token, revocation checked in `toUser` |
| G8 | core/doer | A per-group concurrency cap (`groupMax`) on bounded doers | per-system run concurrency | a `priorityDoer` per system with `doWith` |
| G9 | core | `mergeSpecs(...slices)` with a compile-time error on key collisions | one browser spec from plugin slices | spread with a collision test |
| G10 | rate | `rateLimitedDoer` admits waiting tasks oldest-first, so priority is lost. Needs `order: 'priority'`. | priority under rate limits | `limiter` in `beforeRequest` + `WorkDelayError` |
| G11 | rate | Weighted hits (`consume(key, rule, now, weight)`), so limits can count tokens or dollars | token-based limits | hub ledger |
| G12 | auth | `hashPassword`/`verifyPassword` (scrypt) in `@ayepi/auth/server` | admin sign-in | `PasswordHasher` on `node:crypto` |
| G13 | files | Presigned upload `maxSize` and expected `sha256` | upload safety | hub checks after `PUT` |
| G14 | env | Key prefix, merging slices, and a description export | settings page, `.env.example` | repeat the `HARNESS_` prefix |
| G15 | otel | Real spans, OTLP export, `traceparent` propagation | external tracing (later) | hub run and LLM records |
| G16 | updown | Typed component names in `deps` | compile-time order checks | names in one `const` object |
| G17 | work | Use `@ayepi/codec` instead of its own `$ayepi` codec (DRY) | — | pass `createCodec()` |
| G18 | mcp | A dynamic tool source (not spec-bound), resources, prompts, `list_changed`, Streamable HTTP, an MCP client | system MCP face, MCP bridge | none; SDK `serveMcp` waits on it |
| G19 | mock | Event emission (`mockEvents`) | realtime UI on mocks | scripted emitter in the dev server |
| G20 | core/client | `Tagger`'s `result` argument is `unknown`. Type it by the endpoint's response. | tag precision | tags from `data` only |
| G21 | ayepi (new) | Web push (VAPID), already on harness.md's list | push notifications | none |

Also on harness.md's ask list and confirmed missing here: none of G1, G4, G5, G11 or G18 exist in
the source at `0.4.1`.
