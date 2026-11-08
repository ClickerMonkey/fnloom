/**
 * The hub MCPs' endpoints (`McpEndpoints`): one `@ayepi/mcp` server per enabled MCP (`mcpSourceServer` over its
 * tools, resources and prompts), mounted on an `McpRouter` at `/mcp/<slug>` with its own authorizer (`McpBearer`) and
 * allowed origins. A change to an MCP rebuilds its server (rotating the secret or switching it off ends its open
 * sessions); a change to the catalog, a system's status or the resource roots refreshes every MCP's lists, so clients
 * hear `list_changed`. Open sessions are tracked as the library opens and ends them (a client that goes quiet with
 * no open event stream for `idleTimeout` is ended), with the client each said it was and its tool calls.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  bearerToken, mcpSourceServer, McpRouter, type McpAuthDecision, type McpAuthorizer, type McpHttpSession, type McpServer, type McpSessionEndReason,
} from '@ayepi/mcp';
import type { Logger } from '@ayepi/log';
import { messageOf, type HubMcp, type HubMcpId, type McpSessionView } from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { McpEndpoints, McpRegistry, McpTokens } from './index.ts';
import { MCP_PATH } from '../api/http.ts';
import { SECRET_PREFIX, secretDigest } from './registry.ts';
import type { HubMcpTools } from './tools.ts';
import type { HubMcpPrompts, HubMcpResources } from './sources.ts';

/** The realm a refused bearer is challenged with. */
const REALM = 'harness';

/** Who a bearer lets in on one MCP: its endpoint secret, or a session token minted from it. */
export class McpBearer implements McpAuthorizer {
  readonly #mcp: HubMcpId;
  readonly #registry: () => Pick<McpRegistry, 'record'>;
  readonly #tokens: () => Pick<McpTokens, 'verify'>;

  constructor(mcp: HubMcpId, registry: () => Pick<McpRegistry, 'record'>, tokens: () => Pick<McpTokens, 'verify'>) {
    this.#mcp = mcp;
    this.#registry = registry;
    this.#tokens = tokens;
  }

  async authorize(request: Request): Promise<McpAuthDecision> {
    const token = bearerToken(request);
    if (token === undefined) return { ok: false, status: 401, message: 'a bearer token is required', challenge: `Bearer realm="${REALM}"` };
    const record = await this.#registry().record(this.#mcp);
    const refused: McpAuthDecision = { ok: false, status: 401, message: 'the bearer token is not valid here', challenge: `Bearer realm="${REALM}", error="invalid_token"` };
    if (record?.enabled !== true) return refused;
    if (token.startsWith(SECRET_PREFIX)) return sameDigest(secretDigest(token), record.secretDigest) ? { ok: true, auth: { subject: 'secret', scopes: [] } } : refused;
    const claims = await this.#tokens().verify(token);
    return claims?.mcp === record.id ? { ok: true, auth: { subject: `token:${claims.label}`, scopes: [] } } : refused;
  }
}

/** Whether two hex digests are the same, compared in constant time. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** One MCP's mounted server and its parts. */
interface Face {
  readonly record: HubMcp;
  readonly server: McpServer;
  readonly tools: HubMcpTools;
  readonly prompts: HubMcpPrompts;
  readonly sessions: Map<string, McpSessionView>;
  /** Stops hearing its tool calls. */
  readonly unhear: () => void;
}

/** The parts of one MCP's server, made per MCP. */
export interface FaceParts {
  readonly tools: HubMcpTools;
  readonly resources: HubMcpResources;
  readonly prompts: HubMcpPrompts;
}

/** What the endpoints use. */
export interface HubMcpEndpointsDeps {
  readonly registry: () => Pick<McpRegistry, 'record'>;
  readonly tokens: () => Pick<McpTokens, 'verify'>;
  readonly list: () => Promise<readonly HubMcp[]>;
  /** The tools, resources and prompts of one MCP. */
  readonly parts: (mcp: HubMcp) => FaceParts;
  readonly bus: EventBus;
  readonly clock: () => number;
  readonly log: Logger;
  readonly maxBody: number;
  /** How long a session may go with no request and no open event stream before it ends, in milliseconds. */
  readonly idleTimeout: number;
  readonly serverInfo: { readonly name: string; readonly version: string };
}

/** The hub MCPs on one router. */
export class HubMcpEndpoints implements McpEndpoints {
  readonly #deps: HubMcpEndpointsDeps;
  readonly #router: McpRouter;
  readonly #faces = new Map<HubMcpId, Face>();
  /** Each MCP's latest remount, so changes in quick succession apply in order. */
  #queue: Promise<void> = Promise.resolve();

  constructor(deps: HubMcpEndpointsDeps) {
    this.#deps = deps;
    this.#router = new McpRouter({ base: MCP_PATH, defaults: { maxBody: deps.maxBody, idleTimeout: deps.idleTimeout } });
  }

