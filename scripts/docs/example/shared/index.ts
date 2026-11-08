/**
 * The notes system's contract: titled notes with tags, kept per instance in its data folder. It is the authoring guide's
 * worked example, so it uses one of nearly everything a contract can declare: config, a named type with a method, a
 * setting, an attachment, a kind, native fns (undo, handlers, progress, pause and resume, session state, a form),
 * context, a hook, a mention provider, an action and an agent.
 */
import {
  type Infer, type ValueOf, action, agent, arg, attachment, context, fn, g, handler, hook, hub, kind, linear, mention, setting, steps, system, type,
} from '@harness/sdk';

// #region note-type
/** A note: a titled text with tags. A named type, so other systems can use it as a field and mentions show it. */
export const Note = type({
  description: 'A note: a titled text with tags.',
  shape: g.obj({
    id: g.text({ minLength: 1 }),
    title: g.text({ minLength: 1 }),
    text: hub.types.LongText,
    tags: g.list(g.text()),
    pinned: g.bool(),
    updatedAt: g.timestamp(),
  }),
  // chips and cards name a note by its title, with its id under it
  display: { label: 'Note', plural: 'Notes', icon: 'note', color: '#d9a400', title: 'title', subtitle: 'id' },
  methods: {
    // offered on a note's mention card; people and code can call it, the LLM can't (`visibility: 'user'`)
    pin: fn({ description: 'Pin or unpin this note.', args: g.obj({ pinned: g.bool() }), returns: g.bool(), visibility: 'user' }),
  },
});
// #endregion note-type

// #region shapes
/** What undo needs to put a note back: the note as it was, or null when there was none. */
export const Before = g.obj({ id: g.text(), note: g.nullable(Note.shape) });

/** The search `find` ran last in this session, kept in session state so a later `find` can repeat it. */
export const LastSearch = g.obj({ lastQuery: g.text() });

/** A person's answer to `review`: the form its renderer submits and the fn's result. */
export const Review = g.obj({ approved: g.bool(), note: g.optional(g.text()) });

/** The payload of a `notes/stamp` fn: the title and tags every note it adds gets. */
export const Stamp = g.obj({ title: g.text({ minLength: 1 }), tags: g.list(g.text()) });

/** The args of every `notes/stamp` fn: the note's text. */
export const StampArgs = g.obj({ text: g.text({ minLength: 1 }) });
// #endregion shapes

