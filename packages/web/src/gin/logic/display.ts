/**
 * How the value viewer words a value of a gin type: durations in their largest units, timestamps and dates in the
 * reader's locale, enum values by their label, colours as hex, and a one-line summary for a composite drawn
 * collapsed ("3 items", "path, count and 2 more"). Read off the same `FormNode` the editor uses, so the viewer and the
 * editor never disagree about a type's shape. Pure, so they are tested alone.
 */
import { humanize, type Json } from '@harness/core';
import { fits, hex, mapPairs, type FormNode } from './form.ts';

/** A JSON object (not null, not a list). */
export type JsonObject = { readonly [key: string]: Json };

/** Whether a JSON value is an object. */
export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UNITS = [['h', 3_600_000], ['min', 60_000], ['s', 1_000]] as const;

/** A duration in ms, in its two largest units: `250 ms`, `1.5 s`, `2 min 5 s`, `1 h 30 min`. */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms)) { return String(ms); }
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 1_000) { return `${sign}${Math.round(abs)} ms`; }
  if (abs < 60_000) { return `${sign}${Number((abs / 1_000).toFixed(abs < 10_000 ? 2 : 1))} s`; }
  const parts: string[] = [];
  let rest = Math.round(abs / 1_000) * 1_000;
  for (const [unit, size] of UNITS) {
    const count = Math.floor(rest / size);
    if (count > 0 && parts.length < 2) { parts.push(`${count} ${unit}`); }
    rest -= count * size;
  }
  return `${sign}${parts.join(' ')}`;
}

/** A timestamp (ISO text) in the reader's locale, with its date and time; the text itself when it doesn't read as one. */
export function timestampText(iso: string, locale?: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A date (`YYYY-MM-DD`) in the reader's locale; the text itself when it doesn't read as one. */
export function dateText(day: string, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (match === null) { return day; }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(locale, { dateStyle: 'medium' });
}

/** A packed rgb colour as `#rrggbb`, or undefined when the value isn't a colour. */
export function colorText(value: Json | undefined): string | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? hex(value) : undefined;
}

/** An enum value by its label, or the value itself when it isn't one of the choices. */
export function enumText(node: Extract<FormNode, { kind: 'enum' }>, value: Json | undefined): string {
  return node.choices.find((choice) => choice.value === value)?.label ?? (value === undefined ? '' : JSON.stringify(value));
}

/** The union option a value is drawn with: the first that fits it (the first option when none does). */
export function optionOf(node: Extract<FormNode, { kind: 'or' }>, value: Json | undefined): number {
  return Math.max(0, node.options.findIndex((option) => fits(option.node, value)));
}

/** The node a value of `node` is drawn as: a named type as its definition, when the browser holds it. */
export function shapeOf(node: FormNode): FormNode {
  return node.kind === 'ref' && node.inner !== undefined ? shapeOf(node.inner) : node;
}

/** Whether a node is drawn as a composite (a list, a map, an object), so it can collapse. */
export function isComposite(node: FormNode): boolean {
  const shape = shapeOf(node);
  return shape.kind === 'list' || shape.kind === 'tuple' || shape.kind === 'map' || shape.kind === 'obj';
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The fields of an object value that are present, in the type's order, with what the type says about each. */
export function presentFields(node: Extract<FormNode, { kind: 'obj' }>, value: Json | undefined): { readonly field: (typeof node.fields)[number]; readonly value: Json }[] {
  if (!isJsonObject(value)) { return []; }
  return node.fields.flatMap((field) => {
    const shown = value[field.name];
    return shown === undefined ? [] : [{ field, value: shown }];
  });
}

/**
 * A value in one line, for a collapsed composite, a table cell or a list row: scalars as they read, lists and maps
 * by their count, objects by their first fields.
 */
export function summary(node: FormNode, value: Json | undefined): string {
  if (value === undefined) { return 'Not set'; }
  if (value === null) { return 'None'; }
  const shape = shapeOf(node);
  switch (shape.kind) {
    case 'text': return typeof value === 'string' ? (value.length > 80 ? `${value.slice(0, 79)}…` : value) : JSON.stringify(value);
    case 'num': return typeof value === 'number' ? value.toLocaleString() : JSON.stringify(value);
    case 'bool': return value === true ? 'Yes' : 'No';
    case 'duration': return typeof value === 'number' ? durationText(value) : JSON.stringify(value);
    case 'date': return typeof value === 'string' ? dateText(value) : JSON.stringify(value);
    case 'timestamp': return typeof value === 'string' ? timestampText(value) : JSON.stringify(value);
    case 'color': return colorText(value) ?? JSON.stringify(value);
    case 'enum': return enumText(shape, value);
    case 'literal': return JSON.stringify(shape.value);
    case 'list': case 'tuple': return Array.isArray(value) ? count(value.length, 'item', 'items') : JSON.stringify(value);
    case 'map': return count(mapPairs(value).length, 'entry', 'entries');
    case 'obj': {
      const shown = presentFields(shape, value).map((f) => humanize(f.field.name).toLowerCase());
      if (shown.length === 0) { return 'Empty'; }
      const head = shown.slice(0, 2);
      return shown.length > 2 ? `${head.join(', ')} and ${shown.length - 2} more` : head.join(' and ');
    }
    case 'nullable': return summary(shape.inner, value);
    case 'or': return summary(shape.options[optionOf(shape, value)]?.node ?? { kind: 'json', docs: '' }, value);
    case 'ref': case 'json': {
      const text = JSON.stringify(value);
      return text.length > 80 ? `${text.slice(0, 79)}…` : text;
    }
  }
}
