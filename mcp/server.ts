/**
 * A test MCP server for the harness integration. It serves the same tools, resources and prompts (`fixtures.ts`)
 * over any transport and with any sign-in method, so each combination can be checked from the harness.
 *
 *   npx tsx mcp/server.ts --transport http    --auth oauth
 *   npx tsx mcp/server.ts --transport sse     --auth token --token my-token
 *   npx tsx mcp/server.ts --transport command --auth headers --header X-Api-Key=abc
 *
 * Transports
 * - `http`: Streamable HTTP at `/mcp` (the library's `mcpHttp`).
 * - `sse`: the HTTP + SSE transport at `/sse` and `/messages`.
 * - `command`: stdio, newline-delimited JSON on stdin and stdout. Log lines go to stderr only.
 *
 * Sign-in (`--auth`)
 * - `none`: open.
 * - `token`: `Authorization: Bearer <--token>`. Over `command`, the process reads `MCP_TEST_TOKEN` and must match.
 * - `headers`: each `--header NAME=VALUE` (default `X-Api-Key=test-key`) must be sent. Over `command`, the process
 *   reads each as the env var `MCP_HEADER_<NAME>` (upper case, `-` becomes `_`).
 * - `oauth`: a built-in authorization server (`oauth.ts`). HTTP and SSE only: stdio servers take credentials from
 *   their environment, as the MCP spec describes, so `command` rejects `oauth`.
 *
 * Other options: `--port` (default 4400), `--host` (default 0.0.0.0), `--oauth-ttl` seconds of access token life
 * (default 3600).
 */
import http from 'node:http';
import { createInterface } from 'node:readline';
import { createRequestListener } from '@ayepi/node';
import {
  mcpHttp, mcpSourceServer, rpcError, serveStdio,
  type JsonRpcResponse, type McpAuthInfo, type McpAuthorizer, type McpServer,
} from '@ayepi/mcp';
import { AUTH_MODES, DEFAULT_HEADERS, DEFAULT_TOKEN, staticAuthorizer, type AuthMode, type AuthSettings } from './auth.ts';
import { SERVER_INFO, SOURCES } from './fixtures.ts';
import { TestOAuthServer } from './oauth.ts';
import { LegacySseTransport } from './sse.ts';

const TRANSPORTS = ['http', 'sse', 'command'] as const;
type Transport = (typeof TRANSPORTS)[number];

interface Options {
  readonly transport: Transport;
  readonly auth: AuthSettings;
  readonly port: number;
  readonly host: string;
  readonly oauthTtl: number;
}

function usage(message?: string): never {
  if (message !== undefined) { console.error(`error: ${message}\n`); }
  console.error([
    'usage: npx tsx mcp/server.ts [--transport http|sse|command] [--auth none|token|headers|oauth]',
    '                             [--token T] [--header NAME=VALUE]... [--port N] [--host H] [--oauth-ttl S]',
  ].join('\n'));
  process.exit(2);
}

/** Reads the command line; an unknown or malformed option is a usage error. */
function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (!flag.startsWith('--')) { usage(`unexpected argument ${flag}`); }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) { usage(`${flag} needs a value`); }
    values.set(flag, [...(values.get(flag) ?? []), value]);
    i += 1;
  }
  const known = new Set(['--transport', '--auth', '--token', '--header', '--port', '--host', '--oauth-ttl']);
  for (const flag of values.keys()) {
    if (!known.has(flag)) { usage(`unknown option ${flag}`); }
  }
  const one = (flag: string): string | undefined => values.get(flag)?.at(-1);

  const transport = one('--transport') ?? 'http';
  if (!isOneOf(TRANSPORTS, transport)) { usage(`--transport must be one of ${TRANSPORTS.join(', ')}`); }
  const mode = one('--auth') ?? 'none';
  if (!isOneOf(AUTH_MODES, mode)) { usage(`--auth must be one of ${AUTH_MODES.join(', ')}`); }

  const headers = parseHeaders(values.get('--header') ?? []);
  const port = integer(one('--port') ?? '4400', '--port');
  const oauthTtl = integer(one('--oauth-ttl') ?? '3600', '--oauth-ttl');
  return {
    transport,
    auth: { mode, token: one('--token') ?? DEFAULT_TOKEN, headers: Object.keys(headers).length > 0 ? headers : DEFAULT_HEADERS },
    port,
    host: one('--host') ?? '0.0.0.0',
    oauthTtl,
  };
}

function isOneOf<const T extends readonly string[]>(allowed: T, value: string): value is T[number] {
  return (allowed as readonly string[]).includes(value);
}

function integer(text: string, flag: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) { usage(`${flag} must be a whole number`); }
  return value;
}

function parseHeaders(pairs: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) { usage(`--header takes NAME=VALUE, got ${pair}`); }
    headers[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return headers;
}

