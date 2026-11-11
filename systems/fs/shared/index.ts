/**
 * The fs system's contract (`shared/`): files and a shell over chosen folders, served as resources, and a restart
 * so changes to its own code go live. Other systems import this to call its fns with typed refs; its server
 * implements it and its client draws it.
 */
import { type Infer, type ValueOf, agent, arg, attachment, context, fn, g, handler, hook, hub, linear, mention, setting, system, type } from '@harness/sdk';
import { authoringContext } from './authoring.gen.ts';

export { AUTHORING_PARTS, perPart, type AuthoringPart } from './authoring.gen.ts';

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

/** What a command printed and how it ended. */
export const CommandResult = g.obj({ exitCode: g.num({ whole: true }), stdout: g.text(), stderr: g.text() });

/** The shell setting: whether commands may run at all, and which command prefixes run without asking. */
export const ShellPolicy = g.obj({ allowed: g.bool(), safe: g.list(g.text()) });

/** The diff attachment: a file's text before and after a change. */
export const DiffData = g.obj({ path: g.text(), before: g.text(), after: g.text() });

/** The files mention's target: a root by name and a path inside it, with `/` separators. */
export const FileTarget = g.obj({ root: g.text(), path: g.text() });

/** How fns take a path: absolute inside a root, or relative to the first root (or to a root named first). */
const PATH_DOCS = 'Absolute, or relative to a root: `docs/a.md` is in the first root, `<root name>/docs/a.md` in the named one.';
const path = () => g.field(g.text({ minLength: 1 }), { docs: PATH_DOCS });

/** The shortest timeout `bash` accepts, in milliseconds; a shorter one is refused as invalid input. */
export const COMMAND_TIMEOUT_MIN = 1_000;

