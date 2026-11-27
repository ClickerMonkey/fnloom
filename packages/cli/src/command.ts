/**
 * What every `harness` command is: a name, a one-line summary, one zod schema for its parsed arguments (positionals
 * and `--options`, the one source of what it takes: `node:util` `parseArgs` is configured from it), and `run` over
 * injected io, so every command is tested without a hub, a disk or a build.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { CliFiles } from './files.ts';
import type { CliSettings, HubSession } from './hub.ts';
import type { StartOptions } from './local.ts';
import type { SystemBuilder, SystemTestRunner } from '@harness/build';

/** Where a command's output goes. */
export interface CliOutput {
  /** A line of normal output. */
  line(text: string): void;
  /** A line about something that went wrong or needs attention. */
  warn(text: string): void;
}

/** What a command runs over. Each part is an interface with a real implementation and a test one. */
export interface CliIo {
  readonly out: CliOutput;
  readonly files: CliFiles;
  /** The folder relative paths are read against. */
  readonly cwd: string;
  /** Builds systems (typecheck, bundle, client). */
  readonly builder: SystemBuilder;
  /** Runs system folders' own tests (`harness test`). */
  readonly tests: SystemTestRunner;
  /** The CLI's settings (`cliEnv`). */
  readonly settings: CliSettings;
  /** Wait (polling a hub). */
  sleep(ms: number): Promise<void>;
  /** The lines of standard input (the MCP bridge). */
  stdin(): AsyncIterable<string>;
  /** A signed-in connection to a hub (`--hub`, `--token` override the settings), made when a command needs it. */
  hub(options: HubOptions): Promise<HubSession>;
  /** Start the hub and the default systems on this machine (`harness start`); resolves with the exit code once they are up. */
  start(options: StartOptions): Promise<number>;
}

/** The options every command that talks to a hub takes. */
export const HUB_OPTIONS = {
  /** The hub's address; default `HARNESS_URL`. */
  hub: z.string().optional(),
  /** An admin access token, or `-` to read it from stdin; default `HARNESS_TOKEN`, else the admin account from `.env`. */
  token: z.string().optional(),
} as const;

/** The hub options as parsed. */
export type HubOptions = { readonly hub?: string | undefined; readonly token?: string | undefined };

/** A command's arguments as `parseArgs` gives them, before its schema checks them. */
export interface RawArgs {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string | boolean | undefined>>;
}

/** A `--option`: read as a string or a flag (a boolean schema), and checked by its schema. */
export type OptionSchema = z.ZodType<string | boolean | undefined, string | boolean | undefined>;

/** The shape every command's schema has: positionals, and `--options` by name. */
export type ArgsSchema = z.ZodObject<{ positionals: z.ZodType<readonly string[], readonly string[]>; values: z.ZodObject<Record<string, OptionSchema>> }>;

/** One `harness` command. */
export interface CliCommand<S extends ArgsSchema = ArgsSchema> {
  /** The words that name it: `['system', 'build']`. */
  readonly path: readonly string[];
  /** What it does, in one line. */
  readonly summary: string;
  /** How it is called: `<dir>` and the like, after its path. */
  readonly usage: string;
  readonly args: S;
  /** Run it; resolves with the process exit code. */
  run(args: z.infer<S>, io: CliIo): Promise<number>;
}

/** A command, with its arguments' type checked against its schema. */
export function command<S extends ArgsSchema>(definition: CliCommand<S>): CliCommand<S> {
  return definition;
}

/** Why arguments were refused, ready to print. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** The `parseArgs` type of an option schema: a flag when its schema takes `true`, else a string. */
function optionType(schema: OptionSchema): 'string' | 'boolean' {
  return schema.safeParse(true).success ? 'boolean' : 'string';
}

/** The `parseArgs` options a command's schema describes. */
export function optionsOf(schema: ArgsSchema): Record<string, { type: 'string' | 'boolean' }> {
  return Object.fromEntries(Object.entries(schema.shape.values.shape).map(([name, option]) => [name, { type: optionType(option) }]));
}

/** Parse a command's argv (after its path) with `parseArgs`, configured from its schema, then check it. */
export function parseCommand<S extends ArgsSchema>(definition: CliCommand<S>, argv: readonly string[]): z.infer<S> {
  let raw: RawArgs;
  try {
    raw = parseArgs({ args: [...argv], options: optionsOf(definition.args), allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const parsed = definition.args.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(parsed.error.issues.map((issue) => `${issue.path.slice(1).join('.') || 'arguments'}: ${issue.message}`).join('; '));
  }
  return parsed.data;
}
