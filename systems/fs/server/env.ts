/**
 * The fs system's tunables, an `@ayepi/env` slice. Durations are milliseconds; sizes are characters or bytes as
 * named. Feature code reads these through `fsEnv.parse()`, never `process.env`.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Folder names skipped by every walk (listing, glob, grep, tree, mentions) unless asked for by path. */
const IGNORED = ['.git', 'node_modules', 'dist', 'coverage', '.types', '.harness', '.next', '.cache', '__pycache__', '.venv'];

/** Command prefixes that run without asking when the user has no shell setting. */
const SAFE = ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'which', 'git status', 'git diff', 'git log', 'git show', 'git branch', 'npm run typecheck', 'npm test', 'npx vitest', 'npx tsc'];

export const fsEnv = env({
  /** The hub's link URL. */
  HARNESS_HUB: z.string().default('ws://127.0.0.1:4300/link'),
  /** Where the system keeps its key pair, outcome journal and undo snapshots. */
  HARNESS_SYSTEM_STATE: z.string().default('.harness/systems/fs'),
  /** A one-time pairing token an admin made, if any. */
  HARNESS_PAIRING_TOKEN: z.string().optional(),
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
  /** Most matches `grep` returns when no limit is given. */
  FS_GREP_LIMIT: z.number().int().min(1).default(200),
  /** Most files one `grep` or `glob` looks at. */
  FS_SCAN_MAX: z.number().int().min(1).default(50_000),
  /** Characters of a matching line `grep` returns. */
  FS_LINE_MAX: z.number().int().min(1).default(300),
  /** Most paths `glob` returns. */
  FS_GLOB_LIMIT: z.number().int().min(1).default(1_000),
  /** Most entries `list` returns. */
  FS_LIST_LIMIT: z.number().int().min(1).default(2_000),
  /** Folder names every walk skips. */
  FS_IGNORE: z.array(z.string()).default(IGNORED),
  /** Command prefixes that run without asking when the user has no shell setting. */
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
});

/** The fs system's settings, resolved. */
export type FsSettings = ReturnType<typeof fsEnv.parse>;