/** The fs system's contract. */
export const fs = system('fs', { description: 'Files and a shell over chosen folders, served as resources. Can restart itself.' })
  .with({
    // set by an admin in the hub; the server gets it typed when it starts
    config: g.obj({
      // the folders it serves and works in; nothing outside them is reachable
      roots: g.list(Root),
      // its own source folder, so it can change itself and restart
      self: g.optional(g.text()),
      // globs of files never served as resources (a name, or a path from the root with `/`; `!` serves one again);
      // left out: env files but .env.example, keys, credentials (see server/secrets.ts); [] serves everything
      secrets: g.optional(g.list(g.text())),
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
        description: 'Read a text file, or part of it by line.',
        instructions: 'Read a file before you change or explain it. Paths are relative to a root (`src/app.ts`) or start with a root\'s name when there are several. For a long file read a window with `offset` (the first line, from 0) and `limit` (how many lines); `truncated` says more follows. Binary files are refused: use the resource tools for those.',
        examples: [
          { args: { path: 'README.md' }, note: 'The whole file.' },
          { args: { path: 'src/server/main.ts', offset: 120, limit: 60 }, note: 'Lines 121 to 180 of a long file.' },
        ],
        effects: { mode: 'read', free: true },
        args: g.obj({ path: path(), offset: g.optional(g.num({ min: 0, whole: true })), limit: g.optional(g.num({ min: 1, whole: true })) }),
        returns: g.obj({ text: g.text(), lines: g.num(), truncated: g.bool() }),
        status: {
          active: { one: 'Reading {args.path}…', many: 'Reading {n} files…' },
          retry: { one: 'Retrying reading {args.path}…', many: 'Retrying {n} file reads…' },
          done: { one: 'Read {args.path}', many: 'Read {n} files' },
          failed: { one: 'Reading {args.path} failed', many: '{n} file reads failed' },
        },
        tags: ['read'],
      }),
      write: fn({
        description: 'Write a file, creating it if needed.',
        instructions: 'Use it for a new file, or to replace a whole small file. For a change to an existing file use edit, so the rest stays as it is. Folders are made as needed. The old content is kept, so the write can be undone.',
        examples: [{ args: { path: 'notes/todo.md', text: '# To do\n\n- Write the tests\n' }, result: { created: true }, note: 'A new file.' }],
        effects: { mode: 'write', free: true },
        args: g.obj({ path: path(), text: hub.types.LongText }),
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
        description: 'Replace exact text in a file.',
        instructions: 'Read the file first and copy `find` exactly as it is there, spaces and line breaks included, with enough around it to be unique; the edit fails when it matches nothing or (without `all`) more than once. Set `all` to replace every match (renaming a word). It can be undone.',
        examples: [
          { args: { path: 'src/config.ts', find: 'timeout: 30_000,', replace: 'timeout: 60_000,' }, result: { replacements: 1 } },
          { args: { path: 'docs/guide.md', find: 'colour', replace: 'color', all: true }, result: { replacements: 4 }, note: 'Every match.' },
        ],
        effects: { mode: 'write', free: true },
        args: g.obj({ path: path(), find: g.text({ minLength: 1 }), replace: g.text(), all: g.optional(g.bool()) }),
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
        description: 'List a folder.',
        instructions: 'Use it to see what a folder holds before guessing names. `depth` 2 or more lists inside subfolders too (up to 5); prefer glob to find files by name anywhere. `.` is the root.',
        examples: [{ args: { path: '.' }, note: 'The root\'s top level.' }, { args: { path: 'src', depth: 2 } }],
        effects: { mode: 'read', free: true },
        args: g.obj({ path: path(), depth: g.optional(g.num({ min: 1, max: 5, whole: true })) }),
        returns: g.obj({ entries: g.list(Entry.shape) }),
        status: {
          active: { one: 'Listing {args.path}…', many: 'Listing {n} folders…' },
          retry: { one: 'Retrying listing {args.path}…', many: 'Retrying {n} folder lists…' },
          done: { one: 'Listed {args.path}', many: 'Listed {n} folders' },
          failed: { one: 'Listing {args.path} failed', many: '{n} folder lists failed' },
        },
        tags: ['read'],
      }),
      glob: fn({
        description: 'Find paths matching a glob.',
        instructions: 'Use it to find files by name or path. The pattern is relative to the root (every root when none is given); a pattern without `/`, like `*.md`, matches file names at any depth; `**` matches any folders. Folders the system ignores (node_modules, .git) are left out.',
        examples: [
          { args: { pattern: '*.md' }, note: 'Every markdown file.' },
          { args: { pattern: 'src/**/*.test.ts', root: 'app' }, note: 'Tests under src in one root.' },
        ],
        effects: { mode: 'read', free: true },
        args: g.obj({ pattern: g.text(), root: g.optional(g.text()) }),
        returns: g.obj({ paths: g.list(g.text()) }),
        status: {
          active: { one: 'Finding {args.pattern}…', many: 'Running {n} path searches…' },
          retry: { one: 'Retrying the search for {args.pattern}…', many: 'Retrying {n} path searches…' },
          done: { one: 'Found {args.pattern}', many: 'Ran {n} path searches' },
          failed: { one: 'Finding {args.pattern} failed', many: '{n} path searches failed' },
        },
        tags: ['read'],
      }),
      grep: fn({
        description: 'Search file contents with a regular expression.',
        instructions: 'Use it to find where something is used or defined before reading files. The pattern is a JavaScript regular expression tested on each line (escape `.`, `(` and the like). Narrow big searches with `glob` (`*.ts`, `src/**/*.vue`) and `limit`. Each match gives the path and line, so read around it next.',
        examples: [
          { args: { pattern: 'function createHub\\(', glob: '*.ts' }, note: 'Where a function is defined.' },
          { args: { pattern: 'TODO|FIXME', glob: 'src/**', limit: 50 } },
        ],
        effects: { mode: 'read', free: true },
        args: g.obj({ pattern: g.text(), root: g.optional(g.text()), glob: g.optional(g.text()), limit: g.optional(g.num({ min: 1, whole: true })) }),
        returns: g.obj({ matches: g.list(g.obj({ path: g.text(), line: g.num(), text: g.text() })) }),
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
        description: 'Change the working folder for later commands in this chat.',
        instructions: 'Set it once instead of passing `cwd` to every bash call; it lasts for this chat. The folder must be inside a root.',
        examples: [{ args: { path: 'packages/web' }, result: { cwd: 'packages/web' } }],
        effects: { mode: 'read', free: true },
        args: g.obj({ path: path() }),
        returns: g.obj({ cwd: g.text() }),
        // shared with bash through session state; the LLM never has to pass it around
        state: Shell,
        display: 'hidden',
      }),
      bash: fn({
        description: 'Run a shell command. It runs in the working folder set with cd unless cwd is given.',
        instructions: 'Use it to build, test, run git or any tool the files need; prefer read, grep and glob to look at files. Commands your shell setting does not mark safe ask the person first. Give a `timeout` for long builds. Check `exitCode` and `stderr`: a non-zero exit is a failed command, not a failed call.',
        examples: [
          { args: { command: 'git status --short' }, note: 'What changed.' },
          { args: { command: 'npm test -- --run src/app.test.ts', timeout: 120_000 }, note: 'One test file, with two minutes.' },
          { args: { command: 'ls -la', cwd: 'docs' } },
        ],
        // a command can do anything a shell can, deleting included; it spends no model money itself
        effects: { mode: 'delete', free: true },
        args: g.obj({ command: g.text(), cwd: g.optional(g.text()), timeout: g.field(g.optional(g.duration()), { docs: `How long the command may run, in milliseconds (30000 is 30 seconds); at least ${String(COMMAND_TIMEOUT_MIN)}. Leave empty for the default.` }) }),
        returns: CommandResult,
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
        description: 'Delete a file.',
        instructions: 'Only for a file the person asked to delete or one you made and no longer need. Folders are refused. The content is kept, so it can be undone.',
        examples: [{ args: { path: 'notes/scratch.md' }, result: { removed: true } }],
        effects: { mode: 'delete', free: true },
        args: g.obj({ path: path() }),
        returns: g.obj({ removed: g.bool() }),
        status: {
          active: { one: 'Deleting {args.path}…', many: 'Deleting {n} files…' },
          retry: { one: 'Retrying deleting {args.path}…', many: 'Retrying {n} deletes…' },
          done: { one: 'Deleted {args.path}', many: 'Deleted {n} files' },
          failed: { one: 'Deleting {args.path} failed', many: '{n} deletes failed' },
        },
        undo: Previous,
      }),
      restart: fn({
        description: 'Restart this system so changes to its code go live. It reconnects on its own.',
        instructions: 'Only after changing this system\'s own code (its `self` folder) and checking it builds. Say why in `reason`; runs in progress stop.',
        examples: [{ args: { reason: 'Added the tree command; reload it.' } }],
        effects: { mode: 'write', free: true },
        args: g.obj({ reason: g.text() }),
        returns: g.obj({ restarting: g.literal(true) }),
        operations: { cancel: false, background: false },
      }),
    },
    hooks: { git: hook({ description: 'Adds the current branch and the changed files.', order: 50, timeout: 500 }) },
  })
  // mentions, context and the agent use the types and fns declared above
  .with(({ fns, types }) => ({
    mentions: {
      // chips and cards show as Entry: its label, icon and color, and its reveal method on the card
      files: mention({ title: 'Files', description: 'Files and folders under the roots.', target: FileTarget, of: types.Entry }),
    },
    context: {
      guide: context({
        description: 'How to work with files here: read before editing, prefer edit over write.',
        content: [
          'Read a file before editing it. Use edit for small changes and write only for new files. Search with grep and glob before guessing paths, and list to see a folder.',
          'Run builds, tests and git with bash (set the folder once with cd); a command your shell setting does not mark safe asks the person first.',
          'Delete with remove only what the person asked for. Writes, edits and deletes can be undone.',
        ].join(' '),
        // the guide brings the fns it is about, so finding it finds them
        fns: [fns.read, fns.list, fns.glob, fns.grep, fns.edit, fns.write, fns.bash, fns.cd, fns.remove],
      }),
      tree: context({
        description: 'The folder tree of a root, as it is now.',
        command: { name: 'tree', args: { root: arg('Which root (default: all)', { required: false }) } },
      }),
      // the start of the SDK's authoring guide (its parts follow, one item each) and the template, so the chat can
      // write a system with these fns
      'system-authoring': context({
        description: 'How to write a harness system: the parts of the SDK guide and their sizes, where the template system is, and how to copy it.',
        command: { name: 'new-system' },
        fns: [fns.write, fns.edit, fns.bash, fns.read],
        alwaysFor: [],
      }),
    },
  }))
  // the authoring guide's parts, under its start item (generated from the guide: `npm run docs:authoring`)
  .with(({ context: ctx }) => ({ context: authoringContext(ctx['system-authoring']) }))
  .with(({ fns, context: ctx }) => ({
    fns: {
      explore: agent({
        description: 'Answers questions about the code by reading it.',
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
/** The files mention's target. */
export type FileTargetValue = Infer<typeof FileTarget>;
/** What undo needs to put a file back. */
export type PreviousValue = Infer<typeof Previous>;
