/**
 * The MCP system's process, one per MCP server instance: real transports (a child process for stdio, signed `fetch`
 * for HTTP), served to the hub. Once serving, the lifecycle starts the instance, which connects and mirrors the
 * server's lists through the running system's runtime patches.
 */
import type { ImportReport } from '@harness/core';
import { loggedHost, serve, type RunningSystem, type SystemPatch } from '@harness/sdk/server';
import { mcp } from '../shared/index.ts';
import { NodeDialers } from './dial.ts';
import { mcpEnv } from './env.ts';
import { createMcpImpl } from './impl.ts';

const settings = mcpEnv.parse();
const { host, log } = loggedHost(mcp.name);
const VERSION = '0.1.0';

// the lifecycle starts the instance (and its first mirror) before `serve()` returns, so patches wait for it
let resolveRunning: (system: RunningSystem<typeof mcp.name>) => void = () => undefined;
const serving = new Promise<RunningSystem<typeof mcp.name>>((resolve) => { resolveRunning = resolve; });
const server = createMcpImpl({
  settings,
  dialers: new NodeDialers(),
  patch: async (change: SystemPatch): Promise<ImportReport> => (await serving).patch(change),
  version: VERSION,
  now: () => Date.now(),
  fetch: globalThis.fetch.bind(globalThis),
});

log.info('mcp.serving', { hub: settings.HARNESS_HUB, instance: settings.HARNESS_INSTANCE });
const running = await serve(mcp, server.impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
resolveRunning(running);
running.onStatus((status) => { log.info('mcp.status', { status }); });

const stop = () => {
  running.stop().then(() => server.close()).finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
