/**
 * The notes system's implementation: every fn, method, kind, dynamic context, hook, mention, action and resource the
 * contract declares, built from injected dependencies (`NotesDeps`) so tests run it with an in-memory store and a fixed
 * clock. Its type is computed from the contract: leaving anything out, or adding anything undeclared, doesn't compile.
 */
import type { ResourceStat, ResourceUri, UndoOutcome } from '@harness/core';
import { encodeValue, parseValue, wireType, type HookContribution, type ResourceProvider, type SystemImpl } from '@harness/sdk';
import { Note, StampArgs, notes, type BeforeValue, type NoteValue } from '../shared/index.ts';
import type { NotesSettings } from './env.ts';
import type { NoteStore, NotesConfig, OpenStore } from './index.ts';

// #region deps
/** Everything the implementation is built from. */
export interface NotesDeps {
  readonly settings: NotesSettings;
  /** Opens an instance's store from its data folder. */
  readonly open: OpenStore;
  readonly now: () => Date;
  /** A new note id. */
  readonly newId: () => string;
}
// #endregion deps

/** Tags as stored: trimmed, lowercase, each once. */
export function cleanTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ''))];
}

/** Whether a note matches words (all of them, in its title or text) and a tag. */
function matches(note: NoteValue, query: string | undefined, tag: string | undefined): boolean {
  const haystack = `${note.title}\n${note.text}`.toLowerCase();
  const words = (query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
  return words.every((word) => haystack.includes(word)) && (tag === undefined || note.tags.includes(tag.toLowerCase()));
}

/** A note as markdown, for resources and context. */
function markdownOf(note: NoteValue): string {
  return `# ${note.title}\n\n${note.text}\n\n${note.tags.map((tag) => `#${tag}`).join(' ')}`.trimEnd();
}

const ROOT: ResourceUri = 'notes://all/';
const uriOf = (id: string): ResourceUri => `notes://all/${encodeURIComponent(id)}`;
const idOf = (uri: ResourceUri): string | undefined => (uri.startsWith(ROOT) && uri.length > ROOT.length ? decodeURIComponent(uri.slice(ROOT.length)) : undefined);
const statOf = (note: NoteValue): ResourceStat => ({
  uri: uriOf(note.id), name: note.title, type: 'record', format: 'markdown', mime: 'text/markdown', modifiedAt: note.updatedAt.getTime(), version: String(note.updatedAt.getTime()),
});

/** Build the notes implementation. */
export function createNotesImpl(deps: NotesDeps): SystemImpl<(typeof notes)['defs']> {
  const s = deps.settings;
  // the store of the instance that started last, for the resource provider (which gets no context)
  let current: NoteStore | undefined;

  // #region undo-helper
  /** Put a note back as it was before a change: delete it if it didn't exist, else restore it. */
  async function restore(store: NoteStore, before: BeforeValue): Promise<UndoOutcome> {
    if (before.note === null) {
      return (await store.delete(before.id)) ? { status: 'undone', summary: `Removed note ${before.id} again.` } : { status: 'gone' };
    }
    await store.put(before.note);
    return { status: 'undone', summary: `Restored "${before.note.title}".` };
  }
  // #endregion undo-helper

  /** A new note, or undefined when the store is full. */
  async function create(store: NoteStore, config: NotesConfig, input: { title: string; text: string; tags: readonly string[] }): Promise<NoteValue | undefined> {
    if ((await store.all()).length >= config.maxNotes) { return undefined; }
    const note: NoteValue = { id: deps.newId(), title: input.title.trim(), text: input.text, tags: cleanTags([...config.defaultTags, ...input.tags]), pinned: false, updatedAt: deps.now() };
    await store.put(note);
    return note;
  }

  const full = (config: NotesConfig) => `There are already ${config.maxNotes} notes, the most this system keeps. Remove one first.`;

  // #region impl-resources
  const resources: ResourceProvider = {
    roots: () => Promise.resolve([{ uri: ROOT, name: 'Notes', description: 'Every note, as markdown.', index: 'all', ignore: [], watch: false }]),
    async list(uri) {
      if (uri !== ROOT || current === undefined) { return { items: [] }; }
      return { items: (await current.all()).map(statOf) };
    },
    async stat(uri) {
      const id = idOf(uri);
      const note = id === undefined ? undefined : await current?.get(id);
      return note === undefined ? undefined : statOf(note);
    },
    async read(uri) {
      const id = idOf(uri);
      const note = id === undefined ? undefined : await current?.get(id);
      if (note === undefined) { throw new Error(`There is no note at ${uri}.`); }
      return { stat: statOf(note), text: { inline: markdownOf(note) } };
    },
  };
  // #endregion impl-resources

  return {
    fns: {
      // #region impl-add
      add: {
        async run(args, ctx) {
          const store = deps.open(ctx.dataDir);
          const note = await create(store, ctx.config, { title: args.title, text: args.text, tags: args.tags ?? [] });
          // a real refusal, not a mistake in the args: `fail` with the `caller` class and a stable code
          if (note === undefined) { return ctx.fail('caller', full(ctx.config), { code: 'full' }); }
          ctx.attach(notes.attachments.note, note, `Added ${note.title}`);
          // the undo payload is typed by the contract's `undo` type
          return ctx.done(note, { undo: { id: note.id, note: null } });
        },
        undo: (payload, ctx) => restore(deps.open(ctx.dataDir), payload),
      },
      // #endregion impl-add
      // #region impl-find
      find: {
        async run(args, ctx) {
          // `find` declared `state: LastSearch`, so it sees `lastQuery` and nothing else
          const query = args.query ?? (await ctx.state.get()).lastQuery;
          if (query === undefined && args.tag === undefined) {
            // the caller's mistake: an agent gets the problem back and tries again
            return ctx.invalid([{ path: 'query', message: 'Give a query or a tag; there is no earlier search to repeat.' }]);
          }
          const all = await deps.open(ctx.dataDir).all();
          const found: NoteValue[] = [];
          // about twenty updates whatever the size: each one travels to the hub and on to the chat
          const every = Math.max(1, Math.floor(all.length / 20));
          all.forEach((note, index) => {
            if (matches(note, query, args.tag)) { found.push(note); }
            if ((index + 1) % every === 0) { ctx.progress.set((index + 1) / all.length, `${found.length} found`); }
          });
          if (query !== undefined) { await ctx.state.set({ lastQuery: query }); }
          return ctx.done({ notes: found.slice(0, args.limit ?? s.NOTES_FIND_LIMIT), total: found.length });
        },
      },
      // #endregion impl-find
      // #region impl-remove
      remove: {
        async run(args, ctx) {
          const store = deps.open(ctx.dataDir);
          const note = await store.get(args.id);
          if (note === undefined) { return ctx.invalid([{ path: 'id', message: `There is no note ${args.id}.` }]); }
          // the effective setting for the run's person, merged with their groups'
          const editing = await ctx.setting(notes.settings.editing);
          if (editing?.confirmRemove === true) {
            // `confirm` is optional, so the compiler makes the fn check it is there
            if (ctx.handlers.confirm === undefined) { return ctx.fail('caller', 'Removing a note asks first, and this caller cannot answer.', { code: 'denied' }); }
            if (!(await ctx.handlers.confirm({ title: note.title }))) { return ctx.cancelled(); }
          }
          await store.delete(note.id);
          return ctx.done({ removed: true }, { undo: { id: note.id, note } });
        },
        undo: (payload, ctx) => restore(deps.open(ctx.dataDir), payload),
      },
      // #endregion impl-remove
      // #region impl-tidy
      tidy: {
        async run(_args, ctx) {
          const store = deps.open(ctx.dataDir);
          // a resumed run starts where it paused
          let saved = ctx.resume?.state.saved ?? 0;
          // asked to pause: say where to resume from; the run settles as paused and `ctx.signal` aborts
          ctx.onPause(() => ({ saved }));
          ctx.progress.step('scan', 'active');
          const all = await store.all();
          ctx.progress.step('scan', 'done', `${all.length} notes`);
          ctx.progress.step('merge', 'active');
          const changed = all.flatMap((note) => {
            const tags = cleanTags(note.tags);
            return tags.join('\n') === note.tags.join('\n') ? [] : [{ ...note, tags, updatedAt: deps.now() }];
          });
          ctx.progress.step('merge', 'done', `${changed.length} to change`);
          ctx.progress.step('save', 'active');
          for (const note of changed.slice(saved)) {
            if (ctx.signal.aborted) { return ctx.cancelled({ partial: { merged: saved } }); }
            await store.put(note);
            saved += 1;
          }
          ctx.progress.step('save', 'done');
          return ctx.done({ merged: changed.length });
        },
      },
      // #endregion impl-tidy
      // #region impl-review
      review: {
        async run(args, ctx) {
          const note = await deps.open(ctx.dataDir).get(args.id);
          if (note === undefined) { return ctx.invalid([{ path: 'id', message: `There is no note ${args.id}.` }]); }
          ctx.attach(notes.attachments.note, note, note.title);
          // waits for the renderer's submit; the hub keeps it if the system is offline meanwhile
          return ctx.done(await ctx.form());
        },
      },
      // #endregion impl-review
      // #region impl-publish
      publish: {
        async run(args, ctx) {
          // a call is awaitable for its typed result; `key` names it, so a resumed run gets the answer back
          const decision = await ctx.fns.review({ id: args.id }, { key: 'review' });
          if (!decision.approved) { return ctx.done({ published: false, ...(decision.note === undefined ? {} : { note: decision.note }) }); }
          // `settled` never throws: it says how the call ended
          const where = await ctx.fns.ask({ question: 'Where should the note be shared?' }).settled;
          const note = where.status === 'done' ? where.result.answer : undefined;
          return ctx.done({ published: true, ...(note === undefined ? {} : { note }) });
        },
      },
      // #endregion impl-publish
    },
    // #region impl-method
    types: {
      Note: {
        pin: {
          async run(self, args, ctx) {
            const store = deps.open(ctx.dataDir);
            const note = await store.get(self.id);
            if (note === undefined) { return ctx.invalid([{ path: 'self', message: `Note ${self.id} no longer exists.` }]); }
            await store.put({ ...note, pinned: args.pinned, updatedAt: deps.now() });
            return ctx.done(args.pinned);
          },
        },
      },
    },
    // #endregion impl-method
    // #region impl-kind
    kinds: {
      stamp: {
        // problems beyond the payload's type
        check: (payload) => Promise.resolve(payload.tags.filter((tag) => tag !== tag.toLowerCase()).map((tag) => `Tag "${tag}" must be lowercase.`)),
        // everything else about a stamp fn, worked out from its payload
        describe: () => Promise.resolve({
          args: wireType(StampArgs),
          returns: wireType(Note.shape),
          deps: [],
          operations: { cancel: true, pause: false, undo: false, background: true },
        }),
        async run(payload, args, ctx) {
          // a kind's args arrive as JSON the hub checked against `describe`; read them with the same gin type
          const input = parseValue(StampArgs, args);
          const note = await create(deps.open(ctx.dataDir), ctx.config, { title: payload.title, text: input.text, tags: payload.tags });
          if (note === undefined) { return ctx.fail('caller', full(ctx.config), { code: 'full' }); }
          return ctx.done(encodeValue(Note.shape, note));
        },
      },
    },
    // #endregion impl-kind
    // #region impl-context
    context: {
      recent: async (args, ctx) => {
        const all = await deps.open(ctx.dataDir).all();
        const shown = all.filter((note) => args.tag === undefined || note.tags.includes(args.tag.toLowerCase())).slice(0, s.NOTES_FIND_LIMIT);
        if (shown.length === 0) { return args.tag === undefined ? 'There are no notes yet.' : `No note has the tag "${args.tag}".`; }
        return shown.map(markdownOf).join('\n\n---\n\n');
      },
    },
    // #endregion impl-context
    // #region impl-hook
    hooks: {
      pinned: async (input, ctx) => {
        const pinned = (await deps.open(ctx.dataDir).all()).filter((note) => note.pinned).slice(0, s.NOTES_HOOK_TITLES);
        const blocks: HookContribution[] = [];
        if (pinned.length > 0) { blocks.push({ type: 'text', tag: 'pinned-notes', text: `Pinned notes: ${pinned.map((note) => `"${note.title}"`).join(', ')}.` }); }
        if (/\bnotes?\b/i.test(input.text)) { blocks.push({ type: 'suggest-context', items: [{ context: notes.context.guide, why: 'The message is about notes.' }] }); }
        return blocks;
      },
    },
    // #endregion impl-hook
    // #region impl-mention
    mentions: {
      notes: {
        async search(query, ctx) {
          return (await deps.open(ctx.dataDir).all())
            .filter((note) => matches(note, query, undefined))
            .slice(0, 20)
            .map((note) => ({ label: note.title, hint: note.tags.join(', '), icon: 'note', target: { id: note.id } }));
        },
        async hover(target, ctx) {
          const note = await deps.open(ctx.dataDir).get(target.id);
          if (note === undefined) { return undefined; }
          // returning the value as a Note lets the card offer Note's `pin` method
          return { title: note.title, subtitle: note.tags.join(', '), body: note.text.slice(0, 280), open: { resource: uriOf(note.id) }, value: note };
        },
        async llm(target, ctx) {
          const note = await deps.open(ctx.dataDir).get(target.id);
          if (note === undefined) { return `Note ${target.id} no longer exists.`; }
          return `Note "${note.title}" (id ${note.id}) in the notes system:\n\n${markdownOf(note)}`;
        },
      },
    },
    // #endregion impl-mention
    // #region impl-action
    actions: {
      pin: async (input, ctx) => {
        const store = deps.open(ctx.dataDir);
        const note = await store.get(input.id);
        if (note === undefined) { return false; }
        await store.put({ ...note, pinned: input.pinned, updatedAt: deps.now() });
        return true;
      },
    },
    // #endregion impl-action
    resources,
    // #region impl-lifecycle
    lifecycle: {
      started: async (ctx) => {
        current = deps.open(ctx.dataDir);
        ctx.log.info('notes.started', { notes: (await current.all()).length, instance: ctx.instance });
      },
      configured: (ctx) => {
        ctx.log.info('notes.configured', { maxNotes: ctx.config.maxNotes, before: ctx.previous?.maxNotes ?? null });
        return Promise.resolve();
      },
    },
    // #endregion impl-lifecycle
  };
}
