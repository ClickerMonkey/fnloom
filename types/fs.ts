// # The fs system
// The first system, written with the SDK exactly as it will ship: this file is its `shared/` contract. It gives an
// agent files and a shell over chosen folders, serves those folders as resources, and can restart itself so
// changes to its own code go live.

import { system, fn, handler, linear, context, setting, attachment, hook, mention, arg, agent, g, hub } from './sdk.ts';

/** A file or folder. */
export const Entry = g.obj({
  path: g.text(),
  type: g.enum('file', 'folder', 'link'),
  size: g.num({ min: 0, whole: true }),
  modifiedAt: g.timestamp(),
});

/** What undo needs to put a file back: its earlier content, or nothing if it didn't exist. */
const Previous = g.obj({ path: g.text(), previous: g.nullable(g.content()) });

/** The fs system's contract. */
export const fs = system('fs', { description: 'Files and a shell over chosen folders, served as resources. Can restart itself.' })
  .with({
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
        args: g.obj({ path: g.text(), text: g.text({ multiline: true }) }),
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
        returns: g.obj({ entries: g.list(Entry) }),
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
      bash: fn({
        description: 'Run a shell command in a root.',
        args: g.obj({ command: g.text(), cwd: g.optional(g.text()), timeout: g.optional(g.duration()) }),
        returns: g.obj({ exitCode: g.num(), stdout: g.text(), stderr: g.text() }),
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
    mentions: { files: mention({ title: 'Files', description: 'Files and folders under the roots.' }) },
  })
  // context and the agent use the fns declared above
  .with(({ fns }) => ({
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

/** The fs system's server settings. */
export interface FsConfig {
  /** The folders it serves and works in. Nothing outside them is reachable. */
  roots: Array<{ path: string; name: string; writable: boolean; index: 'all' | 'on-read' | 'none' }>;
  /** Its own source folder, so it can change itself and restart. */
  self?: string;
}
