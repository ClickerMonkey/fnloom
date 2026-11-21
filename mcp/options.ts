/** The test MCP server's command line: transport, sign-in, and where it listens. */
import { AUTH_MODES, DEFAULT_HEADERS, DEFAULT_TOKEN, type AuthSettings } from './auth.ts';

/** Where it listens unless `--host` says: this machine only, as its test tokens are fixed. */
export const DEFAULT_HOST = '127.0.0.1';

const TRANSPORTS = ['http', 'sse', 'command'] as const;
type Transport = (typeof TRANSPORTS)[number];

export interface Options {
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
export function parseOptions(argv: readonly string[]): Options {
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
    host: one('--host') ?? DEFAULT_HOST,
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
