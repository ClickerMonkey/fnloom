/**
 * The form authoring agent behind `get_input`, on the SDK's `authoringAgent` (product's type agent, ported for forms):
 * the chat model only describes what it needs to ask; this agent works through a forced workflow on `ctx.ai()` and the
 * chat gets back the form, the saved fn it is kept as and how to show it again, never the working context.
 *
 * - **find:** `find_forms` searches the saved forms the person may use (the hub's search); `use_saved` answers with
 *   one that asks the same things.
 * - **inspect (progressive disclosure):** `field_types` shows the form shape and the field types the chat draws, and
 *   `load_form` one saved form, to adapt it.
 * - **draft → check → fix:** the draft is a typed form (its type a gin object of the field types the chat draws); each draft is checked (gin accepts it,
 *   the chat can draw every field, a title, not too many fields).
 * - **save:** the clean form is kept in the hub as the person's own `input/form` fn, so the next request reuses it.
 */
import type { Json, FnSearchPage, FnSearchQuery } from '@harness/core';
import { expectType, type Equal } from '@harness/sdk';
import { authoringAgent, authoringTool, type AuthoredFn, type AuthoringSession } from '@harness/sdk/server';
import { z } from 'zod';
import { InputFormSchema, FIELD_GUIDE, FORM_KIND, PROJECT_FORM, type InputFormValue } from '../shared/index.ts';
import { fieldsOf, formProblems, type FIELD_TYPES } from '../shared/forms.ts';


/** A saved form as `hub/fns_get` gives it (the parts the agent reads). */
export interface StoredForm {
  readonly fn: string;
  readonly kind: string;
  readonly version: number;
  readonly payload?: Json | undefined;
}

/** What a form authoring run needs from its run: the hub's search and saved fns as its person, and keeping a form. */
export interface FormAuthoringDeps {
  search(query: FnSearchQuery): Promise<FnSearchPage>;
  getFn(fn: string): Promise<StoredForm>;
  /** The form as its kind's payload, or why it isn't one. */
  readForm(payload: Json | undefined): InputFormValue | undefined;
  /** Keep a clean form as the person's own form fn: its name and version. */
  keep(form: InputFormValue, askedFor: string): Promise<{ fn: string; version: number }>;
  /** The most fields a form may have. */
  readonly maxFields: number;
}

/** One form authoring run's state: its deps, and the form it ended with. */
export class FormAuthoring {
  readonly deps: FormAuthoringDeps;
  #form: InputFormValue | undefined;

  constructor(deps: FormAuthoringDeps) {
    this.deps = deps;
  }

  /** The form saved or reused, once there is one. */
  get form(): InputFormValue | undefined {
    return this.#form;
  }

  chose(form: InputFormValue): void {
    this.#form = form;
  }
}

/** A form's problems, as `check_form` and the agent's check both say them. */
export function checkForm(form: InputFormValue, maxFields: number): string[] {
  const problems = formProblems(form.type);
  const fields = fieldsOf(form.type).length;
  if (problems.length === 0 && fields > maxFields) { problems.push(`A form has at most ${maxFields} fields; this one has ${fields}. Ask for less, or split it.`); }
  if (problems.length === 0 && fields === 0) { problems.push('The form asks nothing: give its type at least one field.'); }
  if (form.title.trim() === '') { problems.push('Give the form a title of a few words.'); }
  return problems;
}

/** The agent's job, step by step, with a worked example. */
const INSTRUCTIONS = [
  'You make the one form that asks a person for what the request below describes, and nothing else. A form is drawn in a chat: a title, a short description, and one input per question. You work only through your tools, in order; each step unlocks the next, and you finish by saving (or reusing) a form.',
  '',
  '1. find_forms with a few plain words for what is asked: {"text":"project details"}. A saved form that asks for the same things (the same fields, not just a similar name) is the answer: call use_saved with its name, {"fn":"input/project_details"}, and stop.',
  '2. field_types (args {}) to see how a form is written; load_form {"fn":"…"} shows a saved form find_forms listed, when you adapt it.',
  '3. draft the whole form. The draft tool takes ONE arg, `draft`, holding the whole form: {"draft":{"title":…,"description":…,"submit":…,"type":{"name":"obj","props":{…}}}}.',
  '   Only the fields the request asks for, each with a clear question as its "docs"; optional where the person may skip it; enums for fixed choices; an amount that may be unknown as an optional number.',
  '4. The draft is checked at once. If it lists problems, each names the field and what is wrong: change only that, and call draft again with the whole form. Never send the same draft twice.',
  '5. Once the check says it is clean, call save (args {}). Then answer in one line.',
  'If the request can\'t be a form (it asks for no information), or the checks keep failing, stop and answer in one line saying why.',
  '',
  'Example. For "the project: its name (required), who owns it (required), the due date, the priority (low, medium or high) and notes (optional)" the draft call is:',
  JSON.stringify({ draft: PROJECT_FORM }),
].join('\n');

