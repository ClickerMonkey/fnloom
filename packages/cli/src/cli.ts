/**
 * The `harness` command line: every command (`COMMANDS`), help, and `runCli`, which finds the command an argv names,
 * parses its arguments with its schema, runs it over the given io and turns what it throws into a message and an exit
 * code (1 for a failed command, 2 for bad usage).
 */
import { ApiError } from '@ayepi/core';
import { UsageError, parseCommand, type CliCommand, type CliIo } from './command.ts';
import { secretOption } from './hub.ts';
import { buildCommand } from './commands/build.ts';
import { exportDataCommand } from './commands/data.ts';
import { installCommand } from './commands/install.ts';
import { listCommand, startCommand, stopCommand, uninstallCommand, upgradeCommand } from './commands/manage.ts';
import { mcpCommand } from './commands/mcp.ts';
import { newCommand } from './commands/new.ts';
import { packCommand } from './commands/pack.ts';
import { testCommand } from './commands/test.ts';

/** Every command, in the order help lists them. */
export const COMMANDS = [
  newCommand, buildCommand, testCommand, packCommand, installCommand, exportDataCommand, listCommand, startCommand, stopCommand, upgradeCommand, uninstallCommand,
  mcpCommand,
] as const satisfies readonly CliCommand[];

/** A command's call as people type it: `harness system build [dir] [--skip-typecheck]`. */
export function usageOf(definition: Pick<CliCommand, 'path' | 'usage'>): string {
  return ['harness', ...definition.path, definition.usage].filter((part) => part !== '').join(' ');
}

/** The help text: every command with its summary. */
export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => usageOf(c).length));
  return [
    'harness: make, build, test, pack and install harness systems.',
    '',
    ...COMMANDS.map((c) => `  ${usageOf(c).padEnd(width)}  ${c.summary}`),
    '',
    'Commands that talk to a hub take --hub <url> (or HARNESS_URL) and sign in with HARNESS_TOKEN, or --token - to read the token',
    'from stdin, or the admin account in .env. A token typed as --token <token> can be seen by other programs on this machine.',
  ].join('\n');
}

/** The command an argv names (the longest path that matches), and the rest of the argv. */
export function findCommand(argv: readonly string[]): { command: CliCommand; rest: readonly string[] } | undefined {
  const matches = COMMANDS.filter((c) => c.path.every((word, i) => argv[i] === word)).sort((a, b) => b.path.length - a.path.length);
  const found = matches[0];
  return found === undefined ? undefined : { command: found, rest: argv.slice(found.path.length) };
}

/** Run the CLI over an argv; resolves with the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help')) {
    io.out.line(helpText());
    return 0;
  }
  const found = findCommand(argv);
  if (found === undefined) {
    io.out.warn(`unknown command: ${argv.join(' ')}`);
    io.out.warn(helpText());
    return 2;
  }
  try {
    // each command's own parse gives `run` the arguments its schema describes
    return await runParsed(found.command, found.rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.out.warn(`${error.message}\nusage: ${usageOf(found.command)}`);
      return 2;
    }
    io.out.warn(error instanceof ApiError ? `the hub refused: ${error.message} (${error.code})` : error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Parse and run one command; a `--token` it takes is read from stdin when given as `-`. */
async function runParsed<C extends CliCommand>(definition: C, argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseCommand(definition, argv);
  const given = parsed.values['token'];
  const token = typeof given === 'string' ? await secretOption(given, io, { flag: '--token', env: 'HARNESS_TOKEN', stdin: true }) : given;
  return definition.run(token === given ? parsed : { ...parsed, values: { ...parsed.values, token } }, io);
}