  handle(request: Request): Promise<Response> {
    return this.#router.fetch(request);
  }

  sessions(mcp: HubMcpId): Promise<McpSessionView[]> {
    return Promise.resolve([...(this.#faces.get(mcp)?.sessions.values() ?? [])]);
  }

  /** How many sessions an MCP has open now. */
  sessionCount(mcp: HubMcpId): number {
    return this.#faces.get(mcp)?.sessions.size ?? 0;
  }

  async start(): Promise<() => void> {
    for (const record of await this.#deps.list()) await this.#mount(record);
    const refresh = (): void => { this.#serially(() => this.#refreshAll()); };
    const stops = [
      this.#deps.bus.subscribe('mcp.changed', ({ mcp }) => {
        this.#serially(async () => {
          const record = await this.#deps.registry().record(mcp);
          if (record === undefined) this.#unmount(mcp);
          else await this.#mount(record);
        });
      }),
      this.#deps.bus.subscribe('catalog.changed', refresh),
      this.#deps.bus.subscribe('system.status', refresh),
      this.#deps.bus.subscribe('resources.roots', refresh),
    ];
    return () => {
      for (const stop of stops) stop();
      for (const id of [...this.#faces.keys()]) this.#unmount(id);
      this.#router.close();
    };
  }

  /** Wait for every queued remount and refresh (tests). */
  settled(): Promise<void> {
    return this.#queue;
  }

  /** Run one change after the ones before it. */
  #serially(work: () => Promise<void>): void {
    this.#queue = this.#queue.then(work).catch((error: unknown) => { this.#deps.log.error('mcp.endpoint.failed', { error: messageOf(error) }); });
  }

  /** (Re)build an MCP's server and mount it at its route; a switched-off MCP is only taken down. */
  async #mount(record: HubMcp): Promise<void> {
    this.#unmount(record.id);
    if (!record.enabled) return;
    const parts = this.#deps.parts(record);
    await Promise.all([parts.tools.refresh(), parts.prompts.refresh()]);
    const sessions = new Map<string, McpSessionView>();
    const server = mcpSourceServer({ tools: parts.tools, resources: parts.resources, prompts: parts.prompts }, {
      serverInfo: this.#deps.serverInfo, ...(record.instructions === '' ? {} : { instructions: record.instructions }),
    });
    const unhear = parts.tools.onCall(({ session }) => {
      const known = sessions.get(session);
      if (known !== undefined) sessions.set(session, { ...known, calls: known.calls + 1, lastCallAt: this.#deps.clock() });
    });
    this.#faces.set(record.id, { record, server, tools: parts.tools, prompts: parts.prompts, sessions, unhear });
    this.#router.mount(record.slug, server, {
      authorize: new McpBearer(record.id, this.#deps.registry, this.#deps.tokens),
      allowedOrigins: record.origins,
      onSessionOpened: (session) => { this.#opened(record, sessions, session); },
      onSessionEnded: (session, reason) => { this.#ended(record, sessions, session, reason); },
    });
    this.#deps.log.info('mcp.mounted', { mcp: record.id, slug: record.slug, mode: record.toolMode, tools: server.tools().length });
  }

  /** Take an MCP's server down: its sessions end and its event streams close. */
  #unmount(mcp: HubMcpId): void {
    const face = this.#faces.get(mcp);
    if (face === undefined) return;
    this.#faces.delete(mcp);
    this.#router.unmount(face.record.slug);
    face.unhear();
    face.server.close();
  }

  /** Refresh every mounted MCP's lists (the scope may have changed under them). */
  async #refreshAll(): Promise<void> {
    await Promise.all([...this.#faces.values()].map(async (face) => {
      await Promise.all([face.tools.refresh(), face.prompts.refresh()]);
    }));
  }

  /** Record a session the library opened: who it is, the client it said it was. */
  #opened(record: HubMcp, sessions: Map<string, McpSessionView>, session: McpHttpSession): void {
    const view: McpSessionView = {
      mcp: record.id, session: session.id, label: session.auth?.subject ?? 'secret', since: this.#deps.clock(), calls: 0,
      ...(session.client === undefined ? {} : { client: { name: session.client.name, version: session.client.version } }),
    };
    sessions.set(session.id, view);
    this.#deps.log.info('mcp.session.opened', { mcp: record.id, session: session.id, label: view.label, client: view.client?.name ?? null });
  }

  /** Forget a session the library ended: the client's DELETE, idle past the timeout, or the MCP taken down. */
  #ended(record: HubMcp, sessions: Map<string, McpSessionView>, session: McpHttpSession, reason: McpSessionEndReason): void {
    sessions.delete(session.id);
    this.#deps.log.info('mcp.session.ended', { mcp: record.id, session: session.id, reason });
  }
}
