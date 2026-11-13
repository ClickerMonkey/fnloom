/**
 * One live link to an MCP server with one set of credentials: `McpClient` over a dialed transport. It connects when
 * first used, notices the server going away (a call failing below the protocol, the process exiting, a ping going
 * unanswered) and reconnects with backoff when it is the instance's own link; a person's link reconnects when next
 * used. It hears the server's `list_changed` notices and says where it is (`McpServerState`).
 */
import { McpClient, McpError, McpHttpError, McpToolError, type McpElicitRequest, type McpElicitResult } from '@ayepi/mcp';
import { messageOf, type McpServerState } from '@harness/core';
import type { Dialer, OpenedTransport } from './dial.ts';

/** The lists a server says changed. */
export type McpList = 'tools' | 'prompts' | 'resources';

const LIST_NOTICES: Readonly<Record<string, McpList>> = {
  'notifications/tools/list_changed': 'tools',
  'notifications/prompts/list_changed': 'prompts',
  'notifications/resources/list_changed': 'resources',
};

/** How a link connects and keeps connected. */
export interface LinkOptions {
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly connectTimeout: number;
  /** Reconnect in the background with this backoff (the instance's own link); absent: only when next used. */
  readonly reconnect?: { readonly min: number; readonly max: number };
  /** Ping a connected server this often to notice it went away (0: never). */
  readonly pingEvery: number;
  /** Answer a question the server asks (an elicitation). */
  readonly elicit: (request: McpElicitRequest, signal: AbortSignal) => Promise<McpElicitResult>;
}

/** What a link tells its owner. */
export interface LinkEvents {
  /** Connected (again): the owner mirrors the lists. */
  connected?(client: McpClient): void;
  /** The server said a list changed. */
  changed?(list: McpList): void;
  /** Where the link is now, and the problem in words when it isn't connected. */
  state?(state: McpServerState, problem: string | undefined): void;
}

/** The server can't be reached now (or refused the credentials): the words say why. */
export class LinkDown extends Error {
  readonly state: McpServerState;

  constructor(state: McpServerState, message: string) {
    super(message);
    this.name = 'LinkDown';
    this.state = state;
  }
}

/** Whether an error came from the server speaking MCP (an answer), rather than from the link failing. */
function isAnswer(error: unknown): boolean {
  return error instanceof McpError || error instanceof McpToolError;
}

/** One live link to a server. */
export class ServerLink {
  readonly #dialer: Dialer;
  readonly #options: LinkOptions;
  readonly #events: LinkEvents;
  #client: McpClient | undefined;
  #opened: OpenedTransport | undefined;
  #connecting: Promise<McpClient> | undefined;
  #state: McpServerState = 'connecting';
  #problem: string | undefined;
  #refused = false;
  #closed = false;
  #delay = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;
  #lastUsed = Date.now();

  constructor(dialer: Dialer, options: LinkOptions, events: LinkEvents = {}) {
    this.#dialer = dialer;
    this.#options = options;
    this.#events = events;
  }

