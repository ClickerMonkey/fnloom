/**
 * The search box's rules, pure so they are tested alone. A list's query (`ListQuery`: words, filters, sort) has one
 * written form, the same one a person types into the box and the one the URL holds (`?q=`):
 *
 * - `status:running` (is), `status:running,queued` (in), `status!:failed` (is not / not in), `name~read` (contains)
 * - `cost>0.01`, `cost>=$0.01`, `duration<2s`, `size:1kb..2mb` (between), `seen>2026-11-01`
 * - `has:tags` (not empty), `no:tags` (empty), `archived:yes`
 * - `sort:name`, `sort:-createdAt` (descending), and every other word is free text.
 *
 * Fields are named by key or label (any case, spaces dropped: `avgcost`), values by value or label, and a value with
 * spaces or commas is quoted (`fn:"my fn"`). From the same rules come each filter's pill words (`Cost > $0.01`), the
 * suggestions offered while typing, and the filter menu's operators.
 */
import { OP_LABELS, OPS_BY_TYPE, type FieldDecl, type Filter, type FilterOp, type FilterValue, type ListQuery, type Sort } from '@harness/core';

/** A list's fields by key: `LIST_FIELDS[list].fields`. */
export type SearchFields = Readonly<Record<string, FieldDecl>>;

/** How a number shows in a pill (by its field's unit). The app passes its formatters; plain numbers otherwise. */
export type NumberFormat = (value: number, decl: FieldDecl) => string;

/** The words and filters of a query: what the search box edits (the sort button edits the rest). */
export type SearchQuery = Pick<ListQuery, 'text' | 'filters' | 'sort'>;

const plainNumber: NumberFormat = (value) => String(value);

/** A data value's readable name (a session id's chat title), or undefined to show the value itself. */
export type ValueNamer = (field: string, value: FilterValue) => string | undefined;

// ─── Fields and values ────────────────────────────────────────────────────────

const squash = (text: string): string => text.toLowerCase().replace(/[\s_-]+/g, '');

/** A field's key by its key or label, typed in any case (`Avg cost`, `avgcost`, `averageCost`). */
export function findField(fields: SearchFields, typed: string): string | undefined {
  const want = squash(typed);
  if (want === '') { return undefined; }
  return Object.keys(fields).find((key) => squash(key) === want || squash(fields[key]?.label ?? '') === want);
}

