/**
 * Build 9: MCP servers as the admin pages show them (each an instance of the bundled `mcp` system): the form's draft of
 * an `McpServerConfig` and the config it sends, each transport and approval policy in words, a server's state as a
 * badge, its prompts' names, and the one-line summary of a server on the list. Pure, so it is tested alone.
 */
import {
  MCP_CONFIG_SECRETS, MCP_SYSTEM, McpServerConfig, SystemName, mcpToolFnName, type ContextRecord, type InstanceName, type Json, type JsonObject, type McpApproval, type McpServerState,
  type McpServerStatus, type McpTransport, type QualifiedName, type SystemStatus,
} from '@harness/core';
import { SYSTEM_STATUS_LOOK, type StatusLook } from './systems.ts';
import {
  authCandidate, authDraft, checkConfig, keptPaths, numberOr, recordOf, rowsOf, textOr, withoutKept, type AuthDraft, type CheckedConfig, type PairRow,
} from './remote-config.ts';

/** The `mcp` system's name. */
export const MCP = SystemName.parse(MCP_SYSTEM);

export type McpTransportType = McpTransport['type'];

/** Each transport in words. */
export const TRANSPORT_WORDS = {
  http: { label: 'HTTP', about: 'Streamable HTTP: a URL the server answers on (MCP 2025-03-26 and later).' },
  sse: { label: 'SSE', about: 'The older HTTP + SSE transport (MCP 2024-11-05).' },
  stdio: { label: 'Command', about: 'A program the hub starts on its own machine; credentials go in its environment.' },
} as const satisfies Record<McpTransportType, { readonly label: string; readonly about: string }>;

/** Each approval policy in words. */
export const APPROVAL_WORDS = {
  writes: { label: 'Writes', about: 'Calls wait for approval unless a trusted server marks the tool read-only.' },
  always: { label: 'Always', about: 'Every call waits for approval.' },
  never: { label: 'Never', about: 'No call waits (policies still apply).' },
} as const satisfies Record<McpApproval, { readonly label: string; readonly about: string }>;

/** A server's state as a badge. */
export const MCP_STATE_LOOK = {
  connecting: { tone: 'accent', word: 'Connecting', live: true },
  connected: { tone: 'ok', word: 'Connected', live: false },
  'needs-auth': { tone: 'warn', word: 'Needs sign-in', live: false },
  unreachable: { tone: 'danger', word: 'Unreachable', live: false },
  failed: { tone: 'danger', word: 'Failed', live: false },
} as const satisfies Record<McpServerState, StatusLook>;

/** An MCP server's form as the inputs hold it. Numbers are text as typed; the timeout is in seconds. */
export interface McpServerDraft {
  readonly label: string;
  readonly description: string;
  readonly transport: McpTransportType;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly PairRow[];
  /** The hub keeps the environment values; replacing them clears this. */
  readonly envKept: boolean;
  readonly cwd: string;
  readonly url: string;
  readonly auth: AuthDraft;
  readonly trusted: boolean;
  readonly approval: McpApproval;
  readonly prompts: boolean;
  readonly resources: boolean;
  readonly maxTools: string;
  readonly timeout: string;
}

/** A new server's settings: the schema's own defaults. */
const DEFAULTS = McpServerConfig.pick({ trusted: true, approval: true, prompts: true, resources: true, maxTools: true, timeout: true }).parse({});

/** The draft of a saved server config as the hub sent it (kept secrets as `SECRET_KEPT`), or a new server's. */
export function mcpServerDraft(value?: Json): McpServerDraft {
  const kept = keptPaths(value, MCP_CONFIG_SECRETS);
  const config = readMcpServer(value);
  const t = config?.transport;
  const options = config ?? DEFAULTS;
  return {
    label: config?.label ?? '',
    description: config?.description ?? '',
    transport: t?.type ?? 'http',
    command: t?.type === 'stdio' ? t.command : '',
    args: t?.type === 'stdio' ? t.args : [],
    env: t?.type === 'stdio' ? rowsOf(t.env) : [],
    envKept: kept.has('transport.env'),
    cwd: t?.type === 'stdio' ? t.cwd ?? '' : '',
    url: t !== undefined && t.type !== 'stdio' ? t.url : '',
    auth: authDraft(config?.auth, kept),
    trusted: options.trusted,
    approval: options.approval,
    prompts: options.prompts,
    resources: options.resources,
    maxTools: String(options.maxTools),
    timeout: String(options.timeout / 1000),
  };
}

