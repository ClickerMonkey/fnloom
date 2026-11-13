/**
 * One MCP server instance at work: its links to the server (its own, signed with the config's shared credentials, and
 * one per person connection for a per-person or OAuth server), the mirror of its lists into the hub (sent as runtime
 * patches, only what changed, never removing), its status, tool calls and the questions they ask, and its resources.
 */
import type { McpClient, McpElicitRequest, McpElicitResult, McpTool, McpToolResult } from '@ayepi/mcp';
import { McpError } from '@ayepi/mcp';
import {
  Json, JsonObject, McpServerConfig, ResourceUri, mcpRootOf, messageOf, type ConnectionUpdate, type ImportReport, type InstanceConnect, type InstanceName, type McpServerState,
  type McpServerStatus, type Page, type ReadWant, type RemoteCredentials, type ResourceRead, type ResourceRoot, type ResourceStat, type RunConnection,
} from '@harness/core';
import type { Log, ResourceProvider } from '@harness/sdk';
import type { SystemPatch } from '@harness/sdk/server';
import type { z } from 'zod';
import { headersOf, instanceConnectOf, readCredentials, sharedHeaders, usesConnections } from './auth.ts';
import type { DialerFactory, Signer } from './dial.ts';
import { Elicitations, type AskingRun } from './elicitation.ts';
import type { McpSettings } from './env.ts';
import { hubUri, mirrorTools, placeholders, promptDecl, promptText, Sent, serverUri } from './mirror.ts';
import { OAuthSignIn } from './oauth.ts';
import { LinkDown, ServerLink, type McpList } from './server-link.ts';

/** What the instance asks of the hub, as the running system. */
export interface HubSide {
  patch(change: SystemPatch): Promise<ImportReport>;
  instanceConnect(connect: z.input<typeof InstanceConnect>): Promise<void>;
}

/** Everything an instance is built from. */
export interface InstanceDeps {
  readonly instance: InstanceName;
  readonly config: McpServerConfig;
  readonly settings: McpSettings;
  readonly dialers: DialerFactory;
  readonly hub: HubSide;
  readonly log: Log;
  readonly version: string;
  readonly now: () => number;
  /** The `fetch` OAuth sign-in uses. */
  readonly fetch: typeof fetch;
}

/** A tool call's run, as the instance needs it: its connection, end, proposals and refreshing its credentials. */
export interface CallingRun extends AskingRun {
  readonly connection: RunConnection | undefined;
  updateConnection(update: ConnectionUpdate['update']): Promise<void>;
}

/** How a tool call ended, for the kind to report. */
export type CallResult = { readonly result: McpToolResult } | { readonly down: LinkDown } | { readonly refused: string };

/** A person's link, and the credentials it was made with. */
interface PersonLink {
  readonly link: ServerLink;
  readonly key: string;
  readonly signer: PersonSigner;
}

/**
 * Signs a person's link with their connection's credentials. Refused OAuth tokens are refreshed and handed to the hub
 * through the newest run on the link (`update`), which is also told when they can't be.
 */
class PersonSigner implements Signer {
  credentials: RemoteCredentials;
  link: ServerLink | undefined;
  update: CallingRun['updateConnection'] | undefined;
  readonly #oauth: OAuthSignIn | undefined;

  constructor(credentials: RemoteCredentials, oauth: OAuthSignIn | undefined) {
    this.credentials = credentials;
    this.#oauth = oauth;
  }

  headers(): Promise<Record<string, string>> { return Promise.resolve(headersOf(this.credentials)); }

  async refresh(): Promise<boolean> {
    const fresh = await this.#oauth?.refresh(this.credentials);
    if (fresh === undefined) {
      if ('accessToken' in this.credentials) { await this.#tell({ expired: 'The server refused the sign-in and it could not be renewed: sign in again.' }); }
      return false;
    }
    this.credentials = fresh.credentials;
    await this.#tell({ credentials: Json.parse(fresh.credentials), ...(fresh.expiresAt === undefined ? {} : { expiresAt: fresh.expiresAt }) });
    return true;
  }

  /** Hand the hub the change through the newest run (best effort: that run may have ended; the next one tells again). */
  async #tell(update: ConnectionUpdate['update']): Promise<void> {
    await this.update?.(update).catch(() => undefined);
  }