/** An enum value's words: `awaiting-approval` → `Awaiting approval`. */
export function valueWords(value: string): string {
  const spaced = value.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return spaced === '' ? value : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const UNIT_SCALES: Readonly<Record<string, number>> = {
  ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000,
  b: 1, kb: 1_024, mb: 1_024 ** 2, gb: 1_024 ** 3,
  k: 1_000, // tokens and counts: 12k
};

/** A typed number for a field: `0.01`, `$0.01`, `2s`, `1.5kb`, `12k`; undefined when it isn't one. */
export function parseNumber(typed: string): number | undefined {
  const match = /^\$?(-?\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(typed.trim());
  if (match === null) { return undefined; }
  const scale = (match[2] ?? '') === '' ? 1 : UNIT_SCALES[(match[2] ?? '').toLowerCase()];
  return scale === undefined ? undefined : Number(match[1]) * scale;
}

/** A typed date (`2026-11-01`, an ISO time, or ms since the epoch) as ms; undefined when it isn't one. */
export function parseDate(typed: string): number | undefined {
  const text = typed.trim();
  if (/^\d{10,}$/.test(text)) { return Number(text); }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day !== null) { return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime(); }
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

/** A date written for the query: the day (`2026-11-01`) at local midnight, else the full ISO time. */
export function writeDate(at: number): string {
  const date = new Date(at);
  const midnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
  if (!midnight) { return date.toISOString(); }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A typed value for a field, as the filter holds it; undefined when it doesn't read as the field's type. */
export function parseValue(decl: FieldDecl, typed: string): FilterValue | undefined {
  const text = typed.trim();
  if (text === '') { return undefined; }
  switch (decl.type) {
    case 'number': return parseNumber(text);
    case 'date': return parseDate(text);
    case 'boolean': {
      const word = text.toLowerCase();
      if (['yes', 'true', 'on', '1'].includes(word)) { return true; }
      return ['no', 'false', 'off', '0'].includes(word) ? false : undefined;
    }
    case 'enum': {
      const known = decl.values?.find((v) => v.toLowerCase() === text.toLowerCase() || valueWords(v).toLowerCase() === text.toLowerCase());
      return known ?? (decl.values === undefined ? text : undefined);
    }
    case 'text': return text;
  }
}

/** A value as a pill shows it. */
export function valueLabel(decl: FieldDecl, value: FilterValue, format: NumberFormat = plainNumber): string {
  if (typeof value === 'boolean') { return value ? 'Yes' : 'No'; }
  if (typeof value === 'number') {
    return decl.type === 'date' ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : format(value, decl);
  }
  return decl.type === 'enum' && decl.values !== undefined ? valueWords(value) : value;
}

// ─── Pills ────────────────────────────────────────────────────────────────────

/** The values a filter compares with (none for `empty`, two for `between`). */
export function filterValues(filter: Filter): FilterValue[] {
  switch (filter.op) {
    case 'in': case 'notIn': return [...filter.values];
    case 'between': return [filter.from, filter.to];
    case 'empty': case 'notEmpty': return [];
    case 'is': case 'isNot': case 'gt': case 'gte': case 'lt': case 'lte': case 'contains': return [filter.value];
  }
}

/**
 * A filter's words: `Status: Running`, `Cost > $0.01`, `Status in Running, Queued`, `Tags is empty`. `name` gives a data
 * value its readable name (`Session: Trip plans`, not the session's id).
 */
export function pillText(fields: SearchFields, filter: Filter, format: NumberFormat = plainNumber, name?: ValueNamer): string {
  const decl = fields[filter.field];
  const label = decl?.label ?? filter.field;
  const show = (value: FilterValue): string => name?.(filter.field, value) ?? (decl === undefined ? String(value) : valueLabel(decl, value, format));
  switch (filter.op) {
    case 'is': return `${label}: ${show(filter.value)}`;
    case 'in': case 'notIn': return `${label} ${OP_LABELS[filter.op]} ${filter.values.map(show).join(', ')}`;
    case 'between': return `${label} ${show(filter.from)} – ${show(filter.to)}`;
    case 'empty': case 'notEmpty': return `${label} ${OP_LABELS[filter.op]}`;
    case 'isNot': case 'gt': case 'gte': case 'lt': case 'lte': case 'contains': return `${label} ${OP_LABELS[filter.op]} ${show(filter.value)}`;
  }
}

/** The operators a field takes, in menu order. */
export function opsOf(decl: FieldDecl): readonly FilterOp[] {
  return OPS_BY_TYPE[decl.type];
}

/** How many values an operator takes: none, one, two (between) or many (in). */
export function arityOf(op: FilterOp): 'none' | 'one' | 'two' | 'many' {
  if (op === 'empty' || op === 'notEmpty') { return 'none'; }
  if (op === 'between') { return 'two'; }
  return op === 'in' || op === 'notIn' ? 'many' : 'one';
}

/** A filter from the menu's parts, or undefined while a value is missing or doesn't read as the field's type. */
export function buildFilter(decl: FieldDecl, field: string, op: FilterOp, typed: readonly string[]): Filter | undefined {
  const values = typed.map((t) => parseValue(decl, t));
  const defined = values.filter((v): v is FilterValue => v !== undefined);
  switch (op) {
    case 'empty': case 'notEmpty': return { field, op };
    case 'between': {
      const [from, to] = values;
      return from === undefined || to === undefined ? undefined : { field, op, from, to };
    }
    case 'in': case 'notIn': return defined.length === 0 || defined.length < values.length ? undefined : { field, op, values: defined };
    case 'is': case 'isNot': case 'gt': case 'gte': case 'lt': case 'lte': case 'contains': {
      const [value] = values;
      return value === undefined ? undefined : { field, op, value };
    }
  }
}

// ─── The written form ─────────────────────────────────────────────────────────

const PLAIN = /^[^\s",]+$/;

/** A value written so it reads back the same: quoted when it has spaces, commas or quotes. */
function writeValue(decl: FieldDecl | undefined, value: FilterValue): string {
  if (typeof value === 'boolean') { return value ? 'yes' : 'no'; }
  if (typeof value === 'number') { return decl?.type === 'date' ? writeDate(value) : String(value); }
  return PLAIN.test(value) && !value.includes('..') ? value : `"${value.replace(/["\\]/g, '\\$&')}"`;
}

const SIGNED_OPS = ['is', 'isNot', 'gt', 'gte', 'lt', 'lte', 'contains'] as const satisfies readonly FilterOp[];
const SIGNS = { is: ':', isNot: '!:', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: '~' } as const satisfies Record<(typeof SIGNED_OPS)[number], string>;

/** One filter written (`status:running`, `cost>0.01`, `no:tags`). */
export function writeFilter(fields: SearchFields, filter: Filter): string {
  const decl = fields[filter.field];
  const value = (v: FilterValue): string => writeValue(decl, v);
  switch (filter.op) {
    case 'empty': return `no:${filter.field}`;
    case 'notEmpty': return `has:${filter.field}`;
    case 'in': return `${filter.field}:${filter.values.map(value).join(',')}`;
    case 'notIn': return `${filter.field}!:${filter.values.map(value).join(',')}`;
    case 'between': return `${filter.field}:${value(filter.from)}..${value(filter.to)}`;
    case 'is': case 'isNot': case 'gt': case 'gte': case 'lt': case 'lte': case 'contains': return `${filter.field}${SIGNS[filter.op]}${value(filter.value)}`;
  }
}

/** A whole query written: its filters, its sort keys, then its words. */
export function writeQuery(fields: SearchFields, query: SearchQuery): string {
  return [
    ...(query.filters ?? []).map((f) => writeFilter(fields, f)),
    ...(query.sort ?? []).map((s) => `sort:${s.dir === 'desc' ? '-' : ''}${s.field}`),
    ...(query.text === undefined || query.text.trim() === '' ? [] : [query.text.trim()]),
  ].join(' ');
}

/** The written form cut into words, keeping quoted values whole (`fn:"my fn",b` is one word). */
export function words(text: string): string[] {
  const out: string[] = [];
  let word = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quoted && char === '\\' && i + 1 < text.length) { word += char + text.charAt(i + 1); i++; continue; }
    if (char === '"') { quoted = !quoted; word += char; continue; }
    if (!quoted && /\s/.test(char)) { if (word !== '') { out.push(word); } word = ''; continue; }
    word += char;
  }
  if (word !== '') { out.push(word); }
  return out;
}

/** A written list of values (`a,"b, c"`) split and unquoted. */
function splitValues(text: string): string[] {
  const out: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quoted && char === '\\' && i + 1 < text.length) { value += text.charAt(i + 1); i++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === ',') { out.push(value); value = ''; continue; }
    value += char;
  }
  out.push(value);
  return out.filter((v) => v !== '');
}

