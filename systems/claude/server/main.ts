/**
 * The claude system's process, one per machine: Claude Code through the Agent SDK, served to the hub. Live sessions
 * are this process's; on a stop they are closed and stay resumable from Claude's store.
 */
import { loggedHost, placeFolders, serve, type RunningSystem } from '@harness/sdk/server';
import { claude } from '../shared/index.ts';
import { AgentSdkDriver } from './agent-sdk.ts';
import { claudeEnv, dialogKinds } from './env.ts';
import { createClaudeImpl } from './impl.ts';

const settings = claudeEnv.parse();
placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const { host, log } = loggedHost(claude.name);

// imported skills are declared once the system is serving
let resolveRunning: (system: RunningSystem<typeof claude.name>) => void = () => undefined;
const serving = new Promise<RunningSystem<typeof claude.name>>((resolve) => { resolveRunning = resolve; });
const server = createClaudeImpl({
  settings,
  driver: new AgentSdkDriver({ executable: settings.CLAUDE_EXECUTABLE, dialogKinds: dialogKinds(settings), textMax: settings.CLAUDE_TRANSCRIPT_TEXT_MAX }),
  runtime: () => serving,
});

log.info('claude.serving', { hub: settings.HARNESS_HUB, instance: settings.HARNESS_INSTANCE });
const running = await serve(claude, server.impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
resolveRunning(running);
running.onStatus((status) => { log.info('claude.status', { status }); });
await running.ready();

const stop = () => {
  server.close().then(() => running.stop()).finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
