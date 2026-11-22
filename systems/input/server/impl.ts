/**
 * The input system's implementation. `get_input` runs the form authoring agent (`authoring.ts`) on the run's
 * `ctx.ai()` and keeps a new form as the person's own `input/form` fn; here too are `check_form`, the `ask_*` fns that make quick forms, `save_form`, which keeps a form in the hub as
 * an `input/form` fn of its person (`hub/save_fn`), and the `form` kind that runs those fns. Nothing is stored here:
 * saved forms, their embeddings and who may use them are the hub's. Every input fn returns the form, which the chat
 * draws; nothing here waits for the answers.
 */
import type { ActorId, Json, RunInfo, ShareRule } from '@harness/core';
import { CallFailed, SAVE_FN_TAKEN, encodeValue, g, parseValue, sampleOf, wireType, type FnCtx, type SystemImpl, type TypesOf } from '@harness/sdk';
import { AuthoringError } from '@harness/sdk/server';
import { Asked, FORM_KIND, WAIT_FOR_ANSWERS, input, nextAfterAsking, type AskedValue, type InputContract, type InputFormValue } from '../shared/index.ts';
import { fieldsOf, formProblems, quickForms } from '../shared/forms.ts';
import { FormAuthoring, checkForm, formAuthoring } from './authoring.ts';
import type { InputSettings } from './env.ts';

/** Everything the implementation is built from. */
export interface InputDeps {
  readonly settings: InputSettings;
}

/** A fn name from a form's name: `Trip details!` becomes `trip_details`. */
export function slugOf(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return slug === '' || /^[0-9]/.test(slug) ? `form_${slug}` : slug;
}

/**
 * The name to try a saved form under on its `attempt`th try (0 first): `base`, else `base_2`, `base_3`, …, never one
 * of the contract's own fns.
 */
export function nameFor(base: string, attempt: number): string {
  const own = new Set(Object.keys(input.defs.fns));
  const first = own.has(base) ? `${base}_form` : base;
  return attempt === 0 ? first : `${first}_${attempt + 1}`;
}

/** An input fn's answer: the form, the saved form it came from, and what the caller does next (by whether anyone watches). */
const asked = (ctx: { run: RunInfo }, form: InputFormValue, saved?: string): AskedValue => ({ form, next: nextAfterAsking(ctx.run), ...(saved === undefined ? {} : { saved }) });

/** `hub/save_fn` as a run of `save_form` or `get_input` calls it. */
type SaveFn = FnCtx<TypesOf<InputContract['defs']['fns']['save_form']>>['fns']['saveFn'];

/** What keeping a form needs: its name, what it asks, the form, what it was made for and who may use it. */
interface KeepForm {
  readonly name: string;
  readonly description: string;
  readonly form: InputFormValue;
  readonly askedFor?: string | undefined;
  readonly share: ShareRule;
}

/** The form as its kind's payload reads it, or undefined when it isn't one. */
function readForm(payload: Json | undefined): InputFormValue | undefined {
  try {
    return parseValue(input.kinds.form.payload, payload ?? null);
  } catch {
    return undefined;
  }
}

/** Whether a hub fn failed because the name is taken. */
function taken(error: unknown): boolean {
  return error instanceof CallFailed && error.error.class !== 'cancelled' && error.error.code === SAVE_FN_TAKEN;
}

/**
 * Keep a form in the hub as an `input/form` fn of the run's person, under its name's slug or the next free one
 * (`trip_details`, `trip_details_2`, …); undefined when every name tried is taken. The hub embeds it for search,
 * its first example the description it was made for.
 */
async function keepForm(saveFn: SaveFn, keep: KeepForm, tries: number): Promise<{ fn: string; version: number } | undefined> {
  const base = slugOf(keep.name);
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const saved = await saveFn({
        kind: FORM_KIND,
        name: nameFor(base, attempt),
        description: keep.description.trim(),
        instructions: `Shows the "${keep.form.title}" form to the person. ${WAIT_FOR_ANSWERS}`,
        payload: encodeValue(input.kinds.form.payload, keep.form),
        examples: [{ args: {}, ...(keep.askedFor === undefined ? {} : { note: `Made for: ${keep.askedFor}` }) }],
        tags: ['input'],
        share: keep.share,
      });
      return { fn: saved.fn, version: saved.version };
    } catch (error) {
      if (!taken(error)) { throw error; }
    }
  }
  return undefined;
}

