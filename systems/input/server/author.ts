/**
 * The form agent: given what `get_input` was asked for, a model writes the form (its title, description and gin type)
 * through the hub, gin's registry checks the type (`formProblems`), and a refused form goes back with the problems,
 * a few times at most.
 */
import { isGinTypeDef } from '@harness/core';
import { g, json, parseValue, type Infer, type Llm } from '@harness/sdk';
import type { InputFormValue } from '../shared/index.ts';
import { FIELD_TYPES, fieldsOf, formProblems } from '../shared/forms.ts';

/** Writes forms for descriptions. */
export interface FormAuthor {
  /** A checked form, or the problems with the last try. */
  write(description: string, llm: Llm): Promise<InputFormValue | { problems: string[] }>;
}

/** What the model answers with: the type is any JSON, checked by gin afterwards. */
const Written = g.obj({
  title: g.text({ minLength: 1 }),
  description: g.text(),
  submit: g.optional(g.text({ minLength: 1 })),
  type: json(),
});

/** The authoring guide the model writes forms by: gin's type JSON, limited to what a form draws. */
export const FORM_AUTHORING = [
  'You write input forms as gin types (JSON). A form is an object type whose fields are the questions:',
  '{ "name": "obj", "props": { "<fieldName>": { "docs": "<the question or label the person reads>", "type": <field type> }, … } }',
  `Field types (only these: ${FIELD_TYPES.join(', ')}):`,
  '- text: { "name": "text", "options": { "minLength": 1, "maxLength": 200 } } (options optional)',
  '- number: { "name": "num", "options": { "min": 0, "max": 10, "whole": true } } (options optional)',
  '- yes or no: { "name": "bool" }',
  '- a date: { "name": "date" }; a date and time: { "name": "timestamp" }; a length of time: { "name": "duration" }',
  '- one of some options: { "name": "enum", "generic": { "V": { "name": "text" } }, "options": { "values": { "small": "small", "large": "large" } } }',
  '- several: { "name": "list", "generic": { "V": <item type> }, "options": { "minLength": 1 } }',
  '- not required: { "name": "optional", "generic": { "T": <field type> } }',
  '- a group of fields: a nested obj.',
  'Use camelCase field names, a clear "docs" on every field, optional for anything the person may skip, and enums for fixed choices.',
  'Answer with only this JSON object, no other words: { "title": short form title, "description": one sentence on what it is for, "submit": button words (optional), "type": the form type }.',
].join('\n');

/** The form in a model's answer: the JSON object in it (fences and words around it are dropped), checked for its fields. */
export function readWritten(answer: string): Infer<typeof Written> | { problem: string } {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end < start) { return { problem: 'Answer with one JSON object.' }; }
  try {
    return parseValue(Written, JSON.parse(answer.slice(start, end + 1)));
  } catch (error) {
    return { problem: `The answer isn't the asked JSON object: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** `FormAuthor` over the run's own model calls. */
export class LlmFormAuthor implements FormAuthor {
  readonly #retries: number;
  readonly #maxFields: number;

  constructor(options: { retries: number; maxFields: number }) {
    this.#retries = options.retries;
    this.#maxFields = options.maxFields;
  }

  async write(description: string, llm: Llm): Promise<InputFormValue | { problems: string[] }> {
    let prompt = `Write a form that asks the person for this:\n\n${description}`;
    let problems: string[] = [];
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const answer = await llm.text({ system: FORM_AUTHORING, prompt });
      const written = readWritten(answer);
      problems = 'problem' in written ? [written.problem] : this.#problems(written.type);
      if (!('problem' in written) && problems.length === 0 && isGinTypeDef(written.type)) {
        return { title: written.title, description: written.description, type: written.type, ...(written.submit === undefined ? {} : { submit: written.submit }) };
      }
      prompt = `${prompt}\n\nYour last answer was refused:\n${answer}\n\nFix these problems:\n- ${problems.join('\n- ')}`;
    }
    return { problems };
  }

  #problems(type: unknown): string[] {
    if (!isGinTypeDef(type)) { return ['"type" must be a gin type: an object with a "name".']; }
    const problems = formProblems(type);
    if (problems.length === 0 && fieldsOf(type).length > this.#maxFields) { return [`A form has at most ${this.#maxFields} fields.`]; }
    return problems;
  }
}
