/** The io the `harness` binary runs commands over: the console, the disk, Vite, a hub over HTTP, and stdin. */
import type { CliIo } from './command.ts';
import { ViteBuilder } from './builder.ts';
import { linesOf } from './commands/mcp.ts';
import { NodeFiles } from './files.ts';
import { cliSettings, connectHub, hubTarget } from './hub.ts';

/** The process's io: lines to stdout, warnings to stderr, settings from `.env` in `cwd` and the environment. */
export function nodeIo(cwd: string, environment: Readonly<Record<string, string | undefined>>): CliIo {
  const settings = cliSettings(cwd, environment);
  return {
    out: { line: (text) => { process.stdout.write(`${text}\n`); }, warn: (text) => { process.stderr.write(`${text}\n`); } },
    files: new NodeFiles(),
    cwd,
    builder: new ViteBuilder(),
    settings,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    stdin: () => linesOf(process.stdin),
    hub: (options) => connectHub(hubTarget(settings, options)),
  };
}
