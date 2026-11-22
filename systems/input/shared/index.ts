/**
 * The input system's contract (`shared/`): forms the chat draws for the person to fill in. `get_input` is an authoring
 * fn: a form authoring agent on `ctx.ai()` (`server/authoring.ts`) looks for a saved `input/form` fn that fits and
 * reuses it, else writes a form's gin type through a forced workflow, checks it and keeps it as the person's own form.
 * The `ask_*` fns are the quick ones (a line of text, a choice, yes or no, a number, a date). Every input fn returns the
 * form and the model ends its turn: the person's answers come back as the next user message, in `<input-answer>` tags
 * the chat hides. A quick form the person liked is kept in the hub as an `input/form` fn (`save_form` through
 * `hub/fns_save`), so it is found next time.
 */
import { ActorId, GinObjTypeDef, Visibility } from '@harness/core';
import { type Infer, agents, context, fn, g, ginAs, hub, kind, system } from '@harness/sdk';
import { z } from 'zod';
import { FIELD_TYPES } from './forms.ts';

/**
 * A form: its title, what it is for, the gin type of its answers (an object, one field per question) and its button.
 * The one shape of a form: the fns and the kind carry it as gin (`InputForm`).
 */
export const InputFormSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  type: GinObjTypeDef.describe('The answers\' gin type: an object whose fields are the questions (each field\'s docs is its label).'),
  submit: z.string().min(1).optional().describe('The submit button\'s words ("Send" when absent).'),
});

/** A form, as gin (`InputFormSchema`'s type). */
export const InputForm = ginAs(InputFormSchema);

