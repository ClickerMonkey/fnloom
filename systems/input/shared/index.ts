/**
 * The input system's contract (`shared/`): forms the chat draws for the person to fill in. `get_input` is an authoring
 * fn: a form authoring agent on `ctx.ai()` (`server/authoring.ts`) looks for a saved `input/form` fn that fits and
 * reuses it, else writes a form's gin type through a forced workflow, checks it and keeps it as the person's own form.
 * The `ask_*` fns are the quick ones (a line of text, a choice, yes or no, a number, a date). Every input fn returns the
 * form and the model ends its turn: the person's answers come back as the next user message, in `<input-answer>` tags
 * the chat hides. A quick form the person liked is kept in the hub as an `input/form` fn (`save_form` through
 * `hub/save_fn`), so it is found next time.
 */
import { ActorId, GinTypeDef, Visibility } from '@harness/core';
import { type Infer, context, fn, g, ginAs, hub, kind, system } from '@harness/sdk';
import { z } from 'zod';
import { FIELD_TYPES } from './forms.ts';

/**
 * A form: its title, what it is for, the gin type of its answers (an object, one field per question) and its button.
 * The one shape of a form: the fns and the kind carry it as gin (`InputForm`).
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
  /** What the model does now: end its turn and wait for the answers (or, with nobody watching, go on without them). */
  next: g.text(),
  /** How to show the same form again directly (`input/trip_details({})`), when it is a saved one. */
  call: g.optional(g.text()),
});

/** What `save_form` gives: the new fn's name. */
export const SavedForm = g.obj({ fn: g.text(), name: g.text() });

/** What `check_form` gives. */
export const FormCheck = g.obj({
  ok: g.bool(),
  problems: g.list(g.text()),
  /** How many questions the form has. */
  fields: g.num({ min: 0, whole: true }),
});

/** What the model is told after asking: wait for the person. */
export const WAIT_FOR_ANSWERS = 'The form is shown to the person. End your turn now and wait: their answers arrive as the next user message, in <input-answer> tags.';

/**
 * What the model is told after asking in a run nobody is watching (a nested agent, an MCP call, a background run): the
 * form waits in the person's chat, so the caller must not wait for the answers.
 */
export const HEADLESS_ASKED = "Nobody is watching this run, so the form waits in the person's chat and the answers will not come back to you. Don't wait for them: go on with what you have, or end your run saying what you still need.";

/** The sentence an input fn answers with: wait for the person when one is watching, else don't. */
export function nextAfterAsking(watched: boolean | undefined): string {
  return watched === true ? WAIT_FOR_ANSWERS : HEADLESS_ASKED;
}

/** The kind of every saved form, qualified. */
export const FORM_KIND = 'input/form';

const question = () => g.field(g.text({ minLength: 1 }), { docs: 'The question, as the person reads it.' });

const status = (what: string) => ({
  active: { one: `Asking ${what}…`, many: `Asking ${what}…` },
  retry: { one: `Asking ${what} again…`, many: `Asking ${what} again…` },
  done: { one: 'Asked {output.form.title}', many: 'Asked {n} questions' },
  failed: { one: `Asking ${what} failed`, many: `{n} questions failed` },
});

const askUsage = (when: string, pitfall: string) => [
  `Use it ${when}. Ask only what you can't work out from the conversation, and put the question in plain words the person reads as is.`,
  pitfall,
  `For several questions at once use get_input instead. ${WAIT_FOR_ANSWERS}`,
].join(' ');

/** A trip form, as the examples write it. */
export const TRIP_FORM = {
  title: 'Trip details',
  description: 'Where and when you are going, and who with.',
  submit: 'Plan it',
  type: {
    name: 'obj',
    props: {
      city: { docs: 'Which city are you going to?', type: { name: 'text', options: { minLength: 1, maxLength: 100 } } },
      start: { docs: 'First day', type: { name: 'date' } },
      nights: { docs: 'How many nights?', type: { name: 'num', options: { min: 1, max: 60, whole: true } } },
      travellers: { docs: 'Who is coming?', type: { name: 'optional', generic: { T: { name: 'list', generic: { V: { name: 'text' } } } } } },
    },
  },
};

const WAITED = { next: WAIT_FOR_ANSWERS };

/**
 * How a form is written: its shape and every field type the chat draws, with the rules. The form authoring agent is
 * shown it a step at a time (`field_types`), not up front.
 */
