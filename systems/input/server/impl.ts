/**
 * The input system's implementation. `get_input` reuses the best saved form the hub says the person may use now (by name, or by how
 * close its description's embedding is), else has the form agent write one; the `ask_*` fns make quick forms;
 * `save_form` keeps a form and adds it as an `input/form` fn at runtime; the `form` kind runs those fns. Every input
 * fn returns the form, which the chat draws; nothing here waits for the answers.
 */
import { qualify, type ActorId, type QualifiedName, type ShareRule, type Visibility } from '@harness/core';
import { encodeValue, g, parseValue, wireType, type AnyFnDef, type Llm, type SystemImpl } from '@harness/sdk';
import { Asked, WAIT_FOR_ANSWERS, input, type AskedValue, type InputContract, type InputFormValue } from '../shared/index.ts';
import { formProblems, quickForms } from '../shared/forms.ts';
import type { FormAuthor } from './author.ts';
import type { InputSettings } from './env.ts';
import type { FormStore, SavedRecord } from './store.ts';

/** Adds and removes fns at runtime (the running system's `add` and `remove`). */
export interface RuntimeFns {
  add(name: string, def: AnyFnDef): Promise<void>;
  /** Take back a fn `add` added (a save that couldn't be kept to its person). */
  remove(name: string): Promise<void>;
}

/** Everything the implementation is built from. */
export interface InputDeps {
  readonly settings: InputSettings;
  readonly store: FormStore;
  readonly author: FormAuthor;
  /** Where saved forms are added as fns; set once the system is serving. */
  readonly runtime: () => RuntimeFns | undefined;
  readonly now: () => number;
}

/** The implementation, and re-adding the saved forms once the system is serving. */
export interface InputServer {
  readonly impl: SystemImpl<InputContract['defs']>;
  /** Add every saved form as a fn again (after a restart). */
  restore(): Promise<number>;
}

/** Cosine similarity of two vectors; 0 when either is empty or their lengths differ. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) { return 0; }
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

/** A fn name from a form's name: `Trip details!` becomes `trip_details`. */
export function slugOf(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return slug === '' || /^[0-9]/.test(slug) ? `form_${slug}` : slug;
}

/**
 * A fn name for a new saved form: `base`, else `base_2`, `base_3`, … so it never takes the name of one of the
 * contract's fns or of a form already saved (the SDK refuses to add a fn twice).
 */
export function freeName(base: string, records: readonly Pick<SavedRecord, 'name'>[]): string {
  const taken = new Set([...Object.keys(input.defs.fns), ...records.map((record) => record.name)]);
  let name = base;
  for (let n = 2; taken.has(name); n += 1) { name = `${base}_${n}`; }
  return name;
}

/** The words a form is matched by. */
function matchText(record: Pick<SavedRecord, 'title' | 'description'>): string {
  return `${record.title}. ${record.description}`;
}

/** A text as a literal in a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Embed one text, or nothing when the hub has no embedder for it. */
async function embedOne(llm: Llm, text: string): Promise<number[]> {
  try {
    return (await llm.embed([text]))[0] ?? [];
  } catch {
    return [];
  }
}

/**
 * The saved form to reuse for a description: one whose title the description names, else the closest by embedding
 * at or above `threshold`.
 */
export function bestMatch(description: string, vector: readonly number[], records: readonly SavedRecord[], threshold: number): SavedRecord | undefined {
  const asked = description.toLowerCase();
  const named = records.find((record) => record.title.length >= 4 && new RegExp(`(^|\\W)${escapeRegExp(record.title.toLowerCase())}($|\\W)`).test(asked));
  if (named !== undefined) { return named; }
  let best: { record: SavedRecord; score: number } | undefined;
  for (const record of records) {
    const score = cosine(vector, record.vector);
    if (score >= threshold && (best === undefined || score > best.score)) { best = { record, score }; }
  }
  return best?.record;
}

const asked = (form: InputFormValue, saved?: QualifiedName): AskedValue => ({ form, next: WAIT_FOR_ANSWERS, ...(saved === undefined ? {} : { saved }) });

/** The kind fn a saved form becomes. */
function formFn(record: SavedRecord): AnyFnDef {
  return input.kinds.form.fn({ description: record.description, payload: record.form, tags: ['input'] });
}