// #region contract
/** The notes system's contract. */
export const notes = system('notes', { description: 'Notes: write, find and tidy titled notes with tags.' })
  .with({
    // #region config
    // what the system needs before it can be used; an admin sets it in the hub, and `ctx.config` has it, typed
    config: g.obj({
      maxNotes: g.field(g.num({ min: 1, whole: true }), { docs: 'The most notes kept; adding one more is refused.' }),
      defaultTags: g.list(g.text()),
    }),
    // #endregion config
    types: { Note },
    // #region setting
    settings: {
      editing: setting({
        description: 'Whether removing a note asks first.',
        type: g.obj({ confirmRemove: g.bool() }),
        appliesTo: ['user', 'group'],
        merge: 'most-restrictive',
      }),
    },
    // #endregion setting
    attachments: {
      note: attachment({ description: 'A note, drawn as a card.', data: Note.shape }),
    },
    // #region kind
    kinds: {
      stamp: kind({
        description: 'A fn that adds a note with a fixed title and tags; its args are the text.',
        applicability: 'Use for quick capture: a journal, an inbox, a standing list.',
        payload: Stamp,
        // declaring or changing a stamp fn at runtime needs no approval: it can only add notes
        approveChanges: false,
      }),
    },
    // #endregion kind
    fns: {
      // #region fn-add
      add: fn({
        description: 'Add a note.',
        instructions: 'Give it a short title. Tags are lowercase words; the config adds its default tags.',
        args: g.obj({
          title: g.text({ minLength: 1 }),
          text: hub.types.LongText,
          tags: g.optional(g.list(g.text())),
        }),
        returns: Note.shape,
        // example calls agents see on its card and when they get its args wrong; a wrong example doesn't compile
        examples: [{ args: { title: 'Groceries', text: 'Milk, eggs, bread.', tags: ['home'] }, note: 'A short title and lowercase tags.' }],
        // declaring an undo type makes it undoable, and the server must implement `undo`
        undo: Before,
        status: {
          active: { one: 'Adding {args.title}…', many: 'Adding {n} notes…' },
          retry: { one: 'Retrying adding {args.title}…', many: 'Retrying {n} notes…' },
          done: { one: 'Added {output.title}', many: 'Added {n} notes' },
          failed: { one: 'Adding {args.title} failed', many: '{n} notes failed' },
        },
      }),
      // #endregion fn-add
      // #region fn-find
      find: fn({
        description: 'Find notes by words in their title or text, or by tag.',
        args: g.obj({
          query: g.optional(g.text()),
          tag: g.optional(g.text()),
          limit: g.optional(g.num({ min: 1, max: 50, whole: true })),
        }),
        returns: g.obj({ notes: g.list(Note.shape), total: g.num({ min: 0, whole: true }) }),
        // reads and writes `lastQuery` in the session's state; only fns that declare it see it
        state: LastSearch,
        progress: linear,
        // a read fn: it changes nothing, so policies can let it run without asking
        tags: ['read'],
        examples: [{ args: { query: 'release plan' } }, { args: { tag: 'work', limit: 5 }, note: 'The five newest notes tagged work.' }],
      }),
      // #endregion fn-find
      // #region fn-remove
      remove: fn({
        description: 'Delete a note.',
        args: g.obj({ id: g.text({ minLength: 1 }) }),
        returns: g.obj({ removed: g.bool() }),
        undo: Before,
        handlers: {
          // optional: a caller that can't answer may still call; the fn must check before calling it
          confirm: handler({ description: 'Delete this note?', args: g.obj({ title: g.text() }), returns: g.bool(), required: false }),
        },
      }),
      // #endregion fn-remove
      // #region fn-tidy
      tidy: fn({
        description: 'Merge tags that differ only in case or spaces, across every note.',
        args: g.obj({}),
        returns: g.obj({ merged: g.num({ min: 0, whole: true }) }),
        progress: steps({ scan: 'Read every note', merge: 'Merge the tags', save: 'Save the notes' }),
        // declaring a resume type makes it pausable: it returns this when paused and gets it back on resume
        resume: g.obj({ saved: g.num({ min: 0, whole: true }) }),
      }),
      // #endregion fn-tidy
      // #region fn-review
      review: fn({
        description: 'Ask the person to approve a note before it is shared. Returns their decision.',
        args: g.obj({ id: g.text({ minLength: 1 }) }),
        returns: Review,
        // the run waits in `await ctx.form()` until the renderer submits this
        form: Review,
        // once answered, the card turns into a plain message
        display: 'message',
      }),
      // #endregion fn-review
    },
    // #region hook
    hooks: { pinned: hook({ description: 'Adds the titles of pinned notes to each message.', order: 60, timeout: 300 }) },
    // #endregion hook
    // #region action
    actions: {
      pin: action({ description: 'Pin or unpin a note from its card.', input: g.obj({ id: g.text(), pinned: g.bool() }), returns: g.bool() }),
    },
    // #endregion action
  })
  // #region with-refs
  // declarations that use refs declared above go in a later `.with`, given a function of the refs so far
  .with(({ fns, types, kinds }) => ({
    // #region context-decl
    context: {
      guide: context({
        description: 'How to keep notes here: search before adding, short titles, lowercase tags.',
        content: 'Search with notes/find before adding a note, so you do not add one twice. Keep titles short and tags lowercase.',
        fns: [fns.find, fns.add],
        // for the graph contextor: how much it counts, a short form for tight budgets, and what it relates to
        weight: 1.2,
        summary: 'Search before adding; short titles; lowercase tags.',
        links: [{ to: types.Note, relation: 'about' }, { to: fns.tidy, relation: 'suggests', weight: 0.3 }],
      }),
      // no `content`: dynamic, so the server makes the text; the command is `/notes [tag]`
      recent: context({
        description: 'The newest notes, optionally with one tag.',
        command: { name: 'notes', args: { tag: arg('Only notes with this tag', { required: false }) } },
      }),
    },
    // #endregion context-decl
    // #region mention-decl
    mentions: {
      // `@` in the chat finds notes; chips and cards show them as Note (its label, icon, color and its pin method)
      notes: mention({ title: 'Notes', description: 'Any note, by its title.', target: g.obj({ id: g.text() }), of: types.Note }),
    },
    // #endregion mention-decl
    fns: {
      // a fn of the stamp kind: only its payload; the kind's `describe` works out the rest
      inbox: kinds.stamp.fn({
        description: 'Capture a thought in the inbox.',
        payload: { title: 'Inbox', tags: ['inbox'] },
        args: StampArgs,
        returns: Note.shape,
      }),
    },
  }))
  // #region agent
  .with(({ fns, context: ctx }) => ({
    fns: {
      // an agent: a fn of the hub's `llm` kind with instructions, tools and context
      librarian: agent({
        description: 'Answers questions from the notes, quoting their titles.',
        args: g.obj({ question: g.text() }),
        returns: g.text(),
        instructions: 'Answer {{args.question}} from the notes. Quote the titles you used. Say so when no note covers it.',
        tools: [fns.find, hub.fns.ask_user],
        context: [ctx.guide],
      }),
      // #region fn-publish
      // calls other fns through its deps, by ref: its own system's `review` and the hub's `ask_user`
      publish: fn({
        description: 'Share a note once the person approves it.',
        args: g.obj({ id: g.text({ minLength: 1 }) }),
        returns: g.obj({ published: g.bool(), note: g.optional(g.text()) }),
        deps: { review: fns.review, ask: hub.fns.ask_user },
      }),
      // #endregion fn-publish
    },
  }));
  // #endregion agent
// #endregion with-refs
// #endregion contract

// #region value-types
/** The notes contract's type. */
export type NotesContract = typeof notes;
/** A note, as fns return it. */
export type NoteValue = ValueOf<typeof Note>;
/** What undo needs to put a note back. */
export type BeforeValue = Infer<typeof Before>;
/** A person's answer to `review`. */
export type ReviewValue = Infer<typeof Review>;
/** A stamp fn's payload. */
export type StampValue = Infer<typeof Stamp>;
// #endregion value-types