export const FIELD_GUIDE = [
  'A form is { "title", "description", "submit" (optional button words), "type" }. Its type is a gin object type whose fields are the questions:',
  '{ "name": "obj", "props": { "<fieldName>": { "docs": "<the question the person reads>", "type": <field type> } } }',
  `Field types (only these: ${FIELD_TYPES.join(', ')}):`,
  '- text: { "name": "text", "options": { "minLength": 1, "maxLength": 200 } } (options optional)',
  '- number: { "name": "num", "options": { "min": 0, "max": 10, "whole": true } } (options optional)',
  '- yes or no: { "name": "bool" }',
  '- a date: { "name": "date" }; a date and time: { "name": "timestamp" }; a length of time: { "name": "duration" }',
  '- one of fixed options: { "name": "enum", "generic": { "V": { "name": "text" } }, "options": { "values": { "small": "small", "large": "large" } } }',
  '- several of something: { "name": "list", "generic": { "V": <item type> }, "options": { "minLength": 1 } }',
  '- not required: { "name": "optional", "generic": { "T": <field type> } }',
  '- a group of fields: a nested obj.',
  'Rules: camelCase field names; a clear question as every field\'s "docs"; optional for anything the person may skip; enums for fixed choices;',
  'only the fields the description asks for, in the order a person would answer them; a title of a few words.',
  '',
  'Example. Asked for "the trip: destination city (required), first day, number of nights (whole, 1 to 60) and who is coming (optional names)":',
  JSON.stringify(TRIP_FORM),
].join('\n');

/** What callers of `get_input` read. */
const GET_INPUT_USAGE = [
  'Use it when you need several pieces of information only the person has (trip details, a bug report, the fields of a record to add).',
  'Describe every field: what it is, its kind (text, number with its range, date, yes or no, one of given options, a list) and whether it is required.',
  'A saved form that asks the same is reused, so describe the information, not the wording. For one simple question use an ask_* fn instead.',
  `Don't ask for what the conversation already says. ${WAIT_FOR_ANSWERS}`,
].join(' ');

