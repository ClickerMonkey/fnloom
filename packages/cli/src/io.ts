/** The io the `harness` binary runs commands over: the console, the disk, Vite, a hub over HTTP, and stdin. */
import { pathToFileURL } from 'node:url';
import type { CliIo } from './command.ts';
import { ViteBuilder, VitestRunner } from '@harness/build';
import { scrubbedEnv } from '@harness/sdk/server';
import { linesOf } from './commands/mcp.ts';
import { NodeFiles } from './files.ts';
import { cliSettings, connectHub, hubTarget, withSavedAdmin } from './hub.ts';
import { dataFolder, readAdminFile, START_SCRIPT, type StartScript } from './local.ts';

/** The process's io: lines to stdout, warnings to stderr, settings from `.env` in `cwd` and the environment. */
export function nodeIo(cwd: string, environment: Readonly<Record<string, string | undefined>>): CliIo {
  const settings = cliSettings(cwd, environment);
  const files = new NodeFiles();
  return {
    out: { line: (text) => { process.stdout.write(`${text}\n`); }, warn: (text) => { process.stderr.write(`${text}\n`); } },
    files,
    cwd,
    builder: new ViteBuilder({ probeTimeout: settings.HARNESS_CLI_PROBE_TIMEOUT, probeEnv: scrubbedEnv(environment) }),
    tests: new VitestRunner(files),
    settings,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    stdin: () => linesOf(process.stdin),
    hub: (options) => connectHub(withSavedAdmin(hubTarget(settings, options), readAdminFile(dataFolder(cwd, settings.HARNESS_DATA, {})))),
    // loaded only when asked: the stack's script, beside the CLI in the repository and in the published package
    start: async (options) => (await import(pathToFileURL(START_SCRIPT).href) as StartScript).startHarness(options),
  };
}