/** Where a written list of values splits at `..` outside quotes, for `between`. */
function splitRange(text: string): readonly [string, string] | undefined {
  let quoted = false;
  for (let i = 0; i < text.length - 1; i++) {
    const char = text.charAt(i);
    if (char === '\\') { i++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === '.' && text.charAt(i + 1) === '.') { return [text.slice(0, i), text.slice(i + 2)]; }
  }
  return undefined;
}

const FILTER_WORD = /^([A-Za-z][\w]*)(!:|>=|<=|:|>|<|~)(.*)$/s;

/** One written word as a filter, or undefined when it isn't one for these fields (then it is free text). */
export function readFilter(fields: SearchFields, word: string): Filter | undefined {
  const presence = /^(has|no):(.+)$/i.exec(word);
  if (presence !== null) {
    const field = findField(fields, presence[2] ?? '');
    const decl = field === undefined ? undefined : fields[field];
    if (field === undefined || decl === undefined || !decl.filterable || !opsOf(decl).includes('empty')) { return undefined; }
    return { field, op: presence[1]?.toLowerCase() === 'has' ? 'notEmpty' : 'empty' };
  }
  const match = FILTER_WORD.exec(word);
  if (match === null) { return undefined; }
  const field = findField(fields, match[1] ?? '');
  const decl = field === undefined ? undefined : fields[field];
  if (field === undefined || decl === undefined || !decl.filterable) { return undefined; }
  const sign = match[2] ?? '';
  const rest = match[3] ?? '';
  const ops = opsOf(decl);
  const range = sign === ':' ? splitRange(rest) : undefined;
  if (range !== undefined && ops.includes('between')) { return buildFilter(decl, field, 'between', range.map((r) => splitValues(r)[0] ?? '')); }
  const values = splitValues(rest);
  if (sign === ':' || sign === '!:') {
    const many = values.length > 1;
    const op: FilterOp = sign === ':' ? (many ? 'in' : 'is') : (many ? 'notIn' : 'isNot');
    return ops.includes(op) ? buildFilter(decl, field, op, values) : undefined;
  }
  const op = SIGNED_OPS.find((key) => SIGNS[key] === sign);
  return op !== undefined && ops.includes(op) ? buildFilter(decl, field, op, values) : undefined;
}

