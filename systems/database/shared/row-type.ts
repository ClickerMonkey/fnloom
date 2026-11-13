/**
 * The row type `create_table` and `alter_table` take, read from what a model actually sends.
 *
 * The canonical form is a gin `obj` type. Models often send a simpler column map instead
 * (`{ "id": "integer", "title": "text", "done": "boolean" }`), a list of `{ key, value }` or `{ name, type }` pairs,
 * or either of those as a JSON string. Each of those has one clear meaning, so it is turned into the gin type here;
 * anything else is refused with a message that shows the shape to send, before anyone is asked to approve it.
 */
import { isGinTypeDef, type GinTypeDef } from '@harness/core';

/** The column type words the simple form takes, and the gin type each means. */
const WORDS: Readonly<Record<string, GinTypeDef>> = {
  text: { name: 'text' }, string: { name: 'text' }, str: { name: 'text' }, varchar: { name: 'text' },
  uuid: { name: 'text', options: { pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } },
  integer: { name: 'num', options: { whole: true } }, int: { name: 'num', options: { whole: true } },
  number: { name: 'num' }, num: { name: 'num' }, float: { name: 'num' }, decimal: { name: 'num' }, real: { name: 'num' },
  boolean: { name: 'bool' }, bool: { name: 'bool' },
  date: { name: 'date' },
  datetime: { name: 'timestamp' }, timestamp: { name: 'timestamp' }, time: { name: 'timestamp' },
  json: { name: 'any' }, any: { name: 'any' },
};

/** The shape to send, shown when what was sent can't be read. */
export const ROW_TYPE_HELP =
  'Send `type` as an object of column name to column type, such as { "id": "integer", "title": "text", "done": "boolean", "due": "date?" } ' +
  `(types: ${Object.keys(WORDS).join(', ')}; end with ? when the column may be empty; \`id\` is the primary key), ` +
  'or as a gin obj type { "name": "obj", "props": { "id": { "type": { "name": "num", "options": { "whole": true } } } } }.';

/** A column type word (`"text"`, `"date?"`), or undefined when it isn't one. */
function word(value: unknown): GinTypeDef | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().toLowerCase();
  const optional = raw.endsWith('?');
  const base = WORDS[optional ? raw.slice(0, -1).trim() : raw];
  if (base === undefined) return undefined;
  return optional ? { name: 'optional', generic: { T: base } } : base;
}

/** One column's type: a word, or a gin type. */
function columnType(value: unknown): GinTypeDef | undefined {
  return word(value) ?? (isGinTypeDef(value) ? value : undefined);
}

/** Column name to type from a list of `{ key, value }` / `{ name, type }` pairs, or undefined when it isn't one. */
function pairs(value: unknown): Array<[string, unknown]> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: Array<[string, unknown]> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const name: unknown = Reflect.get(item, 'key') ?? Reflect.get(item, 'name') ?? Reflect.get(item, 'column');
    const type: unknown = Reflect.get(item, 'value') ?? Reflect.get(item, 'type');
    if (typeof name !== 'string') return undefined;
    out.push([name, type]);
  }
  return out;
}

/** A gin `obj` type from column entries, or the problem with them. */
function fromColumns(entries: Array<[string, unknown]>): { type: GinTypeDef } | { problem: string } {
  if (entries.length === 0) return { problem: `The row type has no columns. ${ROW_TYPE_HELP}` };
  const props: Record<string, { type: GinTypeDef }> = {};
  const bad: string[] = [];
  for (const [name, raw] of entries) {
    const type = columnType(raw);
    if (type === undefined) bad.push(`${name}: ${JSON.stringify(raw)}`);
    else props[name] = { type };
  }
  if (bad.length > 0) return { problem: `These columns have a type that isn't known: ${bad.join(', ')}. ${ROW_TYPE_HELP}` };
  return { type: { name: 'obj', props } };
}

/** The row type in `value` as a gin `obj` type with props, or why it can't be read. */
export function toRowType(value: unknown): { type: GinTypeDef } | { problem: string } {
  if (typeof value === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return { problem: `\`type\` is a string that isn't JSON. ${ROW_TYPE_HELP}` }; }
    if (typeof parsed === 'string') return { problem: `\`type\` is a string. ${ROW_TYPE_HELP}` };
    return toRowType(parsed);
  }
  if (value === null || value === undefined) return { problem: `\`type\` is missing. ${ROW_TYPE_HELP}` };
  if (isGinTypeDef(value)) {
    if (value.name === 'obj' && value.props !== undefined && Object.keys(value.props).length > 0) return { type: value };
    if (value.name === 'obj') return { problem: `The row type has no columns. ${ROW_TYPE_HELP}` };
    // `{ name: "Todo", props: {...} }`: an obj that was given the table's name
    if (value.props !== undefined && Object.keys(value.props).length > 0) return { type: { ...value, name: 'obj' } };
  }
  const list = pairs(value);
  if (list !== undefined) return fromColumns(list);
  if (typeof value === 'object' && !Array.isArray(value)) return fromColumns(Object.entries(value));
  return { problem: `\`type\` must be an object. ${ROW_TYPE_HELP}` };
}
