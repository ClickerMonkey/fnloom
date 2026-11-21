/**
 * The fs system's tunables, an `@ayepi/env` slice. Durations are milliseconds; sizes are characters or bytes as
 * named. Feature code reads these through `fsEnv.parse()`, never `process.env`.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

/** Folder names skipped by every walk (listing, glob, grep, tree, mentions) unless asked for by path. */
const IGNORED = ['.git', 'node_modules', 'dist', 'coverage', '.types', '.harness', '.harness-test', '.next', '.cache', '__pycache__', '.venv'];

/**
 * Commands that run without asking when the user has no shell setting, while their paths stay inside the roots and
 * their options fit their shapes (server/safe.ts). Nothing that runs the repository's own code (npm test, npx vitest).
 */
const SAFE = ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'which', 'git status', 'git diff', 'git log', 'git show', 'git branch'];

export const fsEnv = env({
  ...systemFields(),
  /** The shell `bash` runs commands with. Default: Git Bash on Windows when installed, else bash, else the system shell. */
  FS_SHELL: z.string().optional(),
  /** Lines `read` returns when no limit is given. */
  FS_READ_LINES: z.number().int().min(1).default(2_000),
  /** Largest file `read`, `edit` and `grep` open, in bytes. */
  FS_FILE_MAX: z.number().int().min(1).default(5_000_000),
  /** A command's timeout when none is given. */
  FS_COMMAND_TIMEOUT: z.number().int().min(1).default(120_000),
  /** The longest timeout a command may ask for. */
  FS_COMMAND_TIMEOUT_MAX: z.number().int().min(1).default(600_000),
  /** Characters of each output stream a command keeps (the end is kept). */
  FS_OUTPUT_MAX: z.number().int().min(1).default(60_000),
  /** How often a running command reports progress. */
  FS_PROGRESS_EVERY: z.number().int().min(1).default(500),
  /** Largest change (before plus after, in characters) attached as a diff. */
  FS_DIFF_MAX: z.number().int().min(0).default(400_000),
  /** Most changed files a `bash` call's change set lists. */
  FS_CHANGES_MAX_FILES: z.number().int().min(1).default(200),
  /** Largest changed file (and its diff) a `bash` change set shows as a diff, in bytes; larger ones are listed as large. */
  FS_DIFF_MAX_BYTES: z.number().int().min(1).default(200_000),
  /** Most characters of diff one change set carries in all (it goes to the model with the result); later files are listed as large. */
  FS_CHANGES_DIFF_TOTAL: z.number().int().min(0).default(40_000),
  /** How long after a command ends its change watcher still listens, for events reported late. */
  FS_CHANGES_SETTLE: z.number().int().min(0).default(150),
  /** How long one git command for change capture or a gitignore check may take. */
  FS_GIT_WORK_TIMEOUT: z.number().int().min(1).default(15_000),
  /** Characters of a git command's output kept for change capture (a status of a large work tree, a diff). */
  FS_GIT_OUTPUT_MAX: z.number().int().min(1).default(4_000_000),
  /** Most matches `grep` returns when no limit is given. */
  FS_GREP_LIMIT: z.number().int().min(1).default(200),
  /** Most files one `grep` or `glob` looks at. */
  FS_SCAN_MAX: z.number().int().min(1).default(50_000),
  /** How long one `grep` may match for before it is stopped, so a slow pattern can't hold fs up. */
  FS_GREP_TIMEOUT: z.number().int().min(1).default(20_000),
  /** Characters of each line `grep` tests against its pattern (the rest of a longer line is not searched). */
  FS_GREP_TEST_MAX: z.number().int().min(1).default(10_000),
  /** Characters of a matching line `grep` returns. */
  FS_LINE_MAX: z.number().int().min(1).default(300),
  /** Most paths `glob` returns. */
  FS_GLOB_LIMIT: z.number().int().min(1).default(1_000),
  /** Most entries `list` returns. */
  FS_LIST_LIMIT: z.number().int().min(1).default(2_000),
  /** Folder names every walk skips. */
  FS_IGNORE: z.array(z.string()).default(IGNORED),
  /** Commands that run without asking when the user has no shell setting (server/safe.ts says when). */
  FS_SAFE_COMMANDS: z.array(z.string()).default(SAFE),
  /** How deep the `tree` context goes. */
  FS_TREE_DEPTH: z.number().int().min(1).default(3),
  /** Most entries the `tree` context shows per root. */
  FS_TREE_ENTRIES: z.number().int().min(1).default(400),
  /** Most results one `@` search returns. */
  FS_MENTION_LIMIT: z.number().int().min(1).default(20),
  /** Lines of a file a mention's hover card previews. */
  FS_PREVIEW_LINES: z.number().int().min(0).default(12),
  /** How long the path index behind `@` search is reused before walking the roots again. */
  FS_INDEX_TTL: z.number().int().min(0).default(10_000),
  /** Most paths the `@` index keeps per root. */
  FS_INDEX_MAX: z.number().int().min(1).default(100_000),
  /** Resources per page when the hub lists a folder. */
  FS_RESOURCE_PAGE: z.number().int().min(1).max(1_000).default(200),
  /** Largest text a resource read returns inline, in characters. */
  FS_RESOURCE_TEXT_MAX: z.number().int().min(1).default(2_000_000),
  /** How long file changes are gathered before they are reported. */
  FS_WATCH_DEBOUNCE: z.number().int().min(0).default(300),
  /** How long the git hook waits for git. */
  FS_GIT_TIMEOUT: z.number().int().min(1).default(450),
  /** Changed files the git hook names per root. */
  FS_GIT_FILES: z.number().int().min(0).default(20),
  /** How long launching the file manager may take. */
  FS_REVEAL_TIMEOUT: z.number().int().min(1).default(10_000),
  /** How long after answering `restart` the process restarts. */
  FS_RESTART_DELAY: z.number().int().min(0).default(250),
  /** How long a system `install_system` or `restart_system` starts may take to connect to the hub. */
  FS_HOSTED_CONNECT_TIMEOUT: z.number().int().min(1_000).default(30_000),
  /** How often a starting hosted system is looked for in the hub. */
  FS_HOSTED_CHECK_EVERY: z.number().int().min(50).default(500),
  /** Characters of a hosted system's output kept for its status and a crash report. */
  FS_HOSTED_OUTPUT_TAIL: z.number().int().min(256).default(4_096),
  /** The most build problems an invalid install returns (the rest are counted). */
  FS_HOSTED_PROBLEMS: z.number().int().min(1).default(40),
  /** The first wait before restarting a crashed hosted system; it doubles with each crash in the hour. */
  FS_HOSTED_BACKOFF: z.number().int().min(100).default(1_000),
  /** The longest wait between restarts. */
  FS_HOSTED_BACKOFF_MAX: z.number().int().min(100).default(300_000),
  /** Crashes in an hour after which a hosted system is disabled until restarted. */
  FS_HOSTED_CRASHES_PER_HOUR: z.number().int().min(1).default(5),
  /** How long reading a built system's contract may take. */
  FS_HOSTED_PROBE_TIMEOUT: z.number().int().min(1_000).default(60_000),
  /** How long looking up (or killing) a hosted process an earlier fs left running may take, when fs starts. */
  FS_HOSTED_STALE_TIMEOUT: z.number().int().min(500).default(10_000),
  /** How many times a hosted folder or record rename is tried while Windows still holds a handle in it (EPERM, EBUSY). */
  FS_HOSTED_RENAME_TRIES: z.number().int().min(1).default(6),
  /** The first wait between those tries; it doubles each time. */
  FS_HOSTED_RENAME_WAIT: z.number().int().min(1).default(50),
  /** How long a folder's own tests may run before install_system shows its card (`ProcessSystemTests`). */
  FS_TESTS_TIMEOUT: z.number().int().min(5_000).default(300_000),
}).add(systemState('fs'));

/** The fs system's settings, resolved. */
export type FsSettings = ReturnType<typeof fsEnv.parse>;
