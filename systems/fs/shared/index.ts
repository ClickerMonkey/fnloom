/**
 * The fs system's contract (`shared/`): files and a shell over chosen folders, served as resources, a restart so
 * changes to its own code go live, and hosting: systems written here are installed from the chat, run on this machine
 * from a bundle an admin approved, and supervised. Other systems import this to call its fns with typed refs; its server
 * implements it and its client draws it.
 */
import { ChangeSet, SensitivityRule } from '@harness/core';
import { type Infer, type ValueOf, agent, agents, arg, attachment, context, fn, ginAs, g, handler, hook, hub, linear, mention, setting, system, type } from '@harness/sdk';
import { HostedState, HostedStatus, InstallArgs, InstallResult, RestartArgs, StatusArgs, StopArgs, StopResult } from './hosting.ts';

export * from './hosting.ts';

/** A file or folder under one of the roots. */
export const Entry = type({
  description: 'A file or folder under one of the roots.',
  shape: g.obj({
    path: g.text(),
    type: g.enum(['file', 'folder', 'link']),
    size: g.num({ min: 0, whole: true }),
    modifiedAt: g.timestamp(),
  }),
  display: { label: 'File', plural: 'Files', icon: 'file', color: '#8a8f98', title: 'path', subtitle: 'type' },
  methods: {
    // offered on a file's mention card; people and code can call it, the LLM can't (visibility)
    reveal: fn({
      description: 'Show it in the file manager.',
      instructions: 'Opens the system\'s file manager at the file or folder, on the machine fs runs on. True when the file manager opened.',
      args: g.obj({}),
      returns: g.bool(),
      examples: [{ args: {}, result: true }],
      effects: { mode: 'read', free: true },
      visibility: 'user',
    }),
  },
});

/** The shell's session state: the working folder `cd` sets and `bash` uses. */
export const Shell = g.obj({ cwd: g.text() });

/** What undo needs to put a file back: its earlier content, or nothing if it didn't exist. */
export const Previous = g.obj({ path: g.text(), previous: g.nullable(hub.types.ContentRef) });

/** One folder the system serves and works in. */
export const Root = g.obj({
  path: g.text({ minLength: 1 }),
  name: g.text({ minLength: 1 }),
  writable: g.bool(),
  index: g.enum(['all', 'on-read', 'none']),
});

/** How many undo copies fs keeps: per file (the newest), and in all (the oldest go first). */
export const SnapshotLimits = g.obj({
  perFile: g.field(g.num({ min: 1, whole: true }), { docs: 'Undo copies kept per file.' }),
  totalMb: g.field(g.num({ min: 1, whole: true }), { docs: 'Most space all undo copies use, in MB.' }),
});

/** What a command printed and how it ended. */
export const CommandResult = g.obj({ exitCode: g.num({ whole: true }), stdout: g.text(), stderr: g.text() });

/** What a command changed: the files, with a diff for each small text file in git (core `changes.ts`). */
export const Changes = ginAs(ChangeSet);

/** What `bash` returns: what the command printed, how it ended, and the files it changed when they could be found. */
export const BashResult = g.obj({ exitCode: g.num({ whole: true }), stdout: g.text(), stderr: g.text(), changes: g.optional(Changes) });

/** How many sensitive files a listing or search left out (`server/sensitive.ts`). */
const hidden = () => g.field(g.optional(g.num({ min: 0, whole: true })), { docs: 'Sensitive files left out (gitignored, env files, keys, credentials). Read one by its path if the task needs it; the person is asked first.' });

/** The shell setting: whether commands may run at all, and which command prefixes run without asking. */
export const ShellPolicy = g.obj({ allowed: g.bool(), safe: g.list(g.text()) });

/** The diff attachment: a file's text before and after a change. */
export const DiffData = g.obj({ path: g.text(), before: g.text(), after: g.text() });

/** The files mention's target: a root by name and a path inside it, with `/` separators. */
export const FileTarget = g.obj({ root: g.text(), path: g.text() });

/** How fns take a path: absolute inside a root, or relative to the first root (or to a root named first). */
const PATH_DOCS = 'A path inside one of the folders this system serves (its roots): relative to the first root (`docs/a.md`), starting with a root\'s name (`<root name>/docs/a.md`), or absolute inside a root. `/` and folders outside the roots are refused; `.` is the first root.';
const path = () => g.field(g.text({ minLength: 1 }), { docs: PATH_DOCS });

