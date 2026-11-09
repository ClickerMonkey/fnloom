/**
 * The input system's contract (`shared/`): forms the chat draws for the person to fill in. `get_input` makes a form
 * for a detailed description (reusing a saved one that fits, else an agent writes its gin type); the `ask_*` fns are
 * the quick ones (a line of text, a choice, yes or no, a number, a date). Every input fn returns the form and the
 * model ends its turn: the person's answers come back as the next user message, in `<input-answer>` tags the chat
 * hides. A form the person liked is saved as an `input/form` fn (`save_form`), so it is offered by name next time.
 */
import { ActorId, GinTypeDef, Visibility } from '@harness/core';
import { type Infer, context, fn, g, ginAs, kind, system } from '@harness/sdk';
import { z } from 'zod';

/**
 * A form: its title, what it is for, the gin type of its answers (an object, one field per question) and its button.
 * The one shape of a form: the fns and the kind carry it as gin (`InputForm`), the saved-form store parses it with this.
 */
export const InputFormSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  type: GinTypeDef.describe('The answers\' gin type: an object whose fields are the questions (each field\'s docs is its label).'),
  submit: z.string().min(1).optional().describe('The submit button\'s words ("Send" when absent).'),
});

/** A form, as gin (`InputFormSchema`'s type). */
export const InputForm = ginAs(InputFormSchema);

/** What every input fn returns: the form to draw, and the saved form it came from, if any. */
export const Asked = g.obj({
  form: InputForm,
  /** The saved form's fn (`input/trip_details`) when one was reused. */
  saved: g.optional(g.text()),
  /** What the model does now: end its turn and wait for the answers. */
  next: g.text(),
});

/** What `save_form` gives: the new fn's name. */
export const SavedForm = g.obj({ fn: g.text(), name: g.text() });

/** What the model is told after asking: wait for the person. */
export const WAIT_FOR_ANSWERS = 'The form is shown to the person. End your turn now and wait: their answers arrive as the next user message, in <input-answer> tags.';

const question = () => g.field(g.text({ minLength: 1 }), { docs: 'The question, as the person reads it.' });

const status = (what: string) => ({
  active: { one: `Asking ${what}…`, many: `Asking ${what}…` },
  retry: { one: `Asking ${what} again…`, many: `Asking ${what} again…` },
  done: { one: 'Asked {output.form.title}', many: 'Asked {n} questions' },
  failed: { one: `Asking ${what} failed`, many: `{n} questions failed` },
});

const askInstructions = `Use it to ask the person something you can't work out yourself. ${WAIT_FOR_ANSWERS}`;

/** The input system's contract. */
export const input = system('input', { description: 'Ask the person for input with forms in the chat, made to fit what is needed, and keep good forms for next time.' })
  .with({
    kinds: {
      form: kind({
        description: 'A saved form: running it shows the form to the person, and their answers arrive as the next user message.',
        applicability: 'A form the person will be asked again (trip details, a bug report, a weekly check-in).',
        payload: InputForm,
        // a form only asks; saving one needs no approval
        approveChanges: false,
        status: status('{fn}'),
      }),
    },
    fns: {
      get_input: fn({
        description: 'Ask the person for several pieces of information at once with a form made for it: describe in detail what you need, and why.',
        instructions: `Describe every piece of information you need, its kind (text, number, date, choice of …, yes or no) and whether it is required. A saved form that fits is reused. For one simple question use an ask_* fn instead. ${WAIT_FOR_ANSWERS}`,
        args: g.obj({ detailedDescription: g.field(g.text({ minLength: 1 }), { docs: 'What to ask for: each field, its kind, and whether it is required.' }) }),
        returns: Asked,
        status: status('for input'),
        tags: ['input'],
      }),
      ask_text: fn({
        description: 'Ask the person one question they answer in words.',
        instructions: askInstructions,
        args: g.obj({
          question: question(),
          placeholder: g.optional(g.text()),
          long: g.field(g.optional(g.bool()), { docs: 'A long answer (a paragraph) rather than a line.' }),
        }),
        returns: Asked,
        status: status('a question'),
        tags: ['input'],
      }),
      ask_choice: fn({
        description: 'Ask the person to pick from options.',
        instructions: askInstructions,
        args: g.obj({
          question: question(),
          options: g.list(g.text({ minLength: 1 }), { minLength: 2 }),
          multiple: g.field(g.optional(g.bool()), { docs: 'Let them pick more than one.' }),
        }),
        returns: Asked,
        status: status('for a choice'),
        tags: ['input'],
      }),
      ask_confirm: fn({
        description: 'Ask the person a yes or no question.',
        instructions: askInstructions,
        args: g.obj({ question: question() }),
        returns: Asked,
        status: status('yes or no'),
        tags: ['input'],
      }),
      ask_number: fn({
        description: 'Ask the person for a number.',
        instructions: askInstructions,
        args: g.obj({ question: question(), min: g.optional(g.num()), max: g.optional(g.num()), whole: g.optional(g.bool()) }),
        returns: Asked,
        status: status('for a number'),
        tags: ['input'],
      }),
      ask_date: fn({
        description: 'Ask the person for a date.',
        instructions: askInstructions,
        args: g.obj({ question: question() }),
        returns: Asked,
        status: status('for a date'),
        tags: ['input'],
      }),
      save_form: fn({
        description: 'Save a form as a fn of this system, so it is offered by name next time.',
        args: g.obj({
          name: g.field(g.text({ minLength: 1, maxLength: 60 }), { docs: 'A short name for it ("Trip details").' }),
          description: g.field(g.text({ minLength: 1 }), { docs: 'What it asks for and when to use it.' }),
          form: InputForm,
          visibility: g.field(g.optional(ginAs(Visibility)), { docs: 'Who may use it: only you (`private`, the default), people you share it with, or everyone.' }),
          with: g.field(g.optional(ginAs(z.array(ActorId))), { docs: 'With `shared`: the people and groups (actor ids) who may use it.' }),
        }),
        returns: SavedForm,
        // the person saves it from under the form; the model doesn't
        visibility: 'user',
        status: {
          active: { one: 'Saving {args.name}…', many: 'Saving {n} forms…' },
          retry: { one: 'Saving {args.name} again…', many: 'Saving {n} forms again…' },
          done: { one: 'Saved {args.name}', many: 'Saved {n} forms' },
          failed: { one: 'Saving {args.name} failed', many: '{n} forms were not saved' },
        },
        tags: ['input', 'write'],
      }),
    },
  })
  .with(({ fns }) => ({
    context: {
      guide: context({
        description: 'How to ask the person for input with forms.',
        content: [
          'When you need information only the person has, ask with a form instead of a question in your reply.',
          'Use an ask_* fn for one simple question, and get_input for several at once (describe each field in detail).',
          'After asking, end your turn: the answers arrive as the next user message in <input-answer> tags. Use them; never ask the same thing twice.',
        ].join(' '),
        fns: [fns.get_input, fns.ask_text, fns.ask_choice, fns.ask_confirm, fns.ask_number, fns.ask_date],
        tags: ['input'],
      }),
    },
  }));

/** The input contract's type. */
export type InputContract = typeof input;
/** A form. */
export type InputFormValue = Infer<typeof InputForm>;
/** What an input fn returns. */
export type AskedValue = Infer<typeof Asked>;
/** What `save_form` gives. */
export type SavedFormValue = Infer<typeof SavedForm>;
