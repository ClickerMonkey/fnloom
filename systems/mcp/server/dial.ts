/**
 * Reaching an MCP server: a `Dialer` opens a fresh client transport each time it is asked (a reconnect dials again),
 * signed with a `Signer` (the instance's shared credentials, or one person's connection). Over HTTP every request
 * carries the signer's headers, and a `401` asks the signer to refresh (an OAuth token) and is tried once more.
 */
import { McpHttpClientTransport, McpSseClientTransport, type McpClientTransport } from '@ayepi/mcp';
import { spawnStdioClient } from '@ayepi/mcp/node';
import type { McpTransport } from '@harness/core';

/** A transport to a server, and how to know it went away and to let it go. */
export interface OpenedTransport {
  readonly transport: McpClientTransport;
  /** Resolves with why, once the transport is gone for good (the server process exited). */
  readonly ended: Promise<string>;
  close(): Promise<void>;
}

/** Opens transports to one server. */
export interface Dialer {
  open(): Promise<OpenedTransport>;
}

/** The credentials one link to a server sends, and refreshing them when the server refuses them. */
export interface Signer {
  /** The headers every request carries (`Authorization`, an API key header); `{}` for none. */
  headers(): Promise<Record<string, string>>;
  /** The server refused the credentials: refresh them if that can be done (true: try again). */
  refresh(): Promise<boolean>;
  /** The server refused them and they could not be refreshed: someone has to sign in. */
  refused(): void;
}

/** A signer with nothing to send. */
export const UNSIGNED: Signer = { headers: () => Promise.resolve({}), refresh: () => Promise.resolve(false), refused: () => undefined };

/** Opens transports to a server by its config. */
export interface DialerFactory {
  dialer(transport: McpTransport, signer: Signer): Dialer;
}

/** A `fetch` that signs every request and, on a `401`, refreshes the credentials once and tries again. */
export function signedFetch(base: typeof fetch, signer: Signer): typeof fetch {
  return async (input, init) => {
    const send = async (): Promise<Response> => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(await signer.headers())) { headers.set(name, value); }
      return base(input, { ...init, headers });
    };
    const first = await send();
    if (first.status !== 401) { return first; }
    if (!(await signer.refresh())) {
      signer.refused();
      return first;
    }
    const again = await send();
    if (again.status === 401) { signer.refused(); }
    return again;
  };
}

/** What a transport that never ends on its own waits on. */
const NEVER = new Promise<string>(() => undefined);

/** Opens real transports: a child process for stdio, signed `fetch` for Streamable HTTP and HTTP + SSE. */
export class NodeDialers implements DialerFactory {
  readonly #fetch: typeof fetch;

  constructor(base: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.#fetch = base;
  }

  dialer(transport: McpTransport, signer: Signer): Dialer {
    switch (transport.type) {
      case 'stdio': return { open: () => Promise.resolve(openStdio(transport)) };
      case 'http': return { open: () => Promise.resolve(remote(new McpHttpClientTransport(transport.url, { fetch: signedFetch(this.#fetch, signer) }))) };
      case 'sse': return { open: () => Promise.resolve(remote(new McpSseClientTransport(transport.url, { fetch: signedFetch(this.#fetch, signer) }))) };
    }
  }
}

/** A remote server's transport: it ends only when a request fails. */
function remote(transport: McpClientTransport): OpenedTransport {
  return { transport, ended: NEVER, close: () => transport.close() };
}

/** A server process on this machine, spoken to over its stdin and stdout; its last stderr lines say why it exited. */
function openStdio(config: Extract<McpTransport, { type: 'stdio' }>): OpenedTransport {
  const lines: string[] = [];
  const spawned = spawnStdioClient(config.command, config.args, {
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    stderr: (line) => { lines.push(line); if (lines.length > STDERR_LINES) { lines.shift(); } },
  });
  const ended = spawned.exited.then((code) => {
    const last = lines.at(-1)?.trim() ?? '';
    return `${config.command} exited (${code === null ? 'stopped' : `code ${String(code)}`})${last === '' ? '' : `: ${last}`}`;
  });
  return { transport: spawned.transport, ended, close: () => spawned.transport.close() };
}

/** How many of a server process's last stderr lines are kept to say why it exited. */
const STDERR_LINES = 20;
