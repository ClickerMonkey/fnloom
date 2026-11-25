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

function enumOptions(type: TypeDef): string[] | undefined {
  if (type.name !== 'enum') { return undefined; }
  const values = option(type.options, 'values');
  return typeof values === 'object' && values !== null ? Object.keys(values) : [];
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

/** The answers checked by the form's gin type: the value to send, or what to fix (missing required fields first). */
export function checkAnswers(def: TypeDef, values: FormValues): { value: Json } | { problem: string } {
  const fields = fieldsOf(def);
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