/** The input system's contract. */
export const input = system('input', {
  description: 'Ask the person for input with forms in the chat, made to fit what is needed, and keep good forms in the hub for next time.',
  // get_input's authoring agent is on a model; saved forms are hub fns it searches (the link's search), reads and saves
  grants: { hub: ['ai', 'fns', 'search'], calls: ['hub/fn_get', 'hub/save_fn'] },
})
  .with({
    kinds: {
      form: kind({
        description: 'A saved form: running it shows the form to the person, and their answers arrive as the next user message.',
        applicability: 'A form the person will be asked again (trip details, a bug report, a weekly check-in).',
        payload: InputForm,
        // a form only asks; saving one needs no approval
        approveChanges: false,
        // a form only asks the person, so its implementation says every run is free
        estimates: true,
        status: status('{fn}'),
      }),
    },
    fns: {
      check_form: fn({
        description: 'Check a draft form: whether gin accepts its type and the chat can draw every field, and what to fix.',
        instructions: 'Check a form before saving it with save_form (get_input checks its own). `ok` is true only with no problems; each problem says which field and how to fix it.',
        args: g.obj({ form: InputForm }),
        returns: FormCheck,
        examples: [
          { args: { form: TRIP_FORM }, result: { ok: true, problems: [], fields: 4 }, note: 'A form that passes.' },
          {
            args: { form: { title: 'Size', description: '', type: { name: 'obj', props: { size: { type: { name: 'color' } } } } } },
            result: { ok: false, problems: ['Field size uses the type "color"; use one of text, num, bool, enum, date, timestamp, duration, list, optional, obj.'], fields: 1 },
            note: 'A field type forms do not draw.',
          },
        ],
        visibility: 'llm',
        display: 'hidden',
        effects: { mode: 'read', free: true },
        tags: ['input', 'read'],
      }),
      ask_text: fn({
        description: 'Ask the person one question they answer in words.',
        instructions: askUsage('for a name, a description, an address or any free answer', 'Set `long` for a paragraph (a description, feedback), and a `placeholder` that shows the kind of answer wanted.'),
        args: g.obj({
          question: question(),
          placeholder: g.optional(g.text()),
          long: g.field(g.optional(g.bool()), { docs: 'A long answer (a paragraph) rather than a line.' }),
        }),
        returns: Asked,
        examples: [
          { args: { question: 'What should the new project be called?', placeholder: 'harness-docs' }, note: 'A one-line answer.' },
          { args: { question: 'What went wrong, and what did you expect instead?', long: true }, note: 'A paragraph.' },
        ],
        status: status('a question'),
        effects: { mode: 'read', free: true },
        tags: ['input'],
      }),
      ask_choice: fn({
        description: 'Ask the person to pick from options.',
        instructions: askUsage('when the answer is one (or, with `multiple`, some) of options you can list', 'Give at least two different, short options in a sensible order; add "Something else" only when an answer outside them is fine.'),
        args: g.obj({
          question: question(),
          options: g.list(g.text({ minLength: 1 }), { minLength: 2 }),
          multiple: g.field(g.optional(g.bool()), { docs: 'Let them pick more than one.' }),
        }),
        returns: Asked,
        examples: [
          { args: { question: 'Which database should I use?', options: ['Sales (Postgres)', 'Local notes (SQLite)'] }, note: 'One of two.' },
          { args: { question: 'Which days work for you?', options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], multiple: true }, note: 'Several.' },
        ],
        status: status('for a choice'),
        effects: { mode: 'read', free: true },
        tags: ['input'],
      }),
      ask_confirm: fn({
        description: 'Ask the person a yes or no question.',
        instructions: askUsage('before something they should agree to that no approval covers, or for any yes or no fact', 'Word it so "yes" means go ahead.'),
        args: g.obj({ question: question() }),
        returns: Asked,
        examples: [{ args: { question: 'Send the summary to the whole team?' } }],
        status: status('yes or no'),
        effects: { mode: 'read', free: true },
        tags: ['input'],
      }),
      ask_number: fn({
        description: 'Ask the person for a number.',
        instructions: askUsage('for a count, an amount or a rating', 'Give `min` and `max` when the answer has a range, and `whole` for counts.'),
        args: g.obj({ question: question(), min: g.optional(g.num()), max: g.optional(g.num()), whole: g.optional(g.bool()) }),
        returns: Asked,
        examples: [
          { args: { question: 'How many people are coming?', min: 1, max: 50, whole: true } },
          { args: { question: 'What budget should I keep to, in dollars?', min: 0 } },
        ],
        status: status('for a number'),
        effects: { mode: 'read', free: true },
        tags: ['input'],
      }),
      ask_date: fn({
        description: 'Ask the person for a date.',
        instructions: askUsage('for a day (a deadline, a start date, a birthday)', 'Say what the date is for in the question.'),
        args: g.obj({ question: question() }),
        returns: Asked,
        examples: [{ args: { question: 'When is the report due?' } }],
        status: status('for a date'),
        effects: { mode: 'read', free: true },
        tags: ['input'],
      }),
      save_form: fn({
        description: 'Keep a form in the hub as an `input/form` fn of its person, so get_input finds and reuses it next time.',
        instructions: 'The person saves a form from under it. Give a short name, a description of what it asks and when to use it, and who may use it (only them by default).',
        args: g.obj({
          name: g.field(g.text({ minLength: 1, maxLength: 60 }), { docs: 'A short name for it ("Trip details").' }),
          description: g.field(g.text({ minLength: 1 }), { docs: 'What it asks for and when to use it.' }),
          form: InputForm,
          askedFor: g.field(g.optional(g.text()), { docs: 'The description get_input made it for; kept as the saved fn\'s first example.' }),
          visibility: g.field(g.optional(ginAs(Visibility)), { docs: 'Who may use it: only you (`private`, the default), people you share it with, or everyone.' }),
          with: g.field(g.optional(ginAs(z.array(ActorId))), { docs: 'With `shared`: the people and groups (actor ids) who may use it.' }),
        }),
        returns: SavedForm,
        deps: { saveFn: hub.fns.save_fn },
        examples: [{
          args: { name: 'Trip details', description: 'Asks for a trip\'s city, first day, nights and travellers.', form: TRIP_FORM, askedFor: 'the trip: city, first day, nights and who is coming' },
          result: { fn: 'input/trip_details', name: 'Trip details' },
        }],
        // the person saves it from under the form; the model doesn't
        visibility: 'user',
        status: {
          active: { one: 'Saving {args.name}…', many: 'Saving {n} forms…' },
          retry: { one: 'Saving {args.name} again…', many: 'Saving {n} forms again…' },
          done: { one: 'Saved {args.name}', many: 'Saved {n} forms' },
          failed: { one: 'Saving {args.name} failed', many: '{n} forms were not saved' },
        },
        effects: { mode: 'write', free: true, registry: [{ thing: 'fns', action: 'create', kind: FORM_KIND }] },
        tags: ['input', 'write'],
      }),
    },
  })
  .with(() => ({
    fns: {
      get_input: fn({
        description: 'Ask the person for several pieces of information at once with a form made for it (or a saved one that fits): describe in detail what you need.',
        instructions: GET_INPUT_USAGE,
        args: g.obj({ detailedDescription: g.field(g.text({ minLength: 1 }), { docs: 'What to ask for: each field, its kind, and whether it is required.' }) }),
        returns: Asked,
        deps: { getFn: hub.fns.fn_get, saveFn: hub.fns.save_fn },
        examples: [
          {
            args: { detailedDescription: 'The trip: destination city (required), first day (date), number of nights (whole number, 1 to 60) and who is coming (optional list of names).' },
            result: { form: TRIP_FORM, saved: 'input/trip_details', call: 'input/trip_details({})', ...WAITED },
            note: 'A new form, written, checked and kept as the own form of the person, for next time.',
          },
          {
            args: { detailedDescription: 'A bug report: what happened (long text), what was expected (long text), how bad it is (low, medium or high) and whether it can be repeated (yes or no).' },
            note: 'Enums for fixed choices, long text for descriptions.',
          },
        ],
        status: status('for input'),
        // the form authoring agent is a model call of the run; a new form is kept as the person's own input/form fn
        effects: { mode: 'write', registry: [{ thing: 'fns', action: 'create', kind: FORM_KIND }] },
        tags: ['input'],
      }),
    },
  }))
  .with(({ fns }) => ({
    context: {
      guide: context({
        description: 'How to ask the person for input with forms.',
        content: [
          'When you need information only the person has, ask with a form instead of a question in your reply.',
          'Use an ask_* fn for one simple question, and get_input for several at once (describe each field in detail); a saved form that fits is reused.',
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
/** What `check_form` gives. */
export type FormCheckValue = Infer<typeof FormCheck>;