// #region authoring-tool
/** `find_forms`: the saved forms the person may use that may fit. */
const findForms = authoringTool<FormAuthoring, FormDraft, { text: string }>({
  name: 'find_forms',
  stage: 'find',
  description: 'Search the saved forms the person may use by what the request asks for.',
  instructions: 'Call it first, with what is asked in a few plain words.',
  schema: z.object({ text: z.string().min(1).describe('What the form asks for, in plain words.') }),
  async call({ text }, session) {
    const page = await session.state.deps.search({ text, kinds: [FORM_KIND], items: ['fn'], limit: 6 });
    session.disclosure.markSearched('fn');
    session.disclosure.markAware('fn', page.items.map((hit) => hit.name));
    session.disclosure.markAware('guide', ['fields']);
    return page.items.length === 0
      ? 'No saved form fits. See how forms are written with field_types.'
      : ['Saved forms that may fit:', ...page.items.map((hit) => `- ${hit.name}: ${hit.description}`)].join('\n');
  },
});
// #endregion authoring-tool

/** `use_saved`: a saved form asks the same things; it is the answer as it is. */
const useSaved = authoringTool<FormAuthoring, FormDraft, { fn: string }>({
  name: 'use_saved',
  stage: 'find',
  description: 'Answer with a saved form find_forms listed that asks for the same things.',
  schema: z.object({ fn: z.string().min(1) }),
  when: (session) => session.disclosure.searched('fn') && (session.disclosure.awareUnloaded('fn').length > 0 || session.disclosure.loaded('fn').length > 0),
  async call({ fn }, session) {
    const deps = session.state.deps;
    if (!session.disclosure.awareUnloaded('fn').includes(fn) && !session.disclosure.isLoaded('fn', fn)) { throw new Error(`${fn} was not listed by find_forms.`); }
    const stored = await deps.getFn(fn);
    const form = stored.kind === FORM_KIND ? deps.readForm(stored.payload) : undefined;
    if (form === undefined) { throw new Error(`${fn} is not a saved form.`); }
    session.state.chose(form);
    const result: AuthoredFn = { fn: stored.fn, version: stored.version, signature: `${stored.fn}()`, about: form.description === '' ? form.title : form.description, reused: true, call: `${stored.fn}({})` };
    session.finish(result);
    return `Using ${stored.fn}. Now answer in one line.`;
  },
});

/** `field_types`: how a form is written and the field types the chat draws, once. */
const fieldTypes = authoringTool<FormAuthoring, FormDraft, Record<string, never>>({
  name: 'field_types',
  stage: 'inspect',
  description: 'Show how a form is written: its shape, every field type the chat draws, the rules, and an example.',
  schema: z.object({}),
  when: (session) => !session.disclosure.isLoaded('guide', 'fields'),
  call(_input, session) {
    session.disclosure.markLoaded('guide', ['fields']);
    return FIELD_GUIDE;
  },
});

/** `load_form`: a saved form find_forms listed, to adapt it. */
const loadForm = authoringTool<FormAuthoring, FormDraft, { fn: string }>({
  name: 'load_form',
  stage: 'inspect',
  description: 'Show a saved form find_forms listed, to adapt it.',
  schema: z.object({ fn: z.string().min(1) }),
  when: (session) => session.disclosure.awareUnloaded('fn').length > 0,
  async call({ fn }, session) {
    const deps = session.state.deps;
    const form = deps.readForm((await deps.getFn(fn)).payload);
    if (form === undefined) { throw new Error(`${fn} is not a saved form.`); }
    session.disclosure.markLoaded('fn', [fn]);
    return `${fn}: ${JSON.stringify(form)}`;
  },
});