/** One written word as a sort key (`sort:-createdAt`), or undefined. */
export function readSort(fields: SearchFields, word: string): Sort | undefined {
  const match = /^sort:(-?)(.+)$/i.exec(word);
  if (match === null) { return undefined; }
  const field = findField(fields, match[2] ?? '');
  return field === undefined || fields[field]?.sortable !== true ? undefined : { field, dir: match[1] === '-' ? 'desc' : 'asc' };
}

/** The written form read back: filters and sort keys it recognises, every other word as free text. */
export function readQuery(fields: SearchFields, text: string): SearchQuery {
  const filters: Filter[] = [];
  const sort: Sort[] = [];
  const free: string[] = [];
  for (const word of words(text)) {
    const s = readSort(fields, word);
    if (s !== undefined) { if (sort.length < 3) { sort.push(s); } continue; }
    const f = readFilter(fields, word);
    if (f !== undefined) { if (filters.length < 20) { filters.push(f); } continue; }
    free.push(word);
  }
  return {
    ...(free.length === 0 ? {} : { text: free.join(' ') }),
    ...(filters.length === 0 ? {} : { filters }),
    ...(sort.length === 0 ? {} : { sort }),
  };
}

// ─── Editing ──────────────────────────────────────────────────────────────────

/** A query with a filter added, or put in place of the one at `at`; a filter equal to one already there isn't added twice. */
export function withFilter(query: SearchQuery, filter: Filter, at?: number): SearchQuery {
  const filters = [...(query.filters ?? [])];
  if (at !== undefined && at >= 0 && at < filters.length) { filters[at] = filter; } else if (!filters.some((f) => JSON.stringify(f) === JSON.stringify(filter))) { filters.push(filter); }
  return { ...query, filters };
}

/** A query without the filter at `at`. */
export function withoutFilter(query: SearchQuery, at: number): SearchQuery {
  const filters = (query.filters ?? []).filter((_, i) => i !== at);
  const { filters: _old, ...rest } = query;
  return filters.length === 0 ? rest : { ...rest, filters };
}

/** A query with other words (none when blank). */
export function withText(query: SearchQuery, text: string): SearchQuery {
  const { text: _old, ...rest } = query;
  return text.trim() === '' ? rest : { ...rest, text: text.trim() };
}

/**
 * A query sorted by `field`: picking the field it is sorted by turns its direction round; another field starts in
 * its natural direction (newest, largest first for dates and numbers; A to Z for words).
 */
export function withSort(fields: SearchFields, current: readonly Sort[], field: string): Sort[] {
  const [first] = current;
  if (first?.field === field) { return [{ field, dir: first.dir === 'asc' ? 'desc' : 'asc' }]; }
  const type = fields[field]?.type;
  return [{ field, dir: type === 'date' || type === 'number' ? 'desc' : 'asc' }];
}

/** A sort's words: `Started, newest first`, `Name, A to Z`, `Cost, highest first`. */
export function sortText(fields: SearchFields, sort: Sort): string {
  const decl = fields[sort.field];
  const label = decl?.label ?? sort.field;
  const up = sort.dir === 'asc';
  switch (decl?.type) {
    case 'date': return `${label}, ${up ? 'oldest' : 'newest'} first`;
    case 'number': return `${label}, ${up ? 'lowest' : 'highest'} first`;
    case 'text': case 'enum': case 'boolean': case undefined: return `${label}, ${up ? 'A to Z' : 'Z to A'}`;
  }
}

