/**
 * Running a command for `bash`: the user's shell setting, the working folder from session state, confirmation for
 * commands that aren't safe (`safe.ts`), the scrubbed environment it starts with, and the timeout. The bash card's "Run again" starts a new `bash` run, so a command
 * runs the same way from the agent and from its card.
 */
import type { ChangeSet } from '@harness/core';
import type { ShellPolicyValue } from '../shared/index.ts';
import type { FileService } from './files.ts';
import type { CaptureSession, CommandOutput, CommandProgress, CommandRun, PathGuard, Shell } from './index.ts';
import { FsProblem } from './problem.ts';
import { hardenedGitConfigEnv } from './git.ts';
import { isSafe } from './safe.ts';

/** Asks the caller whether to run a command; `undefined` when nobody can be asked. */
export type Confirm = ((input: { command: string; reason: string }) => Promise<boolean>) | undefined;

/** How commands are timed. */
export interface CommandLimits {
  /** A command's timeout when none is given. */
  readonly timeout: number;
  /** The longest timeout a command may ask for. */
  readonly maxTimeout: number;
  /** Safe prefixes for users with no shell setting. */
  readonly safe: readonly string[];
}

/** One command to run. */
export interface CommandRequest {
  readonly command: string;
  /** The folder asked for, if any (absolute, or relative to the session's working folder). */
  readonly cwd: string | undefined;
  readonly timeout: number | undefined;
}

/** What the command runner needs from the context it runs in. */
export interface CommandScope {
  readonly guard: PathGuard;
  /** The user's shell setting, if they have one. */
  readonly policy: ShellPolicyValue | undefined;
  /** The session's working folder, from `cd`. */
  readonly sessionCwd: string | undefined;
  readonly signal: AbortSignal;
  /** Asked when the command isn't safe; undefined when nobody can be asked. */
  readonly confirm: Confirm;
  /** The whole environment the command starts with (`commandEnv`). */
  readonly env: Readonly<Record<string, string>>;
  readonly onOutput?: CommandProgress;
  /** Starts watching what the command changes in the folder it runs in (`server/changes.ts`), when wanted. */
  readonly capture?: (cwd: string) => Promise<CaptureSession>;
}

/** A finished command and where it ran. */
export interface CommandOutcome extends CommandRun {
  readonly cwd: string;
  readonly timeout: number;
  /** The files it changed, when they could be found. */
  readonly changes?: ChangeSet;
  /** Why the changes could not be found, when capture failed (the command itself ran). */
  readonly captureProblem?: string;
}

/** The output part of a run, as the contract's `CommandResult`. */
export function outputOf(run: CommandRun): CommandOutput {
  return { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
}

/** Whether the path guard places a word inside the roots, from the folder a command runs in. */
function placeable(guard: PathGuard, word: string, cwd: string): boolean {
  try {
    guard.resolve(word, { write: false, cwd });
    return true;
  } catch (error) {
    if (error instanceof FsProblem) { return false; }
    throw error;
  }
}

/** Runs commands for fns. */
export class CommandRunner {
  private readonly shell: Shell;
  private readonly files: FileService;
  private readonly limits: CommandLimits;

  constructor(shell: Shell, files: FileService, limits: CommandLimits) {
    this.shell = shell;
    this.files = files;
    this.limits = limits;
  }

  /** The folder a command runs in: the one asked for, else the session's, else the first root. */
  async workingFolder(guard: PathGuard, asked: string | undefined, sessionCwd: string | undefined): Promise<string> {
    if (asked !== undefined) { return this.folder(guard, asked, sessionCwd); }
    if (sessionCwd !== undefined && guard.locate(sessionCwd) !== undefined && (await this.files.target(sessionCwd))?.type === 'folder') { return sessionCwd; }
    return guard.resolve('', { write: false }).root.folder;
  }

  /** Resolve a folder, refusing a file or nothing. */
  async folder(guard: PathGuard, path: string, cwd: string | undefined): Promise<string> {
    const at = guard.resolve(path, { write: false, cwd });
    const entry = await this.files.target(at.path);
    if (entry === undefined) { throw new FsProblem('not-found', `${at.path} doesn't exist.`); }
    if (entry.type !== 'folder') { throw new FsProblem('not-a-folder', `${at.path} is a ${entry.type}, not a folder.`); }
    return at.path;
  }

  async run(request: CommandRequest, scope: CommandScope): Promise<CommandOutcome> {
    const policy = scope.policy ?? { allowed: true, safe: [...this.limits.safe] };
    if (!policy.allowed) { throw new FsProblem('denied', 'Your shell setting doesn\'t allow running commands.'); }
    const cwd = await this.workingFolder(scope.guard, request.cwd, scope.sessionCwd);
    const safe = isSafe(request.command, policy.safe, (word) => placeable(scope.guard, word, cwd));
    if (!safe) {
      if (scope.confirm === undefined) {
        throw new FsProblem('needs-confirmation', `"${request.command}" isn't one of your safe commands, and there is no one to confirm it.`);
      }
      const yes = await scope.confirm({ command: request.command, reason: 'It isn\'t one of your safe commands, or it reaches outside the folders.' });
      if (!yes) { throw new FsProblem('denied', `"${request.command}" was not confirmed, so it didn't run.`); }
    }
    const timeout = Math.min(request.timeout ?? this.limits.timeout, this.limits.maxTimeout);
    let problem: string | undefined;
    const failed = (error: unknown) => { problem = error instanceof Error ? error.message : String(error); return undefined; };
    const session = await scope.capture?.(cwd).catch(failed);
    let run: CommandRun;
    let changes: ChangeSet | undefined;
    try {
      // a command that runs without asking also runs git without the programs a repository's config names
      run = await this.shell.run({ command: request.command, cwd, timeout, signal: scope.signal, env: safe ? { ...scope.env, ...hardenedGitConfigEnv() } : scope.env, ...(scope.onOutput === undefined ? {} : { onOutput: scope.onOutput }) });
    } finally {
      // the session is finished even when the shell throws, so its watcher and kept copies go
      changes = await session?.finish().catch(failed);
    }
    return { ...run, cwd, timeout, ...(changes === undefined ? {} : { changes }), ...(problem === undefined ? {} : { captureProblem: problem }) };
  }
}