/** What every input fn returns: the form to draw, and the saved form it came from, if any. */
export const Asked = g.obj({
  form: InputForm,
  /** The saved form's fn (`input/trip_details`) when one was reused. */
  saved: g.optional(g.text()),
  /** What the model does now: end its turn, the answers coming back as the next message (or, in a run that is not the chat's own, go on without them). */
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

/**
 * What the chat agent is told after asking (`RunInfo.inChat`): end the turn; the answers come back as the next user
 * message whenever the person sends the form, now or after they next open the chat.
 */
export const WAIT_FOR_ANSWERS = 'The form is in the person\'s chat. End your turn now without answering for them: their answers arrive as the next user message, in <input-answer> tags, whenever they send it.';

/**
 * What the model is told after asking in a run that is not the chat's own (a nested agent's call, an MCP call, a
 * background run): the form waits in the person's chat and its answers go to the chat, never back to this caller.
 */
export const HEADLESS_ASKED = "This run is not the chat's own (a nested agent, a background run or an MCP call), so the form waits in the person's chat and its answers go to the chat, not back to you. Don't wait for them: go on with what you have, or end your run saying what you still need.";

/** The sentence an input fn answers with: end the turn and wait in the chat's own run, else go on without the answers. */
export function nextAfterAsking(run: { readonly inChat?: boolean | undefined }): string {
  return run.inChat === true ? WAIT_FOR_ANSWERS : HEADLESS_ASKED;
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
  `It shows the person a one-question form in the chat. Use it ${when}.`,
  'Ask only what you can\'t work out from the conversation or look up with your tools, and write the question in plain words: the person reads it exactly as you write it.',
  pitfall,
  'For two or more questions at once use input/get_input instead (one form, not several in a row). A quick question you can also just ask in your reply, without a form.',
  `It returns the form it showed and \`next\`, which says what to do now. ${WAIT_FOR_ANSWERS}`,
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
  '- one of fixed options: { "name": "enum", "generic": { "V": { "name": "text" } }, "options": { "values": { "small": "Small", "large": "Large" } } }',
  '  (each entry is "<key>": "<the words the person reads>"; the answer is the key, so use plain lowercase keys)',
  '- several of something: { "name": "list", "generic": { "V": <item type> }, "options": { "minLength": 1 } }',
  '- not required: { "name": "optional", "generic": { "T": <field type> } }',
  '- a group of fields: a nested obj.',
  'Rules: camelCase field names; a clear question as every field\'s "docs"; optional for anything the person may skip; enums for fixed choices;',
  'only the fields the description asks for, in the order a person would answer them; a title of a few words.',
  'An amount or count the person may not know yet (a price, a budget, a quantity) is an optional number, its question saying it can be left empty:',
  '{ "name": "optional", "generic": { "T": { "name": "num", "options": { "min": 0 } } } }',
  '',
  'Example. Asked for "the trip: destination city (required), first day, number of nights (whole, 1 to 60) and who is coming (optional names)":',
  JSON.stringify(TRIP_FORM),
].join('\n');

/** What callers of `get_input` read. */
const GET_INPUT_USAGE = [
  'Use it when you need two or more pieces of information that only the person has (trip details, a bug report, the fields of a row to add to a table) and they are easier to give as fields than in a reply.',
  'Ask only the essentials first: the few answers you need for a useful first plan or entry, not every detail that could help. You can ask for more later.',
  'In `detailedDescription`, describe every field: what it is, its kind (text, long text, a number with its range, a date, yes or no, one of fixed options you list, a list of things) and whether it is required.',
  'Fixed choices (a vote, a size, low/medium/high) become an option field: list the options. An amount or quantity the person may not know yet is an optional number.',
  'It first looks for a saved form that asks the same things and reuses it, so describe the information, not the wording. Otherwise it writes a form, checks it and saves it as an `input/form` fn of the person (named like input/trip_details), so the same form can be shown again later by calling that fn by name.',
  'It returns the form it showed, `saved` (the saved form\'s fn), `call` (how to show it again) and `next` (what to do now).',
  'Showing a form only asks: the answers come back to you, and nothing stores them, sends them on or reminds anyone unless you then do that with other fns.',
  'If the person only wants a form ready for later, say it is saved and how to open it again rather than asking them to fill it now.',
  `For one simple question use an input/ask_* fn instead. Don't ask for what the conversation already says. ${WAIT_FOR_ANSWERS}`,
].join(' ');

/** The input system's contract. */
export const input = system('input', {
  description: 'Ask the person for input with forms in the chat, made to fit what is needed, and keep good forms in the hub for next time.',
  about: [
    'Forms in the chat: when you need information only the person has, this system shows them a small form to fill in, right in the conversation.',
    'Its fns: input/get_input shows a form with several typed fields, made from your description (or a saved form that already asks the same); input/ask_text, input/ask_choice, input/ask_confirm, input/ask_number and input/ask_date each ask one question.',
    'Its fn kind is input/form: every form get_input makes is saved as a fn of that kind (such as input/trip_details), and calling that fn by name later shows the same form again, so the person can fill in the same thing each time (log a grocery trip, a weekly check-in).',
    'After you show any form, end your turn: the answers come back as the person\'s next message, inside an <input-answer> block.',
    'A form only asks: it stores the answers nowhere by itself (keep them with another system, such as a database table), it never sends itself or reminds anyone later, and it gives nobody else access to anything.',
    'Not every question needs a form: a quick one you can just ask in your reply, and hub/ask_user asks a plain text question that pauses your run until it is answered. Load input/guide before your first form.',
  ].join(' '),
  // its API groups: the hub indexes its fns by them (`input/api`, `input/api.<group>`)
  groups: [
    { name: 'ask', title: 'Ask', description: 'Ask the person one quick question: text, a choice, a yes or no, a number or a date.' },
    { name: 'forms', title: 'Forms', description: 'Find or write a form for what is needed, check it and keep it in the hub for next time.' },
  ],
  // get_input's authoring agent is on a model; saved forms are hub fns it searches (the link's search), reads and saves
  grants: { hub: ['ai', 'fns', 'search'], calls: ['hub/fns_get', 'hub/fns_save'] },
})
  .with({
    kinds: {
      form: kind({
        description: 'A saved form: a title and a set of typed questions. Running it (by its name, with no args) shows the form to the person in the chat; their answers arrive as their next message, in an <input-answer> block. It stores, sends or schedules nothing by itself.',
        applicability: 'A form the person will fill in again (trip details, a bug report, a weekly check-in). input/get_input makes one from a description and saves it; to show it again, call it by name.',
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
        group: 'forms',
        description: 'Check a form object you wrote yourself, without showing it: whether its type is valid and the chat can draw every field, and what to fix.',
        instructions: 'You rarely need it: input/get_input writes and checks its own forms. Use it only when you hold a form object (title, description, type) and want to know it is valid before saving it. `ok` is true only with no problems; each problem says which field is wrong and how to fix it.',
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
        group: 'ask',
        description: 'Show the person a one-question form they answer in words; the answer comes in their next message.',
        instructions: askUsage('for one free answer in words (a name, an address, a description)', 'Set `long: true` for a paragraph (a description, feedback), and a `placeholder` that shows the kind of answer wanted.'),
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
        group: 'ask',
        description: 'Show the person a one-question form where they pick one (or several) of the options you give; the answer comes in their next message.',
        instructions: askUsage('when the answer is one (or, with `multiple: true`, some) of options you can list', 'Give at least two different, short options in a sensible order; add "Something else" only when an answer outside them is fine. The answer is the option\'s words as you wrote them.'),
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
        group: 'ask',
        description: 'Show the person a one-question yes-or-no form; the answer comes in their next message.',
        instructions: askUsage('for one yes-or-no answer (a fact, or agreeing to something no approval card already asks about)', 'Word it so "yes" means go ahead. A fn that changes things asks for approval on its own when it needs to: don\'t ask again before calling it.'),
        args: g.obj({ question: question() }),
        returns: Asked,
        examples: [{ args: { question: 'Send the summary to the whole team?' } }],
        status: status('yes or no'),
        effects: { mode: 'read', free: true },
        tags: ['input'],
      }),
      ask_number: fn({
        group: 'ask',
        description: 'Show the person a one-question form for a number; the answer comes in their next message.',
        instructions: askUsage('for one number (a count, an amount, a rating)', 'Give `min` and `max` when the answer has a range, and `whole: true` for counts. Say the unit in the question ("in dollars").'),
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
        group: 'ask',
        description: 'Show the person a one-question form for a date; the answer comes in their next message.',
        instructions: askUsage('for one day (a deadline, a start date, a birthday)', 'Say what the date is for in the question. When the date follows from the conversation and the person\'s local time (today, "last Saturday"), work it out instead of asking.'),
        args: g.obj({ question: question() }),
        returns: Asked,
        examples: [{ args: { question: 'When is the report due?' } }],
        status: status('for a date'),
        effects: { mode: 'read', free: true },
        tags: ['input'],
      }),
      save_form: fn({
        group: 'forms',
        description: 'Keep a form in the hub as an `input/form` fn of its person, so input/get_input finds and reuses it next time and it can be shown again by its name.',
        instructions: 'The person saves a quick form with the button under it; forms input/get_input makes are saved already. Give a short name, a description of what it asks and when to use it, and who may use it (only them by default).',
        args: g.obj({
          name: g.field(g.text({ minLength: 1, maxLength: 60 }), { docs: 'A short name for it ("Trip details").' }),
          description: g.field(g.text({ minLength: 1 }), { docs: 'What it asks for and when to use it.' }),
          form: InputForm,
          askedFor: g.field(g.optional(g.text()), { docs: 'The description get_input made it for; kept as the saved fn\'s first example.' }),
          visibility: g.field(g.optional(ginAs(Visibility)), { docs: 'Who may use it: only you (`private`, the default), people you share it with, or everyone.' }),
          with: g.field(g.optional(ginAs(z.array(ActorId))), { docs: 'With `shared`: the people and groups (actor ids) who may use it.' }),
        }),
        returns: SavedForm,
        deps: { saveFn: hub.fns.fns_save },
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
        group: 'forms',
        description: 'Show the person one form with several typed fields, made for what you describe (or a saved form that already asks it), saved as an input/form fn for next time; the answers come in their next message.',
        instructions: GET_INPUT_USAGE,
        args: g.obj({ detailedDescription: g.field(g.text({ minLength: 1 }), { docs: 'What to ask for: each field, its kind, and whether it is required.' }) }),
        returns: Asked,
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        examples: [
          {
            args: { detailedDescription: 'The trip: destination city (required), first day (date), number of nights (whole number, 1 to 60) and who is coming (optional list of names).' },
            result: { form: TRIP_FORM, saved: 'input/trip_details', call: 'input/trip_details({})', ...WAITED },
            note: 'A new form, written, checked and kept as the own form of the person, for next time.',
          },
          {
            args: { detailedDescription: 'A bug report: what happened (long text), what was expected (long text), how bad it is (low, medium or high) and whether it can be repeated (yes or no).' },
            note: 'Fixed choices as options, long text for descriptions.',
          },
          {
            args: { detailedDescription: 'A grocery trip to log: the store (text, required), the date (required), the total spent in dollars (optional number, 0 or more: they may not have the receipt) and a note (optional long text).' },
            note: 'An amount that may be unknown is an optional number.',
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
        description: 'How to ask the person for information with forms in the chat, and how forms are saved and shown again.',
        content: [
          '# Asking the person with forms',
          '',
          'A form is a small set of questions drawn in the chat, each with its own input (a text box, a number, a date picker, options to pick). Use one when you need information only the person has and it is easier to give as fields than in a reply.',
          '',
          'Pick the lightest way to ask:',
          '- One quick question you can word in a sentence: just ask it in your reply.',
          '- One question with a typed answer (a number, a date, one of some options, yes or no, a line of text): input/ask_number, input/ask_date, input/ask_choice, input/ask_confirm or input/ask_text.',
          '- Two or more answers at once: input/get_input, with a detailed description of each field. Ask only the essentials first.',
          '- hub/ask_user is not a form: it asks a plain text question and pauses your run until it is answered. Use it when you need the answer before your next step in the same turn.',
          '',
          'Steps with input/get_input:',
          '1. Call it with `detailedDescription`: every field, its kind and whether it is required. Example args: {"detailedDescription":"The trip: destination city (required), first day (date), number of nights (whole number, 1 to 60) and who is coming (optional list of names)."}',
          '2. It reuses a saved form that asks the same, or writes a new one and saves it as an input/form fn of the person (such as input/trip_details). The result has `saved` (that fn) and `call` (how to show it again).',
          '3. End your turn, saying briefly what the form is for. Never answer it for the person or guess the answers.',
          '4. Their answers arrive as their next message, in an <input-answer title="…"> block of `field: value` lines. Use them; never ask the same thing again.',
          '',
          'Showing a saved form again: call its fn by name with no args (input/trip_details with {}). Find a saved form with hub/fns_search and a few words of what it asks.',
          '',
          'What a form does not do: it does not store the answers (put them in a database table or another system once they arrive, and say where), it does not send itself to anyone, it does not run or remind on a schedule, and it gives nobody else access.',
        ].join('\n'),
        fns: [fns.get_input, fns.ask_text, fns.ask_choice, fns.ask_confirm, fns.ask_number, fns.ask_date],
        tags: ['input'],
      }),
      // what every chat agent is told about forms, in its system prompt (plan injected-context, section 5)
      basics: context({
        title: 'Forms',
        description: 'When and how to ask the person with a form, and how their answers come back in <input-answer>.',
        summary: 'For several typed details, show a form with input/get_input, then end your turn; the answers come back in <input-answer>.',
        content: [
          'A **form** (the input system) asks the person for several typed fields at once, drawn in the chat. Make one with input/get_input from a plain description of each field, or ask one typed question (a number, a date, a choice, yes or no, a line of text) with input/ask_number, input/ask_date, input/ask_choice, input/ask_confirm or input/ask_text.',
          'Use a form when you need several details, or ones with a type (dates, amounts, choices); a quick question still goes in your answer.',
          'Forms are saved fns of the person (such as input/trip_details): call one by its name with no args to show the same form again another time, such as a form to add an entry to something they keep.',
          'After showing a form, end your turn without answering for the person; the result\'s `next` says the same. Their answers arrive as their next message, inside `<input-answer>`, whenever they send it, even if they are not in the chat now. The person filled them in: treat them as their reply.',
          'A form only asks: it stores the answers nowhere by itself, sends nothing and reminds nobody. Load input/guide before your first form.',
        ].join('\n'),
        fns: [fns.get_input],
        tags: ['input'],
        inject: { into: [agents.startingWith(hub.fns.chat)] },
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
