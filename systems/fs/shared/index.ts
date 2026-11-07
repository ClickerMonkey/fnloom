/**
 * The fs system's contract (`shared/`): files and a shell over chosen folders, served as resources, and a restart
 * so changes to its own code go live. Other systems import this to call its fns with typed refs; its server
 * implements it and its client draws it.
 */
import { action, agent, arg, attachment, context, fn, g, handler, hook, hub, linear, mention, setting, system, type } from '@harness/sdk';

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
    reveal: fn({ description: 'Show it in the file manager.', args: g.obj({}), returns: g.bool(), visibility: 'user' }),
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

/** The fs system's contract. */
export const fs = system('fs', { description: 'Files and a shell over chosen folders, served as resources. Can restart itself.' })
  .with({
    // set by an admin in the hub; the server gets it typed when it starts
    config: g.obj({
      // the folders it serves and works in; nothing outside them is reachable
      roots: g.list(Root),
      // its own source folder, so it can change itself and restart
      self: g.optional(g.text()),
    }),
    types: { Entry },
    settings: {
      shell: setting({
        description: 'Which commands run without asking.',
        type: g.obj({ allowed: g.bool(), safe: g.list(g.text()) }),
        appliesTo: ['user', 'group'],
        merge: 'most-restrictive',
      }),
    },
    attachments: {
      diff: attachment({ description: 'A change to a file, drawn as a diff.', data: g.obj({ path: g.text(), before: g.text(), after: g.text() }) }),
    },
    fns: {
      read: fn({
        description: 'Read a text file, or part of it by line.',
        args: g.obj({ path: g.text(), offset: g.optional(g.num({ min: 0, whole: true })), limit: g.optional(g.num({ min: 1, whole: true })) }),
        returns: g.obj({ text: g.text(), lines: g.num(), truncated: g.bool() }),
        tags: ['read'],
      }),
      write: fn({
        description: 'Write a file, creating it if needed.',
        args: g.obj({ path: g.text(), text: hub.types.LongText }),
        returns: g.obj({ created: g.bool() }),
        undo: Previous,
      }),
      edit: fn({
        description: 'Replace exact text in a file.',
        args: g.obj({ path: g.text(), find: g.text(), replace: g.text(), all: g.optional(g.bool()) }),
        returns: g.obj({ replacements: g.num() }),
        undo: Previous,
      }),
      list: fn({
        description: 'List a folder.',
        args: g.obj({ path: g.text(), depth: g.optional(g.num({ min: 1, max: 5, whole: true })) }),
        returns: g.obj({ entries: g.list(Entry.shape) }),
        tags: ['read'],
      }),
      glob: fn({
        description: 'Find paths matching a glob.',
        args: g.obj({ pattern: g.text(), root: g.optional(g.text()) }),
        returns: g.obj({ paths: g.list(g.text()) }),
        tags: ['read'],
      }),
      grep: fn({
        description: 'Search file contents with a regular expression.',
        args: g.obj({ pattern: g.text(), root: g.optional(g.text()), glob: g.optional(g.text()), limit: g.optional(g.num({ min: 1, whole: true })) }),
        returns: g.obj({ matches: g.list(g.obj({ path: g.text(), line: g.num(), text: g.text() })) }),
        progress: linear,
        tags: ['read'],
      }),
      cd: fn({
        description: 'Change the working folder for later commands in this chat.',
        args: g.obj({ path: g.text() }),
        returns: g.obj({ cwd: g.text() }),
        // shared with bash through session state; the LLM never has to pass it around
        state: Shell,
        display: 'hidden',
      }),
      bash: fn({
        description: 'Run a shell command. It runs in the working folder set with cd unless cwd is given.',
        args: g.obj({ command: g.text(), cwd: g.optional(g.text()), timeout: g.optional(g.duration()) }),
        returns: CommandResult,
        state: Shell,
        progress: linear,
        handlers: {
          confirm: handler({
            description: 'Run a command your shell setting would ask about?',
            args: g.obj({ command: g.text(), reason: g.text() }),
            returns: g.bool(),
            required: false,
          }),
        },
      }),
      remove: fn({
        description: 'Delete a file.',
        args: g.obj({ path: g.text() }),
        returns: g.obj({ removed: g.bool() }),
        undo: Previous,
      }),
      restart: fn({
        description: 'Restart this system so changes to its code go live. It reconnects on its own.',
        args: g.obj({ reason: g.text() }),
        returns: g.obj({ restarting: g.literal(true) }),
        operations: { cancel: false, background: false },
      }),
    },
    hooks: { git: hook({ description: 'Adds the current branch and the changed files.', order: 50, timeout: 500 }) },
    actions: {
      // the bash card's "run again" button
      rerun: action({
        description: 'Run a command again from its card.',
        input: g.obj({ command: g.text() }),
        returns: CommandResult,
        state: Shell,
      }),
    },
  })
  // mentions, context and the agent use the types and fns declared above
  .with(({ fns, types }) => ({
    mentions: {
      // chips and cards show as Entry: its label, icon and color, and its reveal method on the card
      files: mention({ title: 'Files', description: 'Files and folders under the roots.', target: g.obj({ root: g.text(), path: g.text() }), of: types.Entry }),
    },
    context: {
      guide: context({
        description: 'How to work with files here: read before editing, prefer edit over write.',
        content: 'Read a file before editing it. Use edit for small changes and write only for new files. Search with grep and glob before guessing paths.',
        fns: [fns.read, fns.edit, fns.grep, fns.glob],
      }),
      tree: context({
        description: 'The folder tree of a root, as it is now.',
        command: { name: 'tree', args: { root: arg('Which root (default: all)', { required: false }) } },
      }),
    },
  }))
  .with(({ fns, context: ctx }) => ({
    fns: {
      explore: agent({
        description: 'Answers questions about the code by reading it.',
        args: g.obj({ question: g.text() }),
        returns: g.text(),
        instructions: 'Answer {{args.question}} by reading the code. Quote paths and lines.',
        tools: [fns.read, fns.glob, fns.grep, hub.fns.search_resources],
        context: [ctx.guide],
      }),
    },
  }));

/** The fs contract's type. */
export type FsContract = typeof fs;