  get state(): McpServerState { return this.#state; }
  get problem(): string | undefined { return this.#problem; }
  /** What the server said about itself when it last connected. */
  get server(): McpClient['server'] | undefined { return this.#client?.server; }
  /** When a call last used the link. */
  get lastUsed(): number { return this.#lastUsed; }

  /** The credentials were refused and could not be refreshed: the link waits for someone to sign in. */
  credentialsRefused(): void {
    this.#refused = true;
  }

  /** Connect now and keep connected (the instance's own link). */
  start(): void {
    void this.client().catch(() => undefined);
  }

  /** The connected client, connecting first when needed; `LinkDown` when the server can't be reached. */
  client(): Promise<McpClient> {
    if (this.#closed) { return Promise.reject(new LinkDown('failed', 'The link to the server is closed.')); }
    if (this.#client !== undefined) { return Promise.resolve(this.#client); }
    this.#connecting ??= this.#connect().finally(() => { this.#connecting = undefined; });
    return this.#connecting;
  }

  /**
   * Work with the connected client. A failure below the protocol (the server went away) drops the client, reconnects
   * as the link does and throws `LinkDown`; the server's own answers (an error, a failed tool) pass through.
   */
  async use<T>(work: (client: McpClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.#lastUsed = Date.now();
    const client = await this.client();
    try {
      return await work(client);
    } catch (error) {
      if (isAnswer(error) || signal?.aborted === true) { throw error; }
      throw this.#down(client, error);
    }
  }

  /** Stop: close the transport and never reconnect. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#retry);
    clearInterval(this.#ping);
    const opened = this.#opened;
    this.#client = undefined;
    this.#opened = undefined;
    await opened?.close().catch(() => undefined);
  }

  async #connect(): Promise<McpClient> {
    this.#refused = false;
    this.#set('connecting', undefined);
    let opened: OpenedTransport | undefined;
    try {
      opened = await this.#dialer.open();
      const client = await McpClient.connect(opened.transport, {
        clientInfo: this.#options.clientInfo, signal: AbortSignal.timeout(this.#options.connectTimeout), handlers: { elicit: this.#options.elicit },
      });
      if (this.#closed) {
        await opened.close();
        throw new LinkDown('failed', 'The link to the server is closed.');
      }
      this.#client = client;
      this.#opened = opened;
      this.#delay = 0;
      client.onNotification((notice) => {
        const list = LIST_NOTICES[notice.method];
        if (list !== undefined) { this.#events.changed?.(list); }
      });
      void opened.ended.then((why) => { this.#down(client, why); });
      this.#watch(client);
      this.#set('connected', undefined);
      this.#events.connected?.(client);
      return client;
    } catch (error) {
      await opened?.close().catch(() => undefined);
      const down = error instanceof LinkDown ? error : this.#failure(error);
      this.#set(down.state, down.message);
      this.#schedule();
      throw down;
    }
  }

  /** Why a connect or call failed, as a state: refused credentials need a sign-in. */
  #failure(error: unknown): LinkDown {
    if (this.#refused || (error instanceof McpHttpError && (error.status === 401 || error.status === 403))) { return new LinkDown('needs-auth', 'The server refused the credentials: sign in to it again.'); }
    return new LinkDown('unreachable', `The server can't be reached: ${typeof error === 'string' ? error : messageOf(error)}`);
  }

  /** The client went away: forget it, say so and reconnect as this link does. */
  #down(client: McpClient, why: unknown): LinkDown {
    const down = this.#failure(why);
    if (this.#client !== client) { return down; }
    clearInterval(this.#ping);
    const opened = this.#opened;
    this.#client = undefined;
    this.#opened = undefined;
    void opened?.close().catch(() => undefined);
    if (!this.#closed) {
      this.#set(down.state, down.message);
      this.#schedule();
    }
    return down;
  }

  /** Ping the server now and then; an unanswered ping means it went away. */
  #watch(client: McpClient): void {
    clearInterval(this.#ping);
    if (this.#options.pingEvery <= 0) { return; }
    this.#ping = setInterval(() => {
      client.ping({ signal: AbortSignal.timeout(this.#options.connectTimeout) }).catch((error: unknown) => {
        if (!isAnswer(error)) { this.#down(client, error); }
      });
    }, this.#options.pingEvery);
    this.#ping.unref();
  }

  /** Reconnect after the next backoff step (only a background link, and never while waiting for a sign-in). */
  #schedule(): void {
    const backoff = this.#options.reconnect;
    if (backoff === undefined || this.#closed || this.#state === 'needs-auth') { return; }
    clearTimeout(this.#retry);
    this.#delay = Math.min(backoff.max, this.#delay === 0 ? backoff.min : this.#delay * 2);
    this.#retry = setTimeout(() => { this.start(); }, this.#delay);
    this.#retry.unref();
  }

  #set(state: McpServerState, problem: string | undefined): void {
    if (this.#state === state && this.#problem === problem) { return; }
    this.#state = state;
    this.#problem = problem;
    this.#events.state?.(state, problem);
  }
}