/** Build the input implementation. */
export function createInputImpl(deps: InputDeps): InputServer {
  const s = deps.settings;

  /**
   * Save a form: add its fn, hand it to its person with who may use it (`share`), and only then keep it. A fn with no
   * access row is public, so until the hub has the person's rule the kind refuses to run it (it isn't kept yet), and
   * when the hub refuses the rule the fn is taken back, so a private form is never left open to everyone.
   */
  async function save(
    args: { name: string; description: string; form: InputFormValue; visibility: Visibility; with: readonly ActorId[] },
    owner: ActorId, llm: Llm, share: (name: string, rule: ShareRule) => Promise<void>,
  ): Promise<SavedRecord> {
    const records = await deps.store.all();
    const name = freeName(slugOf(args.name), records);
    const record: SavedRecord = {
      name, title: args.name.trim(), description: args.description.trim(), form: args.form, owner, visibility: args.visibility,
      with: args.visibility === 'shared' ? [...new Set(args.with)] : [],
      vector: await embedOne(llm, matchText({ title: args.name, description: args.description })), savedAt: deps.now(),
    };
    const runtime = deps.runtime();
    if (runtime === undefined) { throw new Error('The input system is not serving yet.'); }
    await runtime.add(name, formFn(record));
    try {
      await share(name, { visibility: record.visibility, with: record.with });
    } catch (error) {
      await runtime.remove(name);
      throw error;
    }
    await deps.store.put(record);
    return record;
  }

  const impl: SystemImpl<InputContract['defs']> = {
    fns: {
      get_input: {
        async run(args, ctx) {
          // who may reuse a form is the hub's to say: its owner or an admin may have changed it since it was saved
          const records = await deps.store.all();
          const allowed = new Set(await ctx.usableFns(records.map((record) => record.name)));
          const usable = records.filter((record) => allowed.has(record.name));
          if (usable.length > 0) {
            const vector = await embedOne(ctx.llm, args.detailedDescription);
            const match = bestMatch(args.detailedDescription, vector, usable, s.INPUT_REUSE_SCORE);
            if (match !== undefined) {
              ctx.log.info('input.reused', { form: match.name });
              return ctx.done(asked(match.form, qualify(input.name, match.name)));
            }
          }
          const written = await deps.author.write(args.detailedDescription, ctx.llm);
          if ('problems' in written) { return ctx.fail('retry', `The form agent couldn't write a valid form: ${written.problems.join(' ')}`, { code: 'form-refused' }); }
          ctx.log.info('input.written', { fields: Object.keys(written.type.props ?? {}).length });
          return ctx.done(asked(written));
        },
      },
      ask_text: { run: (args, ctx) => Promise.resolve(ctx.done(asked(quickForms.text(args)))) },
      ask_choice: {
        run: (args, ctx) => {
          const options = new Set(args.options.map((option) => option.trim()).filter((option) => option !== ''));
          return Promise.resolve(options.size < 2 ? ctx.invalid([{ path: 'options', message: 'Give at least two different options.' }]) : ctx.done(asked(quickForms.choice(args))));
        },
      },
      ask_confirm: { run: (args, ctx) => Promise.resolve(ctx.done(asked(quickForms.confirm(args)))) },
      ask_number: {
        run: (args, ctx) => Promise.resolve(args.min !== undefined && args.max !== undefined && args.min > args.max
          ? ctx.invalid([{ path: 'max', message: 'max is below min.' }])
          : ctx.done(asked(quickForms.number(args)))),
      },
      ask_date: { run: (args, ctx) => Promise.resolve(ctx.done(asked(quickForms.date(args)))) },
      save_form: {
        async run(args, ctx) {
          const problems = formProblems(args.form.type);
          if (problems.length > 0) { return ctx.invalid([{ path: 'form.type', message: problems.join(' ') }]); }
          const visibility = args.visibility ?? 'private';
          if (visibility === 'shared' && (args.with ?? []).length === 0) { return ctx.invalid([{ path: 'with', message: 'Name the people or groups to share it with.' }]); }
          // the person who saved it owns the new fn on the hub, which then keeps it to whom they chose
          const record = await save({ ...args, visibility, with: args.with ?? [] }, ctx.run.user.id, ctx.llm, (name, rule) => ctx.shareFn(name, rule));
          ctx.log.info('input.saved', { form: record.name, visibility: record.visibility });
          return ctx.done({ fn: qualify(input.name, record.name), name: record.title });
        },
      },
    },
    kinds: {
      form: {
        check: (payload) => Promise.resolve(formProblems(payload.type)),
        describe: () => Promise.resolve({
          args: wireType(g.obj({})),
          returns: wireType(Asked),
          deps: [],
          operations: { cancel: true, pause: false, undo: false, background: false },
        }),
        async run(payload, _args, ctx) {
          // a form is kept only once the hub has who may use it; until then (or if that failed) it is not offered
          const kept = (await deps.store.all()).some((record) => qualify(input.name, record.name) === ctx.run.fn);
          if (!kept) { return ctx.fail('caller', 'This form is still being saved, or its saving failed; try again in a moment.', { code: 'form-unsaved' }); }
          return ctx.done(encodeValue(Asked, asked(parseValue(input.kinds.form.payload, payload), ctx.run.fn)));
        },
      },
    },
  };

  return {
    impl,
    async restore() {
      const runtime = deps.runtime();
      if (runtime === undefined) { return 0; }
      const records = await deps.store.all();
      for (const record of records) { await runtime.add(record.name, formFn(record)); }
      return records.length;
    },
  };
}