/** The transport the draft describes (kept environment values left out). */
function transportOf(draft: McpServerDraft): JsonObject {
  if (draft.transport !== 'stdio') { return { type: draft.transport, url: draft.url.trim() }; }
  const env = draft.envKept ? undefined : recordOf(draft.env);
  const cwd = textOr(draft.cwd);
  return { type: 'stdio', command: draft.command.trim(), args: [...draft.args], ...(env === undefined ? {} : { env }), ...(cwd === undefined ? {} : { cwd }) };
}

/** The config a draft sends, checked with `McpServerConfig`; kept secrets go back as `SECRET_KEPT`. */
export function mcpServerConfig(draft: McpServerDraft): CheckedConfig {
  // a command takes its credentials in its environment, so it signs in with nothing
  const auth = draft.transport === 'stdio' ? { auth: { kind: 'none' }, kept: [] } : authCandidate(draft.auth);
  const description = textOr(draft.description);
  const maxTools = numberOr(draft.maxTools);
  const timeout = numberOr(draft.timeout, 1000);
  const candidate: JsonObject = {
    label: draft.label.trim(),
    ...(description === undefined ? {} : { description }),
    transport: transportOf(draft),
    auth: auth.auth,
    trusted: draft.trusted,
    approval: draft.approval,
    prompts: draft.prompts,
    resources: draft.resources,
    ...(maxTools === undefined ? {} : { maxTools }),
    ...(timeout === undefined ? {} : { timeout }),
  };
  const kept = [...auth.kept, ...(draft.transport === 'stdio' && draft.envKept ? ['transport.env'] : [])];
  return checkConfig(McpServerConfig, candidate, kept);
}

/** Where a saved server is, in a few words: its URL, or its command line. */
export function transportText(config: McpServerConfig): string {
  const t = config.transport;
  return t.type === 'stdio' ? [t.command, ...t.args].join(' ') : t.url;
}

/** A saved server config as the hub sent it, read (kept secrets left out), or undefined when it isn't one. */
export function readMcpServer(value: Json | undefined): McpServerConfig | undefined {
  const read = McpServerConfig.safeParse(withoutKept(value, MCP_CONFIG_SECRETS));
  return read.success ? read.data : undefined;
}

/** A server's counts in words: tools, prompts and resources it mirrors. */
export function countsText(status: Pick<McpServerStatus, 'tools' | 'prompts' | 'resources'>): string {
  const count = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
  return [count(status.tools, 'tool'), count(status.prompts, 'prompt'), count(status.resources, 'resource')].join(' · ');
}

/**
 * The start of the local name of everything a server mirrors (`linear_`): its tools are `<instance>_<tool>`, and its
 * prompts are named the same way.
 */
export function mirrorPrefix(instance: InstanceName): string {
  return mcpToolFnName(instance, 'x').slice(0, -1);
}

/** The context items among these that are a server's prompts (by the prefix of their local name). */
export function promptsOf(items: readonly ContextRecord[], system: string, instance: InstanceName): ContextRecord[] {
  const start = `${system}/${mirrorPrefix(instance)}`;
  return items.filter((item) => item.name.startsWith(start));
}

/** A prompt's `/command`, as people type it in the chat. */
export function commandText(item: ContextRecord): string | undefined {
  return item.decl.command === undefined ? undefined : `/${item.decl.command.name}`;
}

/** Whether a tool's fn is one the server's schema mapped only loosely (named in the status's `degraded`). */
export function isDegraded(status: McpServerStatus | undefined, instance: InstanceName, fn: QualifiedName): boolean {
  return status?.degraded.some((tool) => fn.endsWith(`/${mcpToolFnName(instance, tool)}`)) === true;
}

/** A server's status as read: the status, or why it could not be read. */
export type StatusRead = { readonly status: McpServerStatus } | { readonly problem: string };

/**
 * How a server looks on the list: its instance's own status while it is not connected to the hub (offline, needing
 * config), else the state it reports with its server, else that the status could not be read.
 */
export function serverLook(instance: SystemStatus, read: StatusRead | undefined): StatusLook {
  if (instance !== 'connected') { return SYSTEM_STATUS_LOOK[instance]; }
  if (read === undefined) { return MCP_STATE_LOOK.connecting; }
  return 'status' in read ? MCP_STATE_LOOK[read.status.state] : { tone: 'warn', word: 'Status unknown', live: false };
}
