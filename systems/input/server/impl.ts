/**
 * The input system's implementation. `get_input` is an agent the hub runs (its prompt and tools are in the contract);
 * here are its tool `check_form`, the `ask_*` fns that make quick forms, `save_form`, which keeps a form in the hub as
 * an `input/form` fn of its person (`hub/save_fn`), and the `form` kind that runs those fns. Nothing is stored here:
 * saved forms, their embeddings and who may use them are the hub's. Every input fn returns the form, which the chat
 * draws; nothing here waits for the answers.
 */
import type { ActorId } from '@harness/core';
import { CallFailed, SAVE_FN_TAKEN, encodeValue, g, parseValue, wireType, type SystemImpl } from '@harness/sdk';
import { Asked, FORM_KIND, WAIT_FOR_ANSWERS, input, type AskedValue, type InputContract, type InputFormValue } from '../shared/index.ts';
import { fieldsOf, formProblems, quickForms } from '../shared/forms.ts';
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

const asked = (form: InputFormValue, saved?: string): AskedValue => ({ form, next: WAIT_FOR_ANSWERS, ...(saved === undefined ? {} : { saved }) });

/** Whether a hub fn failed because the name is taken. */
function taken(error: unknown): boolean {
  return error instanceof CallFailed && error.error.class !== 'cancelled' && error.error.code === SAVE_FN_TAKEN;
}

/** Build the input implementation. */
export function createInputImpl(deps: InputDeps): SystemImpl<InputContract['defs']> {
  const s = deps.settings;
  return {
    fns: {
      check_form: {
        run(args, ctx) {
          const problems = formProblems(args.form.type);
          const fields = fieldsOf(args.form.type).length;
          if (problems.length === 0 && fields > s.INPUT_MAX_FIELDS) { problems.push(`A form has at most ${s.INPUT_MAX_FIELDS} fields; this one has ${fields}. Ask for less, or split it.`); }
          if (args.form.title.trim() === '') { problems.push('Give the form a title of a few words.'); }
          return Promise.resolve(ctx.done({ ok: problems.length === 0, problems, fields }));
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
          const shareWith: ActorId[] = visibility === 'shared' ? [...new Set(args.with ?? [])] : [];
          if (visibility === 'shared' && shareWith.length === 0) { return ctx.invalid([{ path: 'with', message: 'Name the people or groups to share it with.' }]); }
          const base = slugOf(args.name);
          // the hub keeps it as the person's fn, embedded for search, its first example the description it was made for
          for (let attempt = 0; attempt < s.INPUT_NAME_TRIES; attempt += 1) {
            try {
              const saved = await ctx.fns.saveFn({
                kind: FORM_KIND,
                name: nameFor(base, attempt),
                description: args.description.trim(),
                instructions: `Shows the "${args.form.title}" form to the person. ${WAIT_FOR_ANSWERS}`,
                payload: encodeValue(input.kinds.form.payload, args.form),
                examples: [{ args: {}, ...(args.askedFor === undefined ? {} : { note: `Made for: ${args.askedFor}` }) }],
                tags: ['input'],
                share: { visibility, with: shareWith },
              });
              ctx.log.info('input.saved', { form: saved.fn, visibility });
              return ctx.done({ fn: saved.fn, name: args.name.trim() });
            } catch (error) {
              if (!taken(error)) { throw error; }
            }
          }
          return ctx.fail('caller', `Every name tried for "${args.name}" is taken; give it another name.`, { code: SAVE_FN_TAKEN });
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
        run: (payload, _args, ctx) => Promise.resolve(ctx.done(encodeValue(Asked, asked(parseValue(input.kinds.form.payload, payload), ctx.run.fn)))),
      },
    },
  };
}