/** The shortest timeout `bash` accepts, in milliseconds; a shorter one is refused as invalid input. */
export const COMMAND_TIMEOUT_MIN = 1_000;

/** The fs system's contract. */
export const fs = system('fs', {
  description: 'Files and a shell over chosen folders, served as resources. Can restart itself.',
  about: [
    'Files and a shell over a few folders of the person\'s machine that an admin chose (its roots); nothing outside them can be reached, and `/` is not a root: paths are relative to the first root (`notes/todo.md`) or start with a root\'s name.',
    'Its fns read, list and search files (fs/read, fs/list, fs/glob, fs/grep), change them (fs/write, fs/edit, fs/remove: each may ask the person first, and each can be undone) and run bash commands (fs/bash, fs/cd).',
    'Reach for it to look at or change the person\'s files, and to keep a lasting document they can open later (a note, a recipe, a list) as a markdown file. It defines no fn kinds.',
    'A file the person attached to a chat message is not an fs file: it is a hub resource, read with the hub\'s resource fns. Its fns for installing and hosting systems (fs/install_system, fs/system_status, fs/restart_system, fs/stop_system, fs/restart) are for admins and system authors.',
    'Load its guide (fs/guide) before the first file change.',
  ].join(' '),
  // its authoring agents use models; installs wait for an admin and pair what they start; it keeps each person's cwd,
  // reads the shell setting, serves and announces resources, and shares the fns it writes
  grants: { hub: ['ai', 'approvals', 'fns', 'state', 'settings', 'resources', 'search'], calls: ['hub/search_resources'] },
  // its API groups: the hub indexes its fns by them (`fs/api`, `fs/api.<group>`)
  groups: [
    { name: 'files', title: 'Files', description: 'Read, write, edit, delete and search files under the roots, and ask questions about the code.' },
    { name: 'shell', title: 'Shell', description: 'Run commands (builds, tests, git) in a working folder; each command lists the files it changed.' },
    { name: 'systems', title: 'Systems', description: 'Install, check, restart and stop the systems this machine hosts, and restart fs itself.' },
  ],
})
  .with({
    // set by an admin in the hub; the server gets it typed when it starts
    config: g.obj({
      // the folders it serves and works in; nothing outside them is reachable
      roots: g.list(Root),
      // its own source folder, so it can change itself and restart
      self: g.optional(g.text()),
      // which files are sensitive and what reads and writes of them do (server/sensitive.ts); left out: the defaults
      // (gitignored files, env files but the example, keys, credentials, tokens and passwords in content, and writes of
      // files that lead to running code); [] trusts all but writes into .git, which always ask
      sensitive: g.optional(g.list(ginAs(SensitivityRule))),
      // before build 8: globs of files never served as resources (`!` serves one again); turned into rules when
      // `sensitive` is absent
      secrets: g.optional(g.list(g.text())),
      // the env variables bash commands get besides PATH, home, temp and locale (server/shell.ts `commandEnv`); left
      // out: none, so fs's own keys never reach a command
      commandEnv: g.field(g.optional(g.list(g.text({ minLength: 1 }))), { docs: 'Env variables commands also get, by name. Others are never passed on.' }),
      // how many undo copies fs keeps (server/snapshots.ts); left out: SNAPSHOT_DEFAULTS
      snapshots: g.field(g.optional(SnapshotLimits), { docs: 'How many undo copies to keep per file, and how much space they may use in all.' }),
    }),
    types: { Entry },
    settings: {
      shell: setting({
        description: 'Which commands run without asking.',
        type: ShellPolicy,
        appliesTo: ['user', 'group'],
        merge: 'most-restrictive',
      }),
    },
    attachments: {
      diff: attachment({ description: 'A change to a file, drawn as a diff.', data: DiffData }),
    },
    fns: {
      read: fn({
        group: 'files',
        description: 'Read a text file under the roots, whole or a window of its lines. Gives its text, how many lines it has, and whether more follows.',
        instructions: 'Read a file before you change it or say what is in it; never describe a file you have not read. Paths are relative to the first root (`src/app.ts`) or start with a root\'s name when there are several. For a long file read a window with `offset` (the first line, counted from 0) and `limit` (how many lines); `truncated: true` means more follows, and `partial` says which lines are here, how many were left out and how to read the rest: read on before you say what the rest holds. Binary files (PDFs, images) are refused: read those with hub/resource_read or hub/resource_send. A file attached to a chat message is not here: it is a hub resource.',
        examples: [
          { args: { path: 'README.md' }, note: 'The whole file.' },
          { args: { path: 'src/server/main.ts', offset: 120, limit: 60 }, note: 'Lines 121 to 180 of a long file.' },
        ],
        effects: { mode: 'read', free: true },
        // the hub asks which sensitive files a call touches first (server/sensitive.ts)
        flags: true,
        args: g.obj({ path: path(), offset: g.optional(g.num({ min: 0, whole: true })), limit: g.optional(g.num({ min: 1, whole: true })) }),
        returns: g.obj({ text: g.text(), lines: g.num(), truncated: g.bool(), partial: g.optional(g.text()) }),
        status: {
          active: { one: 'Reading {args.path}…', many: 'Reading {n} files…' },
          retry: { one: 'Retrying reading {args.path}…', many: 'Retrying {n} file reads…' },
          done: { one: 'Read {args.path}', many: 'Read {n} files' },
          failed: { one: 'Reading {args.path} failed', many: '{n} file reads failed' },
        },
        tags: ['read'],
      }),
      write: fn({
        group: 'files',
        description: 'Write a whole file under the roots, creating it (and its folders) if needed. Gives whether it was created or replaced.',
        instructions: 'Use it for a new file (a note, a list, a recipe the person wants to keep as a document), or to replace a whole small file. To change part of an existing file use fs/edit, so the rest stays as it is. It may ask the person first; the old content is kept, so the write can be undone. Tell the person the path you wrote, so they can find it.',
        examples: [{ args: { path: 'notes/todo.md', text: '# To do\n\n- Write the tests\n' }, result: { created: true }, note: 'A new file.' }],
        effects: { mode: 'write', free: true },
        // the hub asks which sensitive files a call touches first (server/sensitive.ts)
        flags: true,
        args: g.obj({ path: path(), text: hub.types.LongText }),
        // two changes to one file in the same step run in the model's order (server/impl.ts fileClaims)
        dynamicClaims: true,
        returns: g.obj({ created: g.bool() }),
        status: {
          active: { one: 'Writing {args.path}…', many: 'Writing {n} files…' },
          retry: { one: 'Retrying writing {args.path}…', many: 'Retrying {n} file writes…' },
          done: { one: 'Wrote {args.path}', many: 'Wrote {n} files' },
          failed: { one: 'Writing {args.path} failed', many: '{n} file writes failed' },
        },
        undo: Previous,
      }),
      edit: fn({
        group: 'files',
        description: 'Change part of a file: replace exact text with new text. Gives how many places were replaced.',
        instructions: 'Read the file first (fs/read) and copy `find` exactly as it is there, spaces and line breaks included, with enough around it to be unique; the edit fails when it matches nothing or (without `all`) more than once. Set `all` to replace every match (renaming a word). It can be undone.',
        examples: [
          { args: { path: 'src/config.ts', find: 'timeout: 30_000,', replace: 'timeout: 60_000,' }, result: { replacements: 1 } },
          { args: { path: 'docs/guide.md', find: 'colour', replace: 'color', all: true }, result: { replacements: 4 }, note: 'Every match.' },
        ],
        effects: { mode: 'write', free: true },
        // the hub asks which sensitive files a call touches first (server/sensitive.ts)
        flags: true,
        args: g.obj({ path: path(), find: g.text({ minLength: 1 }), replace: g.text(), all: g.optional(g.bool()) }),
        // two changes to one file in the same step run in the model's order (server/impl.ts fileClaims)
        dynamicClaims: true,
        returns: g.obj({ replacements: g.num() }),
        status: {
          active: { one: 'Editing {args.path}…', many: 'Editing {n} files…' },
          retry: { one: 'Retrying the edit to {args.path}…', many: 'Retrying {n} edits…' },
          done: { one: 'Edited {args.path}', many: 'Edited {n} files' },
          failed: { one: 'Editing {args.path} failed', many: '{n} edits failed' },
        },
        undo: Previous,
      }),
      list: fn({
        group: 'files',
        description: 'List what a folder under the roots holds: each file and folder with its type, size and when it changed.',
        instructions: 'Use it to see what a folder holds before guessing names. `.` is the first root; `/` is not a folder you can list (it is outside the roots), so start from `.` or a root\'s name. `depth` 2 or more lists inside subfolders too (up to 5); to find files by name anywhere use fs/glob. `hidden` counts sensitive files left out.',
        examples: [{ args: { path: '.' }, note: 'The root\'s top level.' }, { args: { path: 'src', depth: 2 } }],
        effects: { mode: 'read', free: true },
        // the hub asks which sensitive files a call touches first (server/sensitive.ts)
        flags: true,
        args: g.obj({ path: path(), depth: g.optional(g.num({ min: 1, max: 5, whole: true })) }),
        returns: g.obj({ entries: g.list(Entry.shape), hidden: hidden() }),
        status: {
          active: { one: 'Listing {args.path}…', many: 'Listing {n} folders…' },
          retry: { one: 'Retrying listing {args.path}…', many: 'Retrying {n} folder lists…' },
          done: { one: 'Listed {args.path}', many: 'Listed {n} folders' },
          failed: { one: 'Listing {args.path} failed', many: '{n} folder lists failed' },
        },
        tags: ['read'],
      }),
      glob: fn({
        group: 'files',
        description: 'Find files by name or path with a glob pattern (`*.md`, `src/**/*.ts`). Gives the matching paths.',
        instructions: 'Use it to find files by name or path when you don\'t know where they are. The pattern is relative to the root (every root when none is given); a pattern without `/`, like `*.md`, matches file names at any depth; `**` matches any folders. Folders the system ignores (node_modules, .git) are left out.',
        examples: [
          { args: { pattern: '*.md' }, note: 'Every markdown file.' },
          { args: { pattern: 'src/**/*.test.ts', root: 'app' }, note: 'Tests under src in one root.' },
        ],
        effects: { mode: 'read', free: true },
        // the hub asks which sensitive files a call touches first (server/sensitive.ts)
        flags: true,
        args: g.obj({ pattern: g.text(), root: g.optional(g.text()) }),
        returns: g.obj({ paths: g.list(g.text()), hidden: hidden() }),
        status: {
          active: { one: 'Finding {args.pattern}…', many: 'Running {n} path searches…' },
          retry: { one: 'Retrying the search for {args.pattern}…', many: 'Retrying {n} path searches…' },
          done: { one: 'Found {args.pattern}', many: 'Ran {n} path searches' },
          failed: { one: 'Finding {args.pattern} failed', many: '{n} path searches failed' },
        },
        tags: ['read'],
      }),
      grep: fn({
        group: 'files',
        description: 'Search the text inside files for a regular expression, line by line. Gives each matching line with its path and line number.',
        instructions: 'Use it to find which files mention something before reading them. The pattern is a JavaScript regular expression (the syntax of `new RegExp(pattern)`, no flags), tested on each line: escape `.`, `(`, `?` and the like with a backslash. It is case-sensitive, and inline flags such as `(?i)` are invalid in this syntax: for either case write a character class (`[Gg]rocer`) or both spellings (`Milk|milk`). A match never spans two lines. Narrow big searches with `glob` (`*.md`, `src/**/*.vue`) and `limit`. Each match gives the path and line, so read around it next with fs/read.',
        examples: [
          { args: { pattern: 'function createHub\\(', glob: '*.ts' }, note: 'Where a function is defined.' },
          { args: { pattern: 'TODO|FIXME', glob: 'src/**', limit: 50 } },
          { args: { pattern: '[Ff]lour', glob: '*.md' }, note: 'Either case: a character class, since `(?i)` is not allowed.' },
        ],
        effects: { mode: 'read', free: true },
        // the hub asks which sensitive files a call touches first (server/sensitive.ts)
        flags: true,
        args: g.obj({ pattern: g.text(), root: g.optional(g.text()), glob: g.optional(g.text()), limit: g.optional(g.num({ min: 1, whole: true })) }),
        returns: g.obj({ matches: g.list(g.obj({ path: g.text(), line: g.num(), text: g.text() })), hidden: hidden() }),
        progress: linear,
        status: {
          active: { one: 'Searching for {args.pattern}…', many: 'Running {n} searches…' },
          retry: { one: 'Retrying the search for {args.pattern}…', many: 'Retrying {n} searches…' },
          done: { one: 'Searched for {args.pattern}', many: 'Ran {n} searches' },
          failed: { one: 'Searching for {args.pattern} failed', many: '{n} searches failed' },
        },
        tags: ['read'],
      }),
      cd: fn({
        group: 'shell',
        description: 'Set the working folder that later fs/bash commands in this chat run in. Gives the folder now set.',
        instructions: 'Set it once instead of passing `cwd` to every fs/bash call; it lasts for this chat (undoing the turn puts it back). The folder must be inside a root.',
        examples: [{ args: { path: 'packages/web' }, result: { cwd: 'packages/web' } }],
        effects: { mode: 'read', free: true },
        args: g.obj({ path: path() }),
        returns: g.obj({ cwd: g.text() }),
        // shared with bash through session state; the LLM never has to pass it around
        state: Shell,
        display: 'hidden',
      }),
      bash: fn({
        group: 'shell',
        description: 'Run a bash command on the machine fs runs on, in the working folder set with fs/cd unless `cwd` is given. Gives its exit code, what it printed (stdout, stderr) and the files it changed.',
        instructions: 'The shell is bash (Git Bash on Windows when it is installed), not PowerShell or cmd: write POSIX commands (`ls`, `grep`, `&&`, forward slashes). Use it to build, test, run git or a program the files need; to look at files prefer fs/read, fs/grep and fs/glob, and to change them fs/write and fs/edit (those can be undone; what a command does cannot). Commands your shell setting does not mark safe ask the person first. Give a `timeout` for long builds. Check `exitCode` and `stderr`: a non-zero exit is a failed command, not a failed call. `changes` lists the files the command changed (with diffs in git), so you need not run git diff to see them.',
        examples: [
          { args: { command: 'git status --short' }, note: 'What changed.' },
          { args: { command: 'npm test -- --run src/app.test.ts', timeout: 120_000 }, note: 'One test file, with two minutes.' },
          { args: { command: 'ls -la', cwd: 'docs' } },
        ],
        // a command can do anything a shell can, deleting included; it spends no model money itself
        effects: { mode: 'delete', free: true },
        // the hub asks which sensitive files a call touches first (server/sensitive.ts)
        flags: true,
        args: g.obj({ command: g.text(), cwd: g.optional(g.text()), timeout: g.field(g.optional(g.duration()), { docs: `How long the command may run, in milliseconds (30000 is 30 seconds); at least ${String(COMMAND_TIMEOUT_MIN)}. Leave empty for the default.` }) }),
        returns: BashResult,
        state: Shell,
        progress: linear,
        status: {
          active: { one: 'Running {args.command}…', many: 'Running {n} commands…' },
          retry: { one: 'Retrying {args.command}…', many: 'Retrying {n} commands…' },
          done: { one: 'Ran {args.command}', many: 'Ran {n} commands' },
          failed: { one: '{args.command} failed', many: '{n} commands failed' },
        },
        handlers: {
          confirm: handler({
            description: 'Run this command? Your shell setting asks first.',
            args: g.obj({ command: g.text(), reason: g.text() }),
            returns: g.bool(),
            required: false,
          }),
        },
      }),
      remove: fn({
        group: 'files',
        description: 'Delete one file under the roots. Gives whether it was removed.',
        instructions: 'Only for a file the person asked to delete, or one you made and no longer need. Folders are refused. It may ask the person first; the content is kept, so undoing the turn puts the file back.',
        examples: [{ args: { path: 'notes/scratch.md' }, result: { removed: true } }],
        effects: { mode: 'delete', free: true },
        // the hub asks which sensitive files a call touches first (server/sensitive.ts)
        flags: true,
        args: g.obj({ path: path() }),
        returns: g.obj({ removed: g.bool() }),
        // two changes to one file in the same step run in the model's order (server/impl.ts fileClaims)
        dynamicClaims: true,
        status: {
          active: { one: 'Deleting {args.path}…', many: 'Deleting {n} files…' },
          retry: { one: 'Retrying deleting {args.path}…', many: 'Retrying {n} deletes…' },
          done: { one: 'Deleted {args.path}', many: 'Deleted {n} files' },
          failed: { one: 'Deleting {args.path} failed', many: '{n} deletes failed' },
        },
        undo: Previous,
      }),
      restart: fn({
        group: 'systems',
        description: 'Restart this system so changes to its code go live. It reconnects on its own.',
        instructions: 'Only after changing this system\'s own code (its `self` folder) and checking it builds. Say why in `reason`; runs in progress stop.',
        examples: [{ args: { reason: 'Added the tree command; reload it.' } }],
        effects: { mode: 'write', free: true },
        args: g.obj({ reason: g.text() }),
        returns: g.obj({ restarting: g.literal(true) }),
        operations: { cancel: false, background: false },
      }),
      install_system: fn({
        group: 'systems',
        description: 'Build, check and start a system folder on this machine, and connect it to the hub, once an admin approves.',
        instructions: [
          'After writing or changing a system folder: builds, checks and starts it on this machine and connects it to the hub. Call it again after each change; it restarts the system with the new code.',
          'Before anything is asked, the folder is typechecked with its own tsconfig.json, bundled and scanned. When that fails the call comes back as invalid input with `file:line:col message` lines: fix each one with fs/edit and call again.',
          'A good build becomes a card for an admin with what the system adds, its scan and its hashes; nothing runs until they approve. If it exits before it connects, the call comes back with its exit code and the end of its output, so you can fix the crash.',
          'The name in system.json must be the contract\'s name. `hub`, and the name of a system that runs somewhere else, are refused unless `replace` is set (the card then says what it replaces).',
          'Once it is running, load its fns with hub/fns_load to call them. When it needs config, ask the person for it (its page has the form).',
        ].join(' '),
        examples: [
          {
            args: { path: 'systems/random' },
            result: { system: 'random', instance: 'main', version: '0.1.0', status: 'connected', fns: ['random/random'], folder: 'C:/work/harness/systems/random' },
            note: 'A new system, approved and running.',
          },
          { args: { path: 'systems/random' }, note: 'Again after a change: the card shows the diff, and the new code replaces the running one.' },
          { args: { path: 'systems/notes', instance: 'laptop', replace: true }, note: 'Replaces a `notes/laptop` that runs elsewhere.' },
        ],
        args: InstallArgs,
        returns: InstallResult,
        // what runs is new code: an admin looks at every install, and the chat must be in write mode or higher
        approval: { preview: true, remember: false, approver: 'admins' },
        effects: { mode: 'write', free: true },
        operations: { cancel: false, background: false },
        status: {
          active: { one: 'Installing {args.path}…', many: 'Installing {n} systems…' },
          retry: { one: 'Installing {args.path} again…', many: 'Installing {n} systems again…' },
          done: { one: 'Installed {args.path}', many: 'Installed {n} systems' },
          failed: { one: 'Installing {args.path} failed', many: '{n} installs failed' },
        },
        tags: ['admin', 'systems'],
      }),
      system_status: fn({
        group: 'systems',
        description: 'The systems this machine hosts: each one\'s state, version, process, restarts in the last hour and the end of its output.',
        instructions: 'Call it after install_system, restart_system or a crash to see whether a hosted system is up, and read `output` to find why it stopped. Give `system` for one; empty lists all.',
        examples: [
          {
            args: { system: 'random' },
            result: [{ system: 'random', instance: 'main', version: '0.1.0', state: 'connected', pid: 4120, restartsLastHour: 0, folder: 'C:/work/harness/systems/random', bundleHash: '9f2c…', output: 'random.serving …' }],
          },
          { args: {}, note: 'Every hosted system.' },
        ],
        args: StatusArgs,
        returns: g.list(HostedStatus),
        effects: { mode: 'read', free: true },
        display: 'message',
        tags: ['read', 'systems'],
      }),
      restart_system: fn({
        group: 'systems',
        description: 'Restart a system this machine hosts, with the code an admin approved.',
        instructions: 'Use it when a hosted system is stuck, crashed or was disabled after too many crashes. It runs the approved bundle again; it never picks up changed code (call install_system for that). Say why in `reason`.',
        examples: [{ args: { system: 'random', reason: 'It stopped answering after the hub restarted.' }, result: { state: 'connected' } }],
        args: RestartArgs,
        returns: g.obj({ state: HostedState }),
        effects: { mode: 'write', free: true },
        operations: { cancel: false, background: false },
        tags: ['systems'],
      }),
      stop_system: fn({
        group: 'systems',
        description: 'Stop a system this machine hosts; with `remove`, also delete its hosted folders.',
        instructions: 'It stays stopped (also after fs restarts) until install_system or restart_system starts it again. `remove` deletes its bundle, state and data for good, so the person is asked first; use it only when they want the system gone.',
        examples: [
          { args: { system: 'random' }, result: { stopped: true, removed: false } },
          { args: { system: 'random', remove: true }, result: { stopped: true, removed: true }, note: 'Gone for good, after the person said yes.' },
        ],
        args: StopArgs,
        returns: StopResult,
        effects: { mode: 'delete', free: true },
        operations: { cancel: false, background: false },
        handlers: {
          confirm: handler({
            description: 'Delete this hosted system\'s folders, its data included?',
            args: g.obj({ system: g.text(), folders: g.list(g.text()) }),
            returns: g.bool(),
            required: false,
          }),
        },
        tags: ['systems'],
      }),
    },
    hooks: {
      git: hook({
        description: 'Adds the current branch and the changed files.',
        // what `<fs_git>` means to the model: injected with fs's items into the agents that get the block
        explains: '`<fs_git>` is the git state of each folder the files system serves that is a git repository: its branch, and the files changed since the last commit. The person didn\'t type it. Mention it only when it matters to the request.',
        order: 50,
        timeout: 500,
      }),
    },
  })
  // mentions, context and the agent use the types and fns declared above
  .with(({ fns, types }) => ({
    mentions: {
      // chips and cards show as Entry: its label, icon and color, and its reveal method on the card
      files: mention({ title: 'Files', description: 'Files and folders under the roots.', target: FileTarget, of: types.Entry }),
    },
    context: {
      guide: context({
        description: 'How to work with the person\'s files: find, read, then change; keeping notes and lists as files; running commands.',
        content: [
          'The fs system works only inside the folders an admin chose (its roots). Paths are relative to the first root (`notes/todo.md`), or start with a root\'s name when there are several; `/` is outside the roots and is refused. Start with fs/list on `.` to see the first root.',
          '',
          'To find something: fs/glob finds files by name (`*.md`, `recipes/**`), fs/grep finds lines inside files by a regular expression (case-sensitive; write `[Ss]oup` for either case, never `(?i)`), fs/list shows one folder. Don\'t guess a path: look first.',
          'To read: fs/read, a window at a time for long files (`offset`, `limit`). Say only what you read.',
          'To change: fs/edit replaces exact text (copy `find` from what fs/read gave, spaces included); fs/write writes a whole new file; fs/remove deletes one file. Each may ask the person first, and each can be undone with the turn.',
          'To keep a document for the person (a shopping list, a recipe, notes from this chat): write a markdown file, for example fs/write with {"path":"notes/shopping-list.md","text":"# Shopping list\\n\\n- Milk\\n- Eggs\\n"}, then tell them the path. Check the result (`created`) before saying it is saved.',
          'To run a program, a build, tests or git: fs/bash runs a bash command (not PowerShell); set the folder once with fs/cd. Check `exitCode`: anything but 0 means the command failed. A command your shell setting does not mark safe asks the person first, and what it changes can\'t be undone.',
          '',
          'A file the person attached to a chat message is a hub resource, not an fs file: read it with hub/resource_read or look at it with hub/resource_send, not fs/read.',
        ].join('\n'),
        // the guide brings the fns it is about, so finding it finds them
        fns: [fns.read, fns.list, fns.glob, fns.grep, fns.edit, fns.write, fns.bash, fns.cd, fns.remove],
      }),
      // what every chat agent is told about files, in its system prompt (plan injected-context, section 5)
      basics: context({
        title: 'Files',
        description: 'Where the files system works (its roots), how paths are written, what can be undone, and that an attached file is not one of its files.',
        summary: 'The files system works only in folders an admin chose: paths are relative to the first root, never `/`. Load fs/guide first.',
        content: [
          'The **files system** (`fs`) works only inside a few folders of the person\'s machine an admin chose (its roots). Paths are relative to the first root (`notes/todo.md`) or start with a root\'s name; `/` is outside the roots and is refused. Look before you guess a path: fs/list on `.` shows the first root, fs/glob finds files by name, and fs/read reads one.',
          'fs/write, fs/edit and fs/remove may ask the person first, and what they change can be undone with the turn; what fs/bash changes can\'t. To keep a document for the person (a note, a list, a recipe), write a markdown file and tell them its path.',
          'A file the person attached to a message is not an fs file: it is kept by the hub, not under the roots. Load fs/guide before the first change.',
        ].join('\n'),
        fns: [fns.list, fns.read],
        inject: { into: [agents.startingWith(hub.fns.chat)] },
      }),
      tree: context({
        description: 'The folder tree of a root, as it is now.',
        command: { name: 'tree', args: { root: arg('Which root (default: all)', { required: false }) } },
      }),
      // the start of writing a system: it loads the guide's index (`context/authoring/`, a graph of the SDK guide) with
      // it, and says where the template is on this machine, with the fns to write and install a system
      'system-authoring': context({
        description: 'How to write and install a harness system: the index of its guide, where the template system is, and how to copy it.',
        command: { name: 'new-system' },
        imports: [{ ref: 'context', name: 'fs/authoring' }],
        fns: [fns.read, fns.write, fns.edit, fns.bash, fns.install_system, fns.system_status],
      }),
    },
  }))
  .with(({ fns, context: ctx }) => ({
    fns: {
      explore: agent({
        description: 'Answers questions about the code by reading it.',
        group: 'files',
        effects: { mode: 'read' },
        usage: 'Use it for a question that needs several files read (how a feature works, where something is decided) so your own context stays small. Ask one clear question; the answer quotes paths and lines.',
        args: g.obj({ question: g.text() }),
        returns: g.text(),
        instructions: [
          'Answer this question about the code by reading it: {{args.question}}',
          '',
          'Work in this order:',
          '1. Find where to look: grep for the names in the question (a function, a type, a message), glob for files by name, or hub/search_resources by meaning.',
          '2. Read the files that matter, a window at a time for long ones (offset and limit), and follow the calls and imports the answer depends on.',
          '3. Stop once you can answer; do not read everything.',
          '',
          'Answer in a few short paragraphs or a list. Quote each path with its line (`src/hub/link.ts:120`) for every claim, and say plainly what you could not find.',
          'Example: asked "where is the session timeout set?", grep for `timeout`, read the config file it points to, and answer',
          '"The timeout is HARNESS_SESSION_TIMEOUT in packages/hub/src/env.ts:42 (default 30 minutes); packages/hub/src/auth/sessions.ts:88 reads it."',
        ].join('\n'),
        examples: [
          { args: { question: 'How does the hub decide which instance runs a call?' } },
          { args: { question: 'Where are uploaded files stored, and how big may one be?' } },
        ],
        tools: [fns.read, fns.glob, fns.grep, hub.fns.search_resources],
        context: [ctx.guide],
      }),
    },
  }));

/** The fs contract's type. */
export type FsContract = typeof fs;

/** A file or folder, as fns return it. */
export type EntryValue = ValueOf<typeof Entry>;
/** What a command printed and how it ended. */
export type CommandOutput = Infer<typeof CommandResult>;
/** The diff attachment's data. */
export type DiffValue = Infer<typeof DiffData>;
/** The shell setting's value. */
export type ShellPolicyValue = Infer<typeof ShellPolicy>;
/** How many undo copies fs keeps. */
export type SnapshotLimitsValue = Infer<typeof SnapshotLimits>;
/** The undo copies kept when the config names no limits: 20 per file, 500 MB in all. */
export const SNAPSHOT_DEFAULTS: SnapshotLimitsValue = { perFile: 20, totalMb: 500 };
/** The files mention's target. */
export type FileTargetValue = Infer<typeof FileTarget>;
/** What undo needs to put a file back. */
export type PreviousValue = Infer<typeof Previous>;
/** What `bash` returns. */
export type BashOutput = Infer<typeof BashResult>;