  refused(): void { this.link?.credentialsRefused(); }
}

/** The text of a server answer that failed, for a run's failure. */
export function answerText(result: McpToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n') || 'The tool failed without saying why.';
}

/** One MCP server instance. */
export class McpInstance {
  readonly instance: InstanceName;
  readonly elicitations: Elicitations;
  readonly #deps: InstanceDeps;
  readonly #config: McpServerConfig;
  readonly #own: ServerLink | undefined;
  readonly #people = new Map<string, PersonLink>();
  readonly #inFlight = new Map<ServerLink, CallingRun[]>();
  readonly #sentFns = new Sent();
  readonly #sentPrompts = new Sent();
  readonly #sweep: ReturnType<typeof setInterval>;
  readonly #oauth: OAuthSignIn | undefined;
  #counts: { readonly tools: number; readonly prompts: number; readonly resources: number; readonly leftOut: number; readonly degraded: readonly string[] } = {
    tools: 0, prompts: 0, resources: 0, leftOut: 0, degraded: [],
  };
  #mirrored = false;
  #mirroring: Promise<void> | undefined;
  #again = false;
  #settle: ReturnType<typeof setTimeout> | undefined;
  #last: ServerLink | undefined;
  #checkedAt: number;
  #closed = false;

  constructor(deps: InstanceDeps) {
    this.#deps = deps;
    this.instance = deps.instance;
    this.#config = deps.config;
    this.#checkedAt = deps.now();
    this.elicitations = new Elicitations(deps.config.label);
    const { auth, transport } = deps.config;
    this.#oauth = auth.kind === 'oauth' && transport.type !== 'stdio' ? new OAuthSignIn(transport.url, auth, { fetch: deps.fetch, now: deps.now }) : undefined;
    const headers = sharedHeaders(deps.config.auth);
    this.#own = usesConnections(deps.config.auth) ? undefined : this.#link({
      headers: () => Promise.resolve(headers), refresh: () => Promise.resolve(false), refused: () => { this.#own?.credentialsRefused(); },
    }, true);
    this.#sweep = setInterval(() => { void this.#closeIdle(); }, Math.max(1_000, deps.settings.MCP_IDLE_CLOSE / 2));
    this.#sweep.unref();
  }

  /** The config it runs with. */
  get config(): McpServerConfig { return this.#config; }

  /** Say how people connect, and connect the instance's own link (which mirrors once connected). */
  async start(): Promise<void> {
    await this.#deps.hub.instanceConnect(instanceConnectOf(this.#config));
    this.#own?.start();
  }

  /** Where the server is, as the MCP servers page and `server_status` show it. */
  status(): McpServerStatus {
    const link = this.#own ?? this.#last;
    const state: McpServerState = link?.state ?? 'needs-auth';
    const problem = link === undefined ? 'Each person signs in to this server on the Connections page; its tools are mirrored once someone has.' : link.problem;
    const server = link?.server;
    return {
      instance: this.instance,
      state,
      ...(server === undefined ? {} : {
        server: { name: server.serverInfo.name, version: server.serverInfo.version, protocol: server.protocolVersion, ...(server.instructions === undefined ? {} : { instructions: server.instructions }) },
      }),
      tools: this.#counts.tools,
      prompts: this.#counts.prompts,
      resources: this.#counts.resources,
      degraded: [...this.#counts.degraded],
      leftOut: this.#counts.leftOut,
      ...(problem === undefined ? {} : { problem }),
      checkedAt: this.#checkedAt,
    };
  }

  /** List everything again (with this person's link when the server is per person) and mirror it; then the status. */
  async refresh(connection: RunConnection | undefined): Promise<McpServerStatus> {
    const link = this.#own ?? (connection === undefined ? undefined : this.#personLink(connection)?.link);
    if (link !== undefined) {
      try {
        await link.client();
        await this.#mirror(link);
      } catch (error) {
        if (!(error instanceof LinkDown)) { throw error; }
      }
    }
    return this.status();
  }

  /**
   * Check a person's credentials as they connect: connect with them (and mirror the lists, when nothing was mirrored
   * yet). The link is kept for their calls. The problem in words when the server can't be reached with them.
   */
  async verify(connection: RunConnection['id'], credentials: RemoteCredentials): Promise<string | undefined> {
    const person = this.#personLink({ id: connection, credentials: Json.parse(credentials) });
    if (person === undefined) { return 'Those credentials are not a token or header values.'; }
    try {
      await person.link.client();
      this.#last = person.link;
      if (!this.#mirrored) { await this.#mirror(person.link); }
      return undefined;
    } catch (error) {
      this.#people.delete(connection);
      await person.link.close();
      if (error instanceof LinkDown) { return error.message; }
      throw error;
    }
  }

  /** A person disconnected: close their link. */
  async forget(connection: RunConnection['id']): Promise<void> {
    const person = this.#people.get(connection);
    this.#people.delete(connection);
    await person?.link.close();
  }

  /** OAuth sign-in to this server; `undefined` when it doesn't sign in with OAuth. */
  get oauth(): OAuthSignIn | undefined { return this.#oauth; }

  /** Call a tool as the run's connection (or the instance's own link), with the server's questions asked of the run's person. */
  async call(tool: string, args: Json, run: CallingRun): Promise<CallResult> {
    const input = JsonObject.safeParse(args);
    if (!input.success) { return { refused: 'A tool takes an object of arguments.' }; }
    const link = this.#linkFor(run);
    if ('refused' in link) { return link; }
    const calls = this.#inFlight.get(link) ?? [];
    calls.push(run);
    this.#inFlight.set(link, calls);
    try {
      const signal = AbortSignal.any([run.signal, AbortSignal.timeout(this.#config.timeout)]);
      const result = await link.use((client) => client.callTool(tool, input.data, { signal }), signal);
      return { result };
    } catch (error) {
      if (error instanceof LinkDown) { return { down: error }; }
      if (error instanceof McpError) { return { refused: error.message }; }
      if (run.signal.aborted) { return { refused: 'The call was cancelled.' }; }
      return { refused: `The call didn't finish: ${messageOf(error)}` };
    } finally {
      calls.splice(calls.indexOf(run), 1);
      if (calls.length === 0) { this.#inFlight.delete(link); }
    }
  }

  /**
   * A question the server asked on a link: asked of the person of the newest call in flight on it (servers ask while
   * answering a call); declined when no call is waiting.
   */
  elicit(link: ServerLink, request: McpElicitRequest): Promise<McpElicitResult> {
    const run = this.#inFlight.get(link)?.at(-1);
    if (run === undefined) { return Promise.resolve({ action: 'decline' }); }
    return this.elicitations.ask(request, run);
  }

  /** Stop: cancel waiting questions and close every link. */
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#sweep);
    clearTimeout(this.#settle);
    this.elicitations.cancelAll();
    await Promise.all([this.#own?.close(), ...[...this.#people.values()].map((person) => person.link.close())]);
    this.#people.clear();
  }

  /** The server's resources, under `mcp://<instance>/`, read with the instance's own link. */
  resources(): ResourceProvider {
    return {
      roots: () => Promise.resolve(this.#config.resources && this.#own !== undefined ? [this.#root()] : []),
      list: (uri, cursor) => this.#listResources(uri, cursor),
      stat: async (uri) => (await this.#readResource(uri))?.stat,
      read: async (uri, want) => {
        const read = await this.#readResource(uri, want);
        if (read === undefined) { throw new Error(`No resource ${uri}.`); }
        return read;
      },
    };
  }

  #root(): ResourceRoot {
    return { uri: ResourceUri.parse(mcpRootOf(this.instance)), name: this.#config.label, description: this.#config.description ?? `The resources of ${this.#config.label}.`, index: 'on-read', ignore: [], watch: false };
  }

  async #listResources(uri: ResourceUri, cursor: string | undefined): Promise<Page<ResourceStat>> {
    const link = this.#own;
    if (link === undefined || !this.#config.resources || uri !== mcpRootOf(this.instance)) { return { items: [] }; }
    const page = await link.use((client) => client.request('resources/list', cursor === undefined ? {} : { cursor }));
    return {
      items: page.resources.map((resource): ResourceStat => ({
        uri: hubUri(this.instance, resource.uri), name: resource.title ?? resource.name, type: 'file',
        ...(resource.mimeType === undefined ? {} : { mime: resource.mimeType }), ...(resource.size === undefined ? {} : { size: resource.size }), version: '1',
      })),
      ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
    };
  }

  /** A resource read through the server: text inline (cut at `MCP_MAX_TEXT`); bytes are not carried. */
  async #readResource(uri: ResourceUri, want: readonly ReadWant[] = []): Promise<ResourceRead | undefined> {
    const link = this.#own;
    const at = serverUri(this.instance, uri);
    if (link === undefined || at === undefined) { return undefined; }
    const contents = await link.use((client) => client.readResource(at)).catch((error: unknown) => {
      if (error instanceof McpError) { return undefined; }
      throw error;
    });
    const first = contents?.[0];
    if (first === undefined) { return undefined; }
    const text = 'text' in first ? first.text : undefined;
    const max = this.#deps.settings.MCP_MAX_TEXT;
    const stat: ResourceStat = {
      uri, name: at.slice(at.lastIndexOf('/') + 1) || at, type: 'file', ...(first.mimeType === undefined ? {} : { mime: first.mimeType }),
      ...(text === undefined ? {} : { size: new TextEncoder().encode(text).byteLength }), version: String('text' in first ? first.text.length : first.blob.length),
    };
    const shown = text === undefined ? `[${first.mimeType ?? 'binary'} content: not readable as text here]` : text.length > max ? `${text.slice(0, max)}\n\n[cut at ${String(max)} characters]` : text;
    return { stat, ...(want.includes('text') ? { text: { inline: shown } } : {}) };
  }

  /** A link to the server signed by `signer`; the instance's own one reconnects in the background. */
  #link(signer: Signer, own: boolean): ServerLink {
    const settings = this.#deps.settings;
    const link: ServerLink = new ServerLink(this.#deps.dialers.dialer(this.#config.transport, signer), {
      clientInfo: { name: 'harness', version: this.#deps.version },
      connectTimeout: settings.MCP_CONNECT_TIMEOUT,
      pingEvery: own ? settings.MCP_PING_EVERY : 0,
      ...(own ? { reconnect: { min: settings.MCP_RECONNECT_MIN, max: settings.MCP_RECONNECT_MAX } } : {}),
      elicit: (request) => this.elicit(link, request),
    }, {
      connected: () => { this.#checkedAt = this.#deps.now(); this.#mirrorSoon(link, true); },
      changed: (list: McpList) => { this.#mirrorSoon(link, list !== 'resources'); if (list === 'resources') { void this.#rootsChanged(); } },
      state: (state, problem) => { this.#checkedAt = this.#deps.now(); this.#deps.log.info('mcp.link', { instance: this.instance, state, ...(problem === undefined ? {} : { problem }) }); },
    });
    return link;
  }

  /** The link a run calls through: the instance's own, or the run's connection's (made or remade as its credentials say). */
  #linkFor(run: CallingRun): ServerLink | { readonly refused: string } {
    if (this.#own !== undefined) { return this.#own; }
    if (run.connection === undefined) { return { refused: `Sign in to ${this.#config.label} on the Connections page first.` }; }
    const person = this.#personLink(run.connection);
    if (person === undefined) { return { refused: `Your connection to ${this.#config.label} has no credentials this system can use: connect again.` }; }
    person.signer.update = (update) => run.updateConnection(update);
    this.#last = person.link;
    return person.link;
  }

  #personLink(connection: Pick<RunConnection, 'id' | 'credentials'>): PersonLink | undefined {
    const credentials = readCredentials(connection.credentials);
    if (credentials === undefined) { return undefined; }
    const key = JSON.stringify(credentials);
    const known = this.#people.get(connection.id);
    if (known?.key === key) { return known; }
    void known?.link.close();
    const signer = new PersonSigner(credentials, this.#oauth);
    const link = this.#link(signer, false);
    signer.link = link;
    const person = { link, key, signer };
    this.#people.set(connection.id, person);
    return person;
  }

  /** Close people's links nobody used for a while (one with a call in flight stays). */
  async #closeIdle(): Promise<void> {
    const before = this.#deps.now() - this.#deps.settings.MCP_IDLE_CLOSE;
    for (const [id, person] of this.#people) {
      if (person.link.lastUsed < before && !this.#inFlight.has(person.link)) {
        this.#people.delete(id);
        await person.link.close();
      }
    }
  }

  /** Mirror after the lists settle (a burst of notices is one mirror); `lists` false (only resources changed) skips it. */
  #mirrorSoon(link: ServerLink, lists: boolean): void {
    if (!lists || this.#closed) { return; }
    clearTimeout(this.#settle);
    this.#settle = setTimeout(() => { void this.#mirror(link).catch((error: unknown) => { this.#deps.log.warn('mcp.mirror-failed', { instance: this.instance, problem: messageOf(error) }); }); }, this.#deps.settings.MCP_MIRROR_SETTLE);
    this.#settle.unref();
  }

  async #rootsChanged(): Promise<void> {
    await this.#deps.hub.patch({ roots: true }).catch((error: unknown) => { this.#deps.log.warn('mcp.roots-failed', { instance: this.instance, problem: messageOf(error) }); });
  }

  /** List and mirror; one at a time (a mirror asked for meanwhile runs once after). */
  async #mirror(link: ServerLink): Promise<void> {
    if (this.#mirroring !== undefined) {
      this.#again = true;
      await this.#mirroring;
      return;
    }
    this.#mirroring = this.#mirrorOnce(link).finally(() => { this.#mirroring = undefined; });
    await this.#mirroring;
    if (this.#again) {
      this.#again = false;
      await this.#mirror(link);
    }
  }

  async #mirrorOnce(link: ServerLink): Promise<void> {
    const config = this.#config;
    const { tools, prompts, resources } = await link.use(async (client) => {
      const offers = client.server.capabilities;
      const listedTools: McpTool[] = offers.tools === undefined ? [] : await client.listTools();
      const listedPrompts = offers.prompts === undefined || !config.prompts ? [] : await this.#prompts(client);
      const listedResources = offers.resources === undefined || !config.resources ? 0 : (await client.listResources()).length;
      return { tools: listedTools, prompts: listedPrompts, resources: listedResources };
    });
    const mirrored = mirrorTools(this.instance, config, tools);
    const fns = this.#sentFns.changed(mirrored.fns);
    const context = this.#sentPrompts.changed(prompts);
    const roots = !this.#mirrored && resources > 0;
    this.#counts = { tools: mirrored.fns.length, prompts: prompts.length, resources, leftOut: mirrored.leftOut, degraded: [...mirrored.degraded] };
    this.#checkedAt = this.#deps.now();
    this.#mirrored = true;
    if (fns.length === 0 && context.length === 0 && !roots) { return; }
    const report = await this.#deps.hub.patch({ upsert: { ...(fns.length === 0 ? {} : { fns }), ...(context.length === 0 ? {} : { context }) }, ...(roots ? { roots: true } : {}) });
    if (report.refused.length > 0) {
      this.#deps.log.warn('mcp.mirror-refused', { instance: this.instance, refused: report.refused.length });
      this.#sentFns.clear();
      this.#sentPrompts.clear();
    }
    this.#deps.log.info('mcp.mirrored', { instance: this.instance, tools: fns.length, prompts: context.length });
  }

  /** The server's prompts as context, each filled with `{{arg}}` placeholders (its description when it can't be). */
  async #prompts(client: McpClient): Promise<ReturnType<typeof promptDecl>[]> {
    const listed = await client.listPrompts();
    return Promise.all(listed.map(async (prompt) => {
      const text = await client.getPrompt(prompt.name, placeholders(prompt)).then(promptText, () => prompt.description ?? prompt.name);
      return promptDecl(this.instance, this.#config.label, prompt, text.slice(0, this.#deps.settings.MCP_MAX_TEXT));
    }));
  }
}

/** The config value read with its defaults; `undefined` when it isn't a valid MCP server config. */
export function readConfig(value: unknown): McpServerConfig | undefined {
  const read = McpServerConfig.safeParse(value);
  return read.success ? read.data : undefined;
}

/** A failure's words for a run that could not reach the server, with the class the hub retries by. */
export function downFailure(down: LinkDown): { readonly cls: 'retry' | 'caller'; readonly code: string } {
  return down.state === 'needs-auth' ? { cls: 'caller', code: 'reconnect' } : { cls: 'retry', code: down.state };
}