/** Build the input implementation. */
export function createInputImpl(deps: InputDeps): SystemImpl<InputContract['defs']> {
  const s = deps.settings;
  return {
    fns: {
      check_form: {
        run(args, ctx) {
          const problems = checkForm(args.form, s.INPUT_MAX_FIELDS);
          return Promise.resolve(ctx.done({ ok: problems.length === 0, problems, fields: fieldsOf(args.form.type).length }));
        },
      },
      ask_text: { run: (args, ctx) => Promise.resolve(ctx.done(asked(ctx, quickForms.text(args)))) },
      ask_choice: {
        run: (args, ctx) => {
          const options = new Set(args.options.map((option) => option.trim()).filter((option) => option !== ''));
          return Promise.resolve(options.size < 2 ? ctx.invalid([{ path: 'options', message: 'Give at least two different options.' }]) : ctx.done(asked(ctx, quickForms.choice(args))));
        },
      },
      ask_confirm: { run: (args, ctx) => Promise.resolve(ctx.done(asked(ctx, quickForms.confirm(args)))) },
      ask_number: {
        run: (args, ctx) => Promise.resolve(args.min !== undefined && args.max !== undefined && args.min > args.max
          ? ctx.invalid([{ path: 'max', message: 'max is below min.' }])
          : ctx.done(asked(ctx, quickForms.number(args)))),
      },
      ask_date: { run: (args, ctx) => Promise.resolve(ctx.done(asked(ctx, quickForms.date(args)))) },
      save_form: {
        async run(args, ctx) {
          const problems = formProblems(args.form.type);
          if (problems.length > 0) { return ctx.invalid([{ path: 'form.type', message: problems.join(' ') }]); }
          const visibility = args.visibility ?? 'private';
          const shareWith: ActorId[] = visibility === 'shared' ? [...new Set(args.with ?? [])] : [];
          if (visibility === 'shared' && shareWith.length === 0) { return ctx.invalid([{ path: 'with', message: 'Name the people or groups to share it with.' }]); }
          const kept = await keepForm(ctx.fns.saveFn, { name: args.name, description: args.description, form: args.form, askedFor: args.askedFor, share: { visibility, with: shareWith } }, s.INPUT_NAME_TRIES);
          if (kept === undefined) { return ctx.fail('caller', `Every name tried for "${args.name}" is taken; give it another name.`, { code: SAVE_FN_TAKEN }); }
          ctx.log.info('input.saved', { form: kept.fn, visibility });
          return ctx.done({ fn: kept.fn, name: args.name.trim() });
        },
      },
      get_input: {
        async run(args, ctx) {
          const state = new FormAuthoring({
            search: (query) => ctx.searchFns(query),
            getFn: async (fn) => await ctx.fns.getFn({ fn }),
            readForm,
            maxFields: s.INPUT_MAX_FIELDS,
            keep: async (form, askedFor) => {
              // a new form is the person's own until they share it from under the form
              const kept = await keepForm(ctx.fns.saveFn, { name: form.title, description: form.description === '' ? form.title : form.description, form, askedFor, share: { visibility: 'private', with: [] } }, s.INPUT_NAME_TRIES);
              if (kept === undefined) { throw new Error(`Every name tried for "${form.title}" is taken; give the form another title.`); }
              return kept;
            },
          });
          // #region authoring-run
          try {
            const { result } = await formAuthoring.run(await ctx.ai(), args.detailedDescription, state);
            const form = state.form;
            if (form === undefined) { return ctx.fail('caller', `The form authoring agent kept ${result.fn} without its form.`); }
            return ctx.done({ ...asked(ctx, form, result.fn), call: result.call });
          } catch (error) {
            if (!(error instanceof AuthoringError)) { throw error; }
            const last = error.problems.length === 0 ? '' : ` Its last problems: ${error.problems.join(' ')}`;
            return ctx.fail('caller', `No form was made: ${error.message}${last} Describe the fields differently or more exactly.`);
          }
          // #endregion authoring-run
        },
      },
    },
    kinds: {
      form: {
        // showing a form calls no model: free, whatever the payload
        estimate: (_payload, input) => Promise.resolve({ min: 0, typical: 0, max: 0, basis: 'free', runs: input.history?.runs ?? 0 }),
        check: (payload) => Promise.resolve(formProblems(payload.type)),
        describe: (payload) => Promise.resolve({
          args: wireType(g.obj({})),
          returns: wireType(Asked),
          deps: [],
          operations: { cancel: true, pause: false, undo: false, background: false },
          // called with nothing: the example shows what a filled form answers
          examples: [{ args: {}, note: `Shows the form "${payload.title}". The person's answers come in their next message, filled like ${JSON.stringify(sampleOf(payload.type))}.` }],
        }),
        run: (payload, _args, ctx) => Promise.resolve(ctx.done(encodeValue(Asked, asked(ctx, parseValue(input.kinds.form.payload, payload), ctx.run.fn)))),
      },
    },
  };
}
