/**
 * Forms, shared by the server and the renderer (browser safe): the quick forms the `ask_*` fns make, the check a
 * written form's gin type must pass (gin's registry parses it; it is an object of plain fields and names no other
 * type), its fields as a form draws them, and the answers as the `key: value` lines the model reads.
 */
import type { TypeDef } from '@aeye/gin';
import type { Json } from '@harness/core';
import { g, wireType, type GinType } from '@harness/sdk';
import type { InputFormValue } from './index.ts';

/** The gin types a form's fields may use. */
export const FIELD_TYPES = ['text', 'num', 'bool', 'enum', 'date', 'timestamp', 'duration', 'list', 'optional', 'obj'] as const;

const FIELD_TYPE_NAMES: ReadonlySet<string> = new Set(FIELD_TYPES);

/** The field every quick form keeps its answer in. */
export const ANSWER_FIELD = 'answer';

/** A form of one question whose answer is of `type`. */
function oneQuestion(question: string, type: GinType, submit?: string): InputFormValue {
  return { title: question, description: '', type: wireType(g.obj({ [ANSWER_FIELD]: g.field(type, { docs: question }) })), ...(submit === undefined ? {} : { submit }) };
}

/** The quick forms, one per `ask_*` fn. */
export const quickForms = {
  text: (args: { question: string; placeholder?: string | undefined; long?: boolean | undefined }): InputFormValue =>
    oneQuestion(args.question, g.text({ minLength: 1, ...(args.long === true ? {} : { maxLength: 500 }) })),
  choice: (args: { question: string; options: string[]; multiple?: boolean | undefined }): InputFormValue => {
    const options = [...new Set(args.options.map((option) => option.trim()).filter((option) => option !== ''))];
    const one = g.enum(options);
    return oneQuestion(args.question, args.multiple === true ? g.list(one, { minLength: 1 }) : one);
  },
  confirm: (args: { question: string }): InputFormValue => oneQuestion(args.question, g.bool()),
  number: (args: { question: string; min?: number | undefined; max?: number | undefined; whole?: boolean | undefined }): InputFormValue =>
    oneQuestion(args.question, g.num({ ...(args.min === undefined ? {} : { min: args.min }), ...(args.max === undefined ? {} : { max: args.max }), ...(args.whole === true ? { whole: true } : {}) })),
  date: (args: { question: string }): InputFormValue => oneQuestion(args.question, g.date()),
};

/** One field of a form, as a form draws it. */
export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly type: TypeDef;
  readonly required: boolean;
}

/** A field name as words: `startDate` and `start_date` read "Start date". */
export function labelOf(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words === '' ? key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The fields of a form's object type, in order; an `optional` field is not required and is drawn as its inner type. */
export function fieldsOf(def: TypeDef): FormField[] {
  return Object.entries(def.props ?? {}).map(([key, prop]) => {
    const inner = prop.type.name === 'optional' ? prop.type.generic?.['T'] : undefined;
    return { key, label: prop.docs ?? labelOf(key), type: inner ?? prop.type, required: inner === undefined };
  });
}

function walk(def: TypeDef, path: string, problems: string[]): void {
  if (!FIELD_TYPE_NAMES.has(def.name)) {
    problems.push(`${path === '' ? 'The form' : `Field ${path}`} uses the type "${def.name}"; use one of ${FIELD_TYPES.join(', ')}.`);
    return;
  }
  for (const [key, inner] of Object.entries(def.generic ?? {})) { walk(inner, path === '' ? key : `${path}<${key}>`, problems); }
  for (const [key, prop] of Object.entries(def.props ?? {})) { walk(prop.type, path === '' ? key : `${path}.${key}`, problems); }
}

/**
 * What is wrong with a form's gin type, in words an agent can fix: gin's own parse error, a type that isn't an object
 * with at least one field, a field of a type forms don't draw, or a reference to a named type.
 */
export function formProblems(def: TypeDef): string[] {
  let references: readonly string[];
  try {
    references = g.parse(def).references().refs;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (def.name !== 'obj' || Object.keys(def.props ?? {}).length === 0) { return ['A form\'s type is an object ({ "name": "obj", "props": { … } }) with at least one field.']; }
  const problems: string[] = [];
  walk(def, '', problems);
  if (references.length > 0) { problems.push(`A form can't use named types (${references.join(', ')}); spell each field's type out.`); }
  return problems;
}

/** A value as words: lists joined, yes or no, dates as they are. */
function words(value: Json): string {
  if (value === null) { return '(none)'; }
  if (typeof value === 'boolean') { return value ? 'yes' : 'no'; }
  if (Array.isArray(value)) { return value.map(words).join(', '); }
  if (typeof value === 'object') { return Object.entries(value).map(([key, inner]) => `${labelOf(key)}: ${words(inner)}`).join('; '); }
  return String(value);
}

/** The answers as the model reads them: one `label: value` line per field, unanswered fields left out. */
export function answerText(def: TypeDef, value: Json): string {
  const answers = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  return fieldsOf(def)
    .flatMap((field) => {
      const answer = answers[field.key];
      return answer === undefined ? [] : [`${field.label}: ${words(answer)}`];
    })
    .join('\n');
}