/** A field type as the agent drafts it: one of the gin types the chat draws (`FIELD_TYPES`), nested by list, optional and obj. */
export type FieldTypeDraft =
  | { name: 'text'; options?: { minLength?: number | undefined; maxLength?: number | undefined } | undefined }
  | { name: 'num'; options?: { min?: number | undefined; max?: number | undefined; whole?: boolean | undefined } | undefined }
  | { name: 'bool' | 'date' | 'timestamp' | 'duration' }
  | { name: 'enum'; generic: { V: { name: 'text' } }; options: { values: Record<string, string> } }
  | { name: 'list'; generic: { V: FieldTypeDraft }; options?: { minLength?: number | undefined; maxLength?: number | undefined } | undefined }
  | { name: 'optional'; generic: { T: FieldTypeDraft } }
  | { name: 'obj'; props: Record<string, { docs?: string | undefined; type: FieldTypeDraft }> };

const lengths = z.object({ minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(1).optional() }).optional();

/**
 * The typed schema of a form field's gin type. It is written here rather than taken from gin's `buildSchemas`, whose
 * lazy schemas are rebuilt on every visit, so the SDK wire's zod JSON Schema never ends (see the report's LIBRARY GAP).
 */
const FieldType: z.ZodType<FieldTypeDraft> = z.lazy(() => z.union([
  z.object({ name: z.literal('text'), options: lengths }),
  z.object({ name: z.literal('num'), options: z.object({ min: z.number().optional(), max: z.number().optional(), whole: z.boolean().optional() }).optional() }),
  z.object({ name: z.enum(['bool', 'date', 'timestamp', 'duration']) }),
  z.object({ name: z.literal('enum'), generic: z.object({ V: z.object({ name: z.literal('text') }) }), options: z.object({ values: z.record(z.string(), z.string()).describe('Each choice: its key and the words the person reads.') }) }),
  z.object({ name: z.literal('list'), generic: z.object({ V: FieldType }), options: lengths }),
  z.object({ name: z.literal('optional'), generic: z.object({ T: FieldType }) }),
  z.object({ name: z.literal('obj'), props: z.record(z.string(), z.object({ docs: z.string().optional().describe('The question the person reads.'), type: FieldType })) }),
]));

/** The draft's args: a form whose type is an obj of typed fields. */
export const FormDraftSchema = InputFormSchema.omit({ type: true }).extend({
  type: z.object({ name: z.literal('obj'), props: z.record(z.string(), z.object({ docs: z.string().min(1).describe('The question the person reads.'), type: FieldType })) })
    .describe('The gin type of the answers: an obj whose props are the questions.'),
});

/** A form as the agent drafts it (its draft tool's args): read as a form once checked. */
export type FormDraft = z.infer<typeof FormDraftSchema>;

// the drafted field types are exactly the ones the chat draws
expectType<Equal<FieldTypeDraft['name'], (typeof FIELD_TYPES)[number]>>(true);

/** A clean draft as the form it is. */
function formOf(draft: FormDraft): InputFormValue | undefined {
  const parsed = InputFormSchema.safeParse(draft);
  return parsed.success ? parsed.data : undefined;
}

type Session = AuthoringSession<FormAuthoring, FormDraft>;

/** The form a session's clean draft is. */
function draftForm(draft: FormDraft, session: Session): InputFormValue {
  const form = formOf(draft);
  if (form === undefined) { throw new Error(`The draft of "${session.request}" is not a form.`); }
  return form;
}

// #region authoring-agent
/** The form authoring agent. Run it with the run's `ctx.ai()` and a `FormAuthoring`. */
export const formAuthoring = authoringAgent<FormAuthoring, FormDraft>({
  name: 'form_author',
  description: 'Find or write the form that asks a person for what a request describes.',
  instructions: INSTRUCTIONS,
  tools: [findForms, useSaved, fieldTypes, loadForm],
  draft: { description: 'a form: title, description, submit (optional) and its gin object type.', schema: FormDraftSchema },
  check(draft, session) {
    const form = formOf(draft);
    if (form === undefined) { return Promise.resolve({ problems: ['The type is not a gin type: write it as { "name": "obj", "props": { … } }.'] }); }
    return Promise.resolve({ problems: checkForm(form, session.state.deps.maxFields), note: `${fieldsOf(form.type).length} fields.` });
  },
  async save(draft, session) {
    const form = draftForm(draft, session);
    const kept = await session.state.deps.keep(form, session.request);
    session.state.chose(form);
    return { fn: kept.fn, version: kept.version, signature: `${kept.fn}()`, about: form.description === '' ? form.title : form.description, reused: false, call: `${kept.fn}({})` };
  },
});
// #endregion authoring-agent
