/**
 * The form's logic, apart from its component: reading a run's result as a form, the inputs a field is drawn with,
 * checking the answers with the form's own gin type, and the answer that is sent (its `key: value` text included).
 */
import type { TypeDef } from '@aeye/gin';
import { checkGinValue, Json, type RunId } from '@harness/core';
import { g, parseValue } from '@harness/sdk';
import { Asked, type AskedValue } from '../shared/index.ts';
import { answerText, fieldsOf, type FormField } from '../shared/forms.ts';
import type { InputAnswer } from './host.ts';

/** A run's result as a form, or `undefined` when it isn't one (a kind fn's result arrives as JSON). */
export function askedOf(result: unknown): AskedValue | undefined {
  if (result === undefined) { return undefined; }
  try {
    return parseValue(Asked, result);
  } catch {
    return undefined;
  }
}

/** How a field is drawn by the form's own inputs. */
export type FieldControl =
  | { readonly control: 'text'; readonly long: boolean }
  | { readonly control: 'number'; readonly min: number | undefined; readonly max: number | undefined; readonly step: number | 'any' }
  | { readonly control: 'yes-no' }
  | { readonly control: 'choice'; readonly options: readonly string[]; readonly multiple: boolean }
  | { readonly control: 'date' }
  | { readonly control: 'datetime' }
  | { readonly control: 'lines' }
  | { readonly control: 'json' };

function option(options: unknown, key: string): unknown {
  return typeof options === 'object' && options !== null && key in options ? Reflect.get(options, key) : undefined;
}

function numberOption(options: unknown, key: string): number | undefined {
  const value = option(options, key);
  return typeof value === 'number' ? value : undefined;
}

/** An enum's `{ key: member }` constants (gin's `options.values`), or `undefined` when the type isn't an enum. */
function enumValues(type: TypeDef): Record<string, unknown> | undefined {
  if (type.name !== 'enum') { return undefined; }
  const values = option(type.options, 'values');
  return typeof values === 'object' && values !== null ? { ...values } : {};
}

/**
 * An enum's choices: its members, the values gin accepts (`{ key: member }`: the member, such as `'Emma'` of
 * `{ emma: 'Emma' }`, is what a form sends and the words the person reads; the key only names it).
 */
function enumOptions(type: TypeDef): string[] | undefined {
  const values = enumValues(type);
  return values === undefined ? undefined : Object.values(values).flatMap((member) => (typeof member === 'string' ? [member] : []));
}

/** Text compared as a person means it: without case, spaces at its ends, or a run of spaces inside counting. */
function loose(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * One choice answer as the enum's member: the member itself; else the member whose words, or whose key, match it
 * without case or spacing counting (`'emma'` → `'Emma'` of `{ emma: 'Emma' }`); else the answer as it was, for the
 * check to refuse. A list of choices maps each item.
 */
export function choiceAnswer(type: TypeDef, answer: Json | undefined): Json | undefined {
  if (type.name === 'list') {
    const item = type.generic?.['V'];
    return item === undefined || !Array.isArray(answer) ? answer : answer.map((one) => choiceAnswer(item, one) ?? one);
  }
  const values = enumValues(type);
  if (values === undefined || typeof answer !== 'string') { return answer; }
  const members = Object.entries(values).flatMap(([key, member]) => (typeof member === 'string' ? [{ key, member }] : []));
  if (members.some(({ member }) => member === answer)) { return answer; }
  const wanted = loose(answer);
  return (members.find(({ member }) => loose(member) === wanted) ?? members.find(({ key }) => loose(key) === wanted))?.member ?? answer;
}

/** The input a field is drawn with. */
export function controlOf(type: TypeDef): FieldControl {
  switch (type.name) {
    case 'text': {
      const max = numberOption(type.options, 'maxLength');
      return { control: 'text', long: max === undefined || max > 500 };
    }
    case 'num':
      return { control: 'number', min: numberOption(type.options, 'min'), max: numberOption(type.options, 'max'), step: option(type.options, 'whole') === true ? 1 : 'any' };
    case 'bool': return { control: 'yes-no' };
    case 'enum': return { control: 'choice', options: enumOptions(type) ?? [], multiple: false };
    case 'date': return { control: 'date' };
    case 'timestamp': return { control: 'datetime' };
    case 'list': {
      const item = type.generic?.['V'];
      const options = item === undefined ? undefined : enumOptions(item);
      if (options !== undefined) { return { control: 'choice', options, multiple: true }; }
      return item?.name === 'text' ? { control: 'lines' } : { control: 'json' };
    }
    default: return { control: 'json' };
  }
}

/** The values being edited, by field key. */
export type FormValues = Record<string, Json | undefined>;

/**
 * The answers checked by the form's gin type: the value to send, or what to fix (missing required fields first). A
 * choice typed in its own words (another case, a key) is read as the choice it names first (`choiceAnswer`).
 */
export function checkAnswers(def: TypeDef, given: FormValues): { value: Json } | { problem: string } {
  const fields = fieldsOf(def);
  const values: FormValues = { ...given };
  for (const field of fields) { if (values[field.key] !== undefined) { values[field.key] = choiceAnswer(field.type, values[field.key]); } }
  const missing = fields.filter((field) => field.required && isEmpty(values[field.key]));
  if (missing.length > 0) { return { problem: `Fill in ${missing.map((field) => field.label).join(', ')}.` }; }
  const kept = Object.fromEntries(fields.flatMap((field) => {
    const value = values[field.key];
    return value === undefined || isEmpty(value) ? [] : [[field.key, value]];
  }));
  const type = g.parse(def);
  try {
    return { value: Json.parse(type.parse(kept).encodeLogical()) };
  } catch (error) {
    // gin's parse says what failed but not where (`num.parse: not a number — undefined at `); the value check names
    // the field, and a near key ("amount" for "monthlyAmount")
    const checked = checkGinValue(type, kept, { unknownKeys: 'refuse' });
    if (!checked.ok && checked.problems.length > 0) {
      return { problem: checked.problems.slice(0, 3).map((problem) => (problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`)).join(' ') };
    }
    return { problem: error instanceof Error ? error.message.replace(/^[a-z.]+:\s*/i, '') : String(error) };
  }
}

function isEmpty(value: Json | undefined): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** The answer a submitted form sends. */
export function answerFor(run: RunId, asked: AskedValue, value: Json): InputAnswer {
  return { run, title: asked.form.title, value, text: answerText(asked.form.type, value) };
}

/** An answered value in words, for the answered form. */
export function shownValue(value: Json | undefined): string {
  if (value === undefined || value === null) { return '—'; }
  if (typeof value === 'boolean') { return value ? 'Yes' : 'No'; }
  if (Array.isArray(value)) { return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', '); }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export { fieldsOf, type FormField };