// ─── Suggestions ──────────────────────────────────────────────────────────────

/** A value a field takes, with how many rows have it (the hub's `listValues`). */
export interface ValueOption {
  readonly value: FilterValue;
  readonly label?: string | undefined;
  readonly count?: number;
}

/** One suggestion under the box. */
export type Suggestion =
  /** Add this filter as a pill. */
  | { readonly kind: 'filter'; readonly filter: Filter; readonly label: string; readonly count?: number }
  /** Start a filter on this field (the menu opens on it). */
  | { readonly kind: 'field'; readonly field: string; readonly label: string }
  /** Search these words. */
  | { readonly kind: 'text'; readonly text: string; readonly label: string };

/** What is being typed: a value for a named field (`status:ru`), or loose words. */
export function typing(fields: SearchFields, typed: string): { readonly field?: string; readonly prefix: string } {
  const match = /^([A-Za-z][\w]*)(!:|:)(.*)$/s.exec(typed.trim());
  const field = match === null ? undefined : findField(fields, match[1] ?? '');
  if (match === null || field === undefined) { return { prefix: typed.trim() }; }
  return { field, prefix: (match[3] ?? '').replace(/^"/, '') };
}

const MAX_SUGGESTIONS = 8;

/**
 * The suggestions for what is typed: a whole filter it already spells (`cost>0.01`), values matching it (fixed enum
 * values from the declaration, the rest from `values`, fetched by field), fields whose names start with it, and the
 * words as a plain search. Within a named field (`status:`) only that field's values are offered.
 */
export function suggest(
  fields: SearchFields, typed: string, values: Readonly<Record<string, readonly ValueOption[]>>, format: NumberFormat = plainNumber,
): Suggestion[] {
  const text = typed.trim();
  const out: Suggestion[] = [];
  const spelled = text === '' ? undefined : readFilter(fields, text);
  if (spelled !== undefined) { out.push({ kind: 'filter', filter: spelled, label: pillText(fields, spelled, format) }); }
  const { field: named, prefix } = typing(fields, text);
  const lower = prefix.toLowerCase();
  const candidates = named === undefined ? Object.keys(fields) : [named];
  for (const field of candidates) {
    const decl = fields[field];
    if (decl === undefined || !decl.filterable || (decl.type !== 'enum' && decl.type !== 'boolean' && named === undefined)) { continue; }
    const offered: ValueOption[] = decl.type === 'boolean'
      ? [{ value: true }, { value: false }]
      : [...(decl.values ?? []).map((value) => ({ value })), ...(values[field] ?? [])];
    const seen = new Set<string>();
    for (const option of offered) {
      const words = option.label ?? valueLabel(decl, option.value, format);
      const key = String(option.value);
      if (seen.has(key)) { continue; }
      seen.add(key);
      const matches = lower === '' ? named !== undefined : words.toLowerCase().includes(lower) || key.toLowerCase().includes(lower);
      if (!matches || (decl.type === 'boolean' && named === undefined && lower !== '' && !decl.label.toLowerCase().startsWith(lower))) { continue; }
      const filter: Filter = { field, op: 'is', value: option.value };
      if (spelled !== undefined && JSON.stringify(spelled) === JSON.stringify(filter)) { continue; }
      out.push({ kind: 'filter', filter, label: pillText(fields, filter, format), ...(option.count === undefined ? {} : { count: option.count }) });
    }
  }
  if (named === undefined && text !== '' && spelled === undefined) {
    for (const [field, decl] of Object.entries(fields)) {
      if (decl.filterable && (decl.label.toLowerCase().startsWith(lower) || field.toLowerCase().startsWith(lower))) { out.push({ kind: 'field', field, label: decl.label }); }
    }
  }
  const capped = out.slice(0, MAX_SUGGESTIONS);
  if (named === undefined && text !== '' && spelled === undefined) { capped.push({ kind: 'text', text, label: `Search “${text}”` }); }
  return capped;
}