/** The environment variable a `command` server reads a header's expected value from. */
export function headerEnvName(header: string): string {
  return `MCP_HEADER_${header.toUpperCase().replace(/-/g, '_')}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });
}

/** Serves `http` or `sse` on a node server. */
function serveWeb(options: Options): void {
  const endpoint = options.transport === 'sse' ? '/sse' : '/mcp';
  const oauth = options.auth.mode === 'oauth' ? new TestOAuthServer(endpoint, options.oauthTtl) : undefined;
  const authorizer: McpAuthorizer | undefined = oauth ?? staticAuthorizer(options.auth);
  const server = mcpSourceServer(SOURCES, SERVER_INFO);
  const streamable = options.transport === 'http' ? mcpHttp(server, authorizer === undefined ? {} : { authorize: authorizer }) : undefined;
  const legacy = options.transport === 'sse' ? new LegacySseTransport(server, authorizer) : undefined;

  const handler = async (request: Request): Promise<Response> => {
    const own = await oauth?.route(request);
    if (own !== undefined) { return own; }
    const { pathname } = new URL(request.url);
    if (pathname === '/') {
      return json({ server: SERVER_INFO.serverInfo, transport: options.transport, auth: options.auth.mode, endpoint });
    }
    if (streamable !== undefined && pathname === '/mcp') { return streamable.fetch(request); }
    const sse = await legacy?.route(request);
    return sse ?? json({ error: 'not found', endpoint }, 404);
  };

  const listener = http.createServer(createRequestListener({ fetch: handler }));
  listener.listen(options.port, options.host, () => {
    const base = `http://localhost:${options.port}`;
    console.log(`harness test MCP server: ${options.transport} · auth ${describeAuth(options.auth)}`);
    console.log(`  listening on ${options.host}:${options.port}`);
    console.log(`  MCP endpoint: ${base}${endpoint}`);
    if (oauth !== undefined) {
      console.log(`  OAuth metadata: ${base}/.well-known/oauth-protected-resource`);
      console.log(`  register/authorize/token: ${base}/register, ${base}/authorize, ${base}/token`);
    }
    if (options.auth.mode === 'token') { console.log(`  token: ${options.auth.token}`); }
    if (options.auth.mode === 'headers') {
      for (const [name, value] of Object.entries(options.auth.headers)) { console.log(`  header: ${name}: ${value}`); }
    }
  });
  const stop = (): void => {
    legacy?.close();
    streamable?.close();
    server.close();
    listener.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function describeAuth(auth: AuthSettings): string {
  return auth.mode;
}

/**
 * Serves `command`: stdio. The sign-in is read from the environment at start; a process whose environment does not
 * match answers every request with a -32001 error, the way a refused HTTP request is answered.
 */
async function serveCommand(options: Options): Promise<void> {
  if (options.auth.mode === 'oauth') {
    console.error('error: --auth oauth needs --transport http or sse (stdio takes credentials from its environment)');
    process.exit(2);
  }
  const denial = environmentDenial(options.auth);
  const subject = options.auth.mode === 'none' ? undefined : 'env';
  const server = mcpSourceServer(SOURCES, SERVER_INFO);
  const gated: McpServer = {
    tools: () => server.tools(),
    handle: async (message: unknown) => {
      if (denial !== undefined) { return refuse(message, denial); }
      const auth: McpAuthInfo | undefined = subject === undefined ? undefined : { subject, scopes: ['mcp'] };
      return server.handle(message, { auth });
    },
    onNotification: (listener) => server.onNotification(listener),
    endSession: (session) => { server.endSession(session); },
    close: () => { server.close(); },
  };
  console.error(`harness test MCP server: command (stdio) · auth ${describeAuth(options.auth)}${denial === undefined ? '' : ` · refusing: ${denial}`}`);
  await serveStdio(gated, {
    input: createInterface({ input: process.stdin, crlfDelay: Infinity }),
    output: { write: (line) => { process.stdout.write(`${line}\n`); } },
  });
}

/** The reason the environment fails the sign-in, or `undefined` when it passes (or none is required). */
function environmentDenial(auth: AuthSettings): string | undefined {
  if (auth.mode === 'token') {
    return process.env.MCP_TEST_TOKEN === auth.token ? undefined : 'MCP_TEST_TOKEN is missing or not the expected token';
  }
  if (auth.mode === 'headers') {
    const bad = Object.entries(auth.headers)
      .filter(([name, value]) => process.env[headerEnvName(name)] !== value)
      .map(([name]) => headerEnvName(name));
    return bad.length === 0 ? undefined : `missing or wrong env: ${bad.join(', ')}`;
  }
  return undefined;
}

/** A refused request gets a JSON-RPC error with its id; a notification gets nothing. */
function refuse(message: unknown, reason: string): JsonRpcResponse | null {
  const id = typeof message === 'object' && message !== null && 'id' in message ? (message as { id: string | number | null }).id : undefined;
  return id === undefined ? null : rpcError(id, -32001, `unauthorized: ${reason}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.transport === 'command') {
    await serveCommand(options);
  } else {
    serveWeb(options);
  }
}

await main();
