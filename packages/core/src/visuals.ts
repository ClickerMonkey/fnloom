/**
 * Visuals (widget pass, after product's query-visuals design): the built-in families every result can be drawn with,
 * the column facts a fit is judged on, and product's coverage-first ranking. All of it is declared data and pure
 * functions, so the hub, the widgets system's authoring agent and the browser judge a fit and rank visuals the same way
 * without running a system's code.
 *
 * - **Facts:** `columnFacts` works out, once per result held, what each column is (numeric, temporal, categorical, an
 *   opaque key that is never drawn), its role (a source's declared `ResultColumn.role` wins, else derived), its
 *   distinct count, nulls and range. A source may add role and key; gin facts (enum members, bounds) come from the
 *   caller's `typeFacts`, since core does not run gin.
 * - **Ranking:** `rankVisuals` binds each visual's channels to columns, checks its rules, and orders the fits by
 *   coverage (distinct columns bound to a channel; a tooltip does not count), then priority (band plus terms), then
 *   registry order. Visuals that can't draw the data are left out (hidden, not greyed).
 * - **Families:** `BUILT_IN_VISUALS` is the table, the value cards and twelve ECharts families, each with a style
 *   picker. The web app draws them; systems may add their own (each bundling ECharts) with the same `VisualShape`.
 *
 * Browser maths over rows (a histogram's bins, a boxplot's quartiles, a pie's "Other") runs only when the result is
 * whole (`ResultFacts.whole`); otherwise the visual is not offered and the agent writes an aggregate query.
 */
import { z } from 'zod';
import { LocalName, type Json } from './primitives.ts';
import {
  COLUMN_KINDS, ColumnKind, ColumnRole, VisualShape, type PriorityBand, type PriorityTerm, type ResultColumn, type ResultTable, type VisualChannel,
  type VisualRule,
} from './registries.ts';

/** The hub's visual registry: every visual any system draws a `ResultTable` with. */
export const HUB_VISUALS = 'hub/visuals';

// ─── Column facts ─────────────────────────────────────────────────────────────

/** What one column is, worked out over the rows held (`columnFacts`). */
export const ColumnFacts = z.object({
  name: z.string().min(1),
  kind: ColumnKind,
  /** The source's declared role, else derived: a number is a measure, text or a date a group key, the rest attributes. */
  role: ColumnRole,
  numeric: z.boolean(),
  temporal: z.boolean(),
  /** A calendar day (drawn in UTC on a time axis), not an instant. */
  day: z.boolean(),
  categorical: z.boolean(),
  /** The row's declared key (`ResultColumn.key`). */
  key: z.boolean(),
  /**
   * Nothing a person reads (uuid values, a key the platform minted, a reference to another row): never drawn, bound or
   * counted. It stays in the rows, so a drill or an action can still say which row was clicked.
   */
  opaque: z.boolean(),
  /** Distinct values among the rows held (evidence about what is in hand, not a claim about the whole result). */
  distinct: z.number().int().min(0),
  /** The share of the rows held whose value is null, 0 to 1. */
  nulls: z.number().min(0).max(1),
  /** Every value held is a number at or above 0. */
  nonNegative: z.boolean(),
  min: z.union([z.number(), z.string()]).optional(),
  max: z.union([z.number(), z.string()]).optional(),
  /** The range its type declares (a percentage's 0 to 100), from the caller's gin facts. */
  bound: z.object({ min: z.number(), max: z.number() }).optional(),
  /** The members its type declares (an enum's), from the caller's gin facts. */
  members: z.array(z.string()).optional(),
});
export type ColumnFacts = z.infer<typeof ColumnFacts>;

/** Every column's facts, how many rows are held, and whether they are the whole result (no page before or after). */
export const ResultFacts = z.object({ columns: z.array(ColumnFacts), rows: z.number().int().min(0), whole: z.boolean() });
export type ResultFacts = z.infer<typeof ResultFacts>;

/** What a column's gin type says that core can't read itself (it runs no gin): an enum's members, a declared range. */
export type TypeFacts = (column: ResultColumn) => Pick<ColumnFacts, 'members' | 'bound'>;

const NUMERIC_KINDS: ReadonlySet<ColumnKind> = new Set(['integer', 'number']);
const TEMPORAL_KINDS: ReadonlySet<ColumnKind> = new Set(['date', 'datetime']);
const CATEGORICAL_KINDS: ReadonlySet<ColumnKind> = new Set(['text', 'boolean']);
/** An anchored canonical uuid: a value that only contains one (a url, a path) is not one. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The role a column takes when its source declares none. */
function derivedRole(kind: ColumnKind): ColumnRole {
  if (NUMERIC_KINDS.has(kind)) { return 'measure'; }
  return TEMPORAL_KINDS.has(kind) || CATEGORICAL_KINDS.has(kind) ? 'group' : 'attribute';
}

/** The smaller or larger of two comparable values (numbers, or ISO dates and text). */
function extreme(a: number | string | undefined, b: number | string, pick: 'min' | 'max'): number | string {
  if (a === undefined) { return b; }
  if (typeof a !== typeof b) { return a; }
  return (pick === 'min' ? b < a : b > a) ? b : a;
}

/**
 * Each column's facts over the rows held, in one pass. Facts are evidence about what is in hand: a buffered pager
 * works them out again over the widest buffer it holds, so the columns offered don't change between windows.
 */
export function columnFacts(table: Pick<ResultTable, 'columns' | 'rows' | 'offset' | 'truncated'>, typeFacts?: TypeFacts): ResultFacts {
  const columns = table.columns.map((column, index): ColumnFacts => {
    const seen = new Set<string>();
    let nulls = 0; let uuids = 0; let values = 0; let nonNegative = true;
    let min: number | string | undefined; let max: number | string | undefined;
    for (const row of table.rows) {
      const value: Json | undefined = row[index];
      if (value === null || value === undefined) { nulls += 1; continue; }
      values += 1;
      seen.add(typeof value === 'object' ? JSON.stringify(value) : String(value));
      if (typeof value === 'string' && UUID_PATTERN.test(value)) { uuids += 1; }
      if (typeof value === 'number' || typeof value === 'string') { min = extreme(min, value, 'min'); max = extreme(max, value, 'max'); }
      if (typeof value !== 'number' || value < 0) { nonNegative = false; }
    }
    const kind = column.kind;
    const key = column.key === true;
    const opaque = kind === 'uuid' || (values > 0 && uuids === values) || column.ref !== undefined || kind === 'binary';
    return {
      name: column.name, kind, role: column.role ?? derivedRole(kind),
      numeric: NUMERIC_KINDS.has(kind), temporal: TEMPORAL_KINDS.has(kind), day: kind === 'date', categorical: CATEGORICAL_KINDS.has(kind),
      key, opaque, distinct: seen.size, nulls: table.rows.length === 0 ? 0 : nulls / table.rows.length, nonNegative: nonNegative && values > 0,
      ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }),
      ...(typeFacts?.(column) ?? {}),
    };
  });
  return { columns, rows: table.rows.length, whole: table.offset === 0 && !table.truncated };
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

/** Channel name → the columns bound to it, in order. */
export const VisualBinding = z.record(LocalName, z.array(z.string().min(1)).min(1));
export type VisualBinding = z.infer<typeof VisualBinding>;

/** A visual that can draw a result: its default binding, its coverage and priority, the styles that fit, and why. */
export const VisualRank = z.object({
  visual: LocalName,
  coverage: z.number().int().min(0),
  priority: z.number(),
  bind: VisualBinding,
  /** The styles of the visual that fit, the default first. */
  styles: z.array(LocalName).min(1),
  /** One phrase per rule that counted, for the switcher's tooltip and tests. */
  because: z.array(z.string()),
});
export type VisualRank = z.infer<typeof VisualRank>;

/** A visual as ranking sees it: its registry name and declared shape (registry order is the array order). */
export interface RankedEntry {
  readonly name: string;
  readonly shape: VisualShape;
}

/** Each priority band's base (product's bands). */
export const PRIORITY_BAND_BASE: Readonly<Record<PriorityBand, number>> = { floor: 0, structural: 10, encoded: 20, 'time-encoded': 30 };

/** Each priority term's weight, and why it is there. */
export const PRIORITY_TERM_WEIGHT: Readonly<Record<PriorityTerm, number>> = {
  /** A date key reads as a time series before it reads as a pie. */
  'temporal-key': 15,
  /** Few categories (at most `LOW_CARDINALITY_MAX`) fit a phone-width axis. */
  'low-cardinality': 10,
  /** A key with declared members is a real category, not free text. */
  'enum-key': 8,
  /** More than half of a bound column is empty. */
  'high-null': -10,
  /** More slices than `PART_TO_WHOLE_COMFORT` stop comparing well as angles. */
  'many-categories': -10,
};

/** The most categories that still fit a phone-width axis. */
export const LOW_CARDINALITY_MAX = 8;
/** The slice count a pie still compares well at; above it the pie takes `many-categories`. */
export const PART_TO_WHOLE_COMFORT = 5;
/** The share of nulls above which a bound column counts as `high-null`. */
export const HIGH_NULL_SHARE = 0.5;

/** The columns a result's visuals may bind: every column a person reads, or every column when none is readable. */
function informative(facts: ResultFacts): ColumnFacts[] {
  return facts.columns.filter((column) => !column.opaque);
}

/** Whether a column can be bound to a channel. */
function takes(channel: VisualChannel, column: ColumnFacts): boolean {
  return channel.accepts.includes(column.kind) && (channel.role === undefined || channel.role === column.role);
}

/**
 * Whether a column would split nothing as an optional grouping (a series or lane): one value per row, as free text
 * (a note's body) has, makes a group per row, a legend of every value and bars pushed off their labels.
 */
function splitsNothing(channel: VisualChannel, column: ColumnFacts, rows: number): boolean {
  return !channel.required && channel.role === 'group' && rows > 1 && column.distinct >= rows;
}

/** The default binding of a shape's channels over the readable columns, or why it has none. */
function defaultBinding(shape: VisualShape, columns: readonly ColumnFacts[], rows: number): VisualBinding | string {
  const bind: VisualBinding = {};
  const used = new Set<string>();
  for (const channel of shape.channels) {
    const free = columns.filter((column) => !used.has(column.name) && takes(channel, column) && !splitsNothing(channel, column, rows)).map((column) => column.name);
    const picked = channel.many ? free : free.slice(0, 1);
    if (picked.length < (channel.many ? channel.min ?? 1 : 1)) {
      if (channel.required) { return `No column fits ${channel.label} (${channel.accepts.join(', ')}).`; }
      continue;
    }
    const [first, ...rest] = picked;
    if (first === undefined) { continue; }
    bind[channel.name] = [first, ...rest];
    for (const name of picked) { used.add(name); }
  }
  return bind;
}

/** The facts of the columns bound to a channel. */
function bound(bind: VisualBinding, channel: string, facts: ResultFacts): ColumnFacts[] {
  return (bind[channel] ?? []).flatMap((name) => facts.columns.filter((column) => column.name === name));
}

/** Why a rule fails for a binding, or `undefined` when it holds. */
function ruleProblem(rule: VisualRule, bind: VisualBinding, facts: ResultFacts, rows: readonly (readonly Json[])[] | undefined, columns: readonly ResultColumn[] | undefined): string | undefined {
  switch (rule.rule) {
    case 'distinct':
      return bound(bind, rule.channel, facts).some((column) => column.distinct > rule.max) ? `${rule.channel} has more than ${String(rule.max)} values.` : undefined;
    case 'non-negative':
      return bound(bind, rule.channel, facts).every((column) => column.nonNegative) ? undefined : `${rule.channel} has values below 0.`;
    case 'bounded':
      return bound(bind, rule.channel, facts).every((column) => column.bound !== undefined) || bind['max'] !== undefined ? undefined : `${rule.channel} has no known range.`;
    case 'distinct-columns': {
      const names = rule.channels.flatMap((channel) => bind[channel] ?? []);
      return new Set(names).size === names.length ? undefined : `${rule.channels.join(' and ')} need different columns.`;
    }
    case 'links': {
      if (rows === undefined || columns === undefined) { return undefined; }
      const at = (channel: string): number => columns.findIndex((column) => column.name === bind[channel]?.[0]);
      const from = at(rule.from); const to = at(rule.to);
      if (from < 0 || to < 0) { return `${rule.to} must name values of ${rule.from}.`; }
      const keys = new Set(rows.map((row) => JSON.stringify(row[from] ?? null)));
      return rows.every((row) => row[to] === null || keys.has(JSON.stringify(row[to] ?? null))) ? undefined : `${rule.to} names values that are not ${rule.from} values.`;
    }
  }
}

/** The priority terms that apply to a binding, and the score they add to the shape's band. */
function priorityOf(shape: VisualShape, bind: VisualBinding, facts: ResultFacts): { priority: number; because: string[] } {
  const columns = Object.values(bind).flat().flatMap((name) => facts.columns.filter((column) => column.name === name));
  const groups = columns.filter((column) => column.role === 'group');
  const applies: Readonly<Record<PriorityTerm, boolean>> = {
    'temporal-key': groups.some((column) => column.temporal),
    'low-cardinality': groups.length > 0 && groups.every((column) => column.distinct <= LOW_CARDINALITY_MAX),
    'enum-key': groups.some((column) => column.members !== undefined),
    'high-null': columns.some((column) => column.nulls > HIGH_NULL_SHARE),
    'many-categories': groups.some((column) => column.distinct > PART_TO_WHOLE_COMFORT),
  };
  const terms = shape.priority.terms.filter((term) => applies[term]);
  return {
    priority: PRIORITY_BAND_BASE[shape.priority.band] + terms.reduce((sum, term) => sum + PRIORITY_TERM_WEIGHT[term], 0),
    because: terms.map((term) => `${term} (${String(PRIORITY_TERM_WEIGHT[term])})`),
  };
}

/** The styles of a shape that fit a binding and a result's wholeness, the default first. */
function fittingStyles(shape: VisualShape, bind: VisualBinding, whole: boolean): string[] {
  return shape.styles.filter((style) => (style.whole !== true || whole) && (style.needs ?? []).every((channel) => bind[channel] !== undefined)).map((style) => style.name);
}

/**
 * Whether a shape can draw a result with a binding, and why not: every required channel bound to columns of kinds it
 * takes, the row count in range, a whole result for a `whole` visual, and every rule holding. `rows`/`columns` let
 * the `links` rule look at values (browser maths over a held result); without them it is not judged.
 */
export function bindingProblems(shape: VisualShape, bind: VisualBinding, facts: ResultFacts, table?: Pick<ResultTable, 'rows' | 'columns'>): string[] {
  const problems: string[] = [];
  for (const channel of shape.channels) {
    const names = bind[channel.name] ?? [];
    if (names.length === 0) { if (channel.required) { problems.push(`${channel.label} is not bound.`); } continue; }
    if (!channel.many && names.length > 1) { problems.push(`${channel.label} takes one column.`); }
    if (channel.many && names.length < (channel.min ?? 1)) { problems.push(`${channel.label} needs at least ${String(channel.min ?? 1)} columns.`); }
    for (const name of names) {
      const column = facts.columns.find((c) => c.name === name);
      if (column === undefined) { problems.push(`${channel.label}: there is no column ${name}.`); continue; }
      if (column.opaque) { problems.push(`${channel.label}: ${name} holds nothing a person reads.`); }
      if (!channel.accepts.includes(column.kind)) { problems.push(`${channel.label}: ${name} is ${column.kind}, not ${channel.accepts.join(' or ')}.`); }
    }
  }
  if (facts.rows < shape.rows.min) { problems.push(`Needs at least ${String(shape.rows.min)} rows.`); }
  if (shape.rows.max !== undefined && facts.rows > shape.rows.max && shape.size === undefined) { problems.push(`Draws at most ${String(shape.rows.max)} rows.`); }
  if (shape.whole && !facts.whole) { problems.push('Only draws a whole result, and this is one page of it.'); }
  for (const rule of shape.rules) {
    const problem = ruleProblem(rule, bind, facts, table?.rows, table?.columns);
    if (problem !== undefined) { problems.push(problem); }
  }
  return problems;
}

/**
 * Every visual that can draw a result, best first (product's order): coverage (distinct readable columns bound), then
 * priority, then registry order, so the order is total and stable. A visual that can't draw the data is left out; a
 * client's veto removes one afterwards, never reorders. The table binds every readable column, so a chart beats it
 * only by drawing as much of the result.
 */
export function rankVisuals(entries: readonly RankedEntry[], facts: ResultFacts, table?: Pick<ResultTable, 'rows' | 'columns'>): VisualRank[] {
  const readable = informative(facts);
  const ranked = entries.flatMap((entry, index) => {
    const bind = defaultBinding(entry.shape, readable.length > 0 ? readable : facts.columns, facts.rows);
    if (typeof bind === 'string' || bindingProblems(entry.shape, bind, facts, table).length > 0) { return []; }
    const styles = fittingStyles(entry.shape, bind, facts.whole);
    const [first, ...rest] = styles;
    if (first === undefined) { return []; }
    const { priority, because } = priorityOf(entry.shape, bind, facts);
    const coverage = new Set(Object.values(bind).flat().filter((name) => readable.some((column) => column.name === name))).size;
    return [{ rank: { visual: entry.name, coverage, priority, bind, styles: [first, ...rest], because: [`covers ${String(coverage)}`, ...because] }, index }];
  });
  return ranked.sort((a, b) => b.rank.coverage - a.rank.coverage || b.rank.priority - a.rank.priority || a.index - b.index).map((entry) => entry.rank);
}

// ─── The built-in families ────────────────────────────────────────────────────

const NUM: ColumnKind[] = ['integer', 'number'];
const TIME: ColumnKind[] = ['date', 'datetime'];
const CAT: ColumnKind[] = ['text', 'boolean'];
const KEY: ColumnKind[] = ['text', 'boolean', 'date', 'datetime'];
/** The most slices a part-to-whole visual draws before folding the rest into "Other". */
export const PART_TO_WHOLE_MAX_SLICES = 20;
/** The most categories on one axis before a category visual draws the first ones and says so. */
export const CATEGORY_COMFORT = 50;

/** One channel, required and single unless said. */
function ch(name: string, label: string, accepts: readonly ColumnKind[], options: Partial<Pick<VisualChannel, 'required' | 'many' | 'min' | 'role'>> = {}): VisualChannel {
  return { name, label, accepts: [...accepts], required: options.required ?? true, many: options.many ?? false, ...(options.min === undefined ? {} : { min: options.min }), ...(options.role === undefined ? {} : { role: options.role }) };
}

/** The built-in visual families, in registry order. */
export const VISUAL_FAMILIES = ['table', 'value', 'part', 'category', 'time', 'distribution', 'crosstab', 'calendar', 'timeline', 'network', 'hierarchy', 'gauge', 'finance'] as const;
export const VisualFamily = z.enum(VISUAL_FAMILIES);
export type VisualFamily = z.infer<typeof VisualFamily>;

/** A built-in visual: its switcher label and icon, one line about it, and its declared shape. */
export interface BuiltInVisual {
  readonly label: string;
  readonly icon: string;
  readonly description: string;
  readonly shape: VisualShape;
}

/**
 * The app's own visuals (the hub contributes them to `HUB_VISUALS`; the web app draws them, the twelve chart families
 * with ECharts): every ECharts series that draws from rows and columns, grouped into families with a style picker.
 * Map and lines need geography and are not here; pictorial bars and rippling points are styles.
 */
export const BUILT_IN_VISUALS: Readonly<Record<VisualFamily, BuiltInVisual>> = {
  table: {
    label: 'Table', icon: 'table', description: 'Every readable column and row, sortable and paged; cards on a phone.',
    shape: VisualShape.parse({
      channels: [ch('columns', 'Columns', COLUMN_KINDS, { required: false, many: true })], rows: { min: 0 }, whole: false, size: 'window', pageSize: 10,
      styles: [{ name: 'table', label: 'Table' }, { name: 'compact', label: 'Compact' }, { name: 'cards', label: 'Cards' }], priority: { band: 'floor', terms: [] },
    }),
  },
  value: {
    label: 'Value', icon: 'hash', description: 'One to four rows of values as cards, each labelled by its column.',
    shape: VisualShape.parse({
      channels: [ch('value', 'Values', COLUMN_KINDS, { many: true })], rows: { min: 1, max: 4 }, whole: true,
      styles: [{ name: 'cards', label: 'Cards' }, { name: 'single', label: 'Single' }], priority: { band: 'encoded', terms: [] },
    }),
  },
  part: {
    label: 'Part of a whole', icon: 'chart', description: 'Slices of a whole: one per category, sized by a measure.',
    shape: VisualShape.parse({
      channels: [ch('itemName', 'Slice', KEY, { role: 'group' }), ch('value', 'Size', NUM, { role: 'measure' })], rows: { min: 1, max: 100 }, whole: true, size: 'partition',
      rules: [{ rule: 'non-negative', channel: 'value' }],
      styles: [{ name: 'pie', label: 'Pie' }, { name: 'doughnut', label: 'Doughnut' }, { name: 'rose', label: 'Rose' }, { name: 'half', label: 'Half doughnut' }, { name: 'funnel', label: 'Funnel' }],
      priority: { band: 'encoded', terms: ['low-cardinality', 'enum-key', 'many-categories'] },
    }),
  },
  category: {
    label: 'Bars', icon: 'chart', description: 'Measures per category, with an optional second key as series.',
    shape: VisualShape.parse({
      channels: [ch('x', 'Category', KEY, { role: 'group' }), ch('y', 'Values', NUM, { many: true, role: 'measure' }), ch('series', 'Series', CAT, { required: false, role: 'group' })],
      rows: { min: 1, max: CATEGORY_COMFORT }, whole: false, size: 'top-n',
      styles: [
        { name: 'bar', label: 'Bars' }, { name: 'stacked', label: 'Stacked' }, { name: 'percent', label: '100%', whole: true }, { name: 'horizontal', label: 'Horizontal' },
        { name: 'line', label: 'Line' }, { name: 'area', label: 'Area' }, { name: 'radar', label: 'Radar' }, { name: 'polar', label: 'Polar bars' }, { name: 'pictorial', label: 'Pictorial' },
      ],
      priority: { band: 'encoded', terms: ['low-cardinality', 'enum-key', 'high-null'] },
    }),
  },
  time: {
    label: 'Over time', icon: 'chart', description: 'Measures along a date axis, zoomable; zooming can set the from/to args.',
    shape: VisualShape.parse({
      channels: [ch('x', 'Date', TIME, { role: 'group' }), ch('y', 'Values', NUM, { many: true, role: 'measure' }), ch('series', 'Series', CAT, { required: false, role: 'group' })],
      rows: { min: 2 }, whole: false, size: 'window', claims: [{ claim: 'range', channel: 'x' }],
      styles: [
        { name: 'line', label: 'Line' }, { name: 'smooth', label: 'Smooth' }, { name: 'area', label: 'Area' }, { name: 'stacked', label: 'Stacked area' },
        { name: 'step', label: 'Step' }, { name: 'bar', label: 'Bars' }, { name: 'river', label: 'Stream', needs: ['series'] },
      ],
      priority: { band: 'time-encoded', terms: ['temporal-key', 'high-null'] },
    }),
  },
  distribution: {
    label: 'Distribution', icon: 'chart', description: 'How numbers spread: points, bubbles, bins, boxes or parallel axes.',
    shape: VisualShape.parse({
      channels: [
        ch('x', 'X', NUM), ch('y', 'Y', NUM, { required: false }), ch('size', 'Size', NUM, { required: false }),
        ch('group', 'Group', CAT, { required: false }), ch('dims', 'More axes', NUM, { required: false, many: true, min: 1 }),
      ],
      rows: { min: 2, max: 5000 }, whole: false,
      styles: [
        { name: 'scatter', label: 'Points', needs: ['y'] }, { name: 'bubble', label: 'Bubbles', needs: ['y', 'size'] }, { name: 'pulse', label: 'Rippling points', needs: ['y'] },
        { name: 'histogram', label: 'Histogram', whole: true }, { name: 'boxplot', label: 'Box plot', whole: true }, { name: 'parallel', label: 'Parallel axes', needs: ['y', 'dims'] },
      ],
      priority: { band: 'structural', terms: ['high-null'] },
    }),
  },
  crosstab: {
    label: 'Cross-tab', icon: 'grid', description: 'A measure for each pair of two keys: a heatmap, value cells or small charts.',
    shape: VisualShape.parse({
      channels: [ch('x', 'Columns', KEY, { role: 'group' }), ch('y', 'Rows', KEY, { role: 'group' }), ch('value', 'Value', NUM, { role: 'measure' })],
      rows: { min: 2 }, whole: false, size: 'top-n',
      rules: [{ rule: 'distinct-columns', channels: ['x', 'y'] }, { rule: 'distinct', channel: 'x', max: CATEGORY_COMFORT }, { rule: 'distinct', channel: 'y', max: CATEGORY_COMFORT }],
      styles: [{ name: 'heatmap', label: 'Heatmap' }, { name: 'cells', label: 'Value cells' }, { name: 'multiples', label: 'Small charts' }],
      priority: { band: 'encoded', terms: ['low-cardinality'] },
    }),
  },
  calendar: {
    label: 'Calendar', icon: 'calendar', description: 'Days on a calendar, shaded by a measure; the month shown can set the from/to args.',
    shape: VisualShape.parse({
      channels: [ch('time', 'Date', TIME, { role: 'group' }), ch('value', 'Intensity', NUM, { required: false, role: 'measure' }), ch('label', 'Label', CAT, { required: false })],
      rows: { min: 1 }, whole: false, claims: [{ claim: 'range', channel: 'time' }],
      styles: [{ name: 'month', label: 'Month' }, { name: 'year', label: 'Year' }],
      priority: { band: 'structural', terms: ['temporal-key'] },
    }),
  },
  timeline: {
    label: 'Timeline', icon: 'calendar', description: 'Bars from a start to an end date, one row each: a gantt chart.',
    shape: VisualShape.parse({
      channels: [ch('start', 'Start', TIME), ch('end', 'End', TIME), ch('label', 'Label', CAT), ch('series', 'Lane', CAT, { required: false })],
      rows: { min: 1, max: 500 }, whole: false, size: 'window', rules: [{ rule: 'distinct-columns', channels: ['start', 'end'] }], claims: [{ claim: 'range', channel: 'start' }],
      styles: [{ name: 'gantt', label: 'Gantt' }, { name: 'timeline', label: 'Timeline' }],
      priority: { band: 'time-encoded', terms: [] },
    }),
  },
  network: {
    label: 'Network', icon: 'graph', description: 'Links between things: each row is an edge from a source to a target.',
    shape: VisualShape.parse({
      channels: [ch('source', 'From', CAT), ch('target', 'To', CAT), ch('value', 'Weight', NUM, { required: false, role: 'measure' })],
      rows: { min: 1, max: 2000 }, whole: true, rules: [{ rule: 'distinct-columns', channels: ['source', 'target'] }],
      styles: [{ name: 'force', label: 'Graph' }, { name: 'circular', label: 'Circle' }, { name: 'sankey', label: 'Flow' }, { name: 'chord', label: 'Chord' }],
      priority: { band: 'structural', terms: [] },
    }),
  },
  hierarchy: {
    label: 'Hierarchy', icon: 'tree', description: 'A tree from a name and its parent column, sized by a measure.',
    shape: VisualShape.parse({
      channels: [ch('name', 'Name', CAT), ch('parent', 'Parent', CAT), ch('value', 'Size', NUM, { required: false, role: 'measure' })],
      rows: { min: 2, max: 5000 }, whole: true, rules: [{ rule: 'distinct-columns', channels: ['name', 'parent'] }, { rule: 'links', from: 'name', to: 'parent' }],
      styles: [{ name: 'tree', label: 'Tree' }, { name: 'radial', label: 'Radial tree' }, { name: 'treemap', label: 'Treemap' }, { name: 'sunburst', label: 'Sunburst' }],
      priority: { band: 'structural', terms: [] },
    }),
  },
  gauge: {
    label: 'Gauge', icon: 'gauge', description: 'One value against its known range.',
    shape: VisualShape.parse({
      channels: [ch('value', 'Value', NUM, { role: 'measure' }), ch('max', 'Maximum', NUM, { required: false })], rows: { min: 1, max: 1 }, whole: true,
      rules: [{ rule: 'bounded', channel: 'value' }], styles: [{ name: 'gauge', label: 'Gauge' }, { name: 'progress', label: 'Progress ring' }],
      priority: { band: 'encoded', terms: [] },
    }),
  },
  finance: {
    label: 'Candlestick', icon: 'chart', description: 'Open, high, low and close per period, with optional volume.',
    shape: VisualShape.parse({
      channels: [ch('x', 'Period', KEY, { role: 'group' }), ch('open', 'Open', NUM), ch('close', 'Close', NUM), ch('low', 'Low', NUM), ch('high', 'High', NUM), ch('volume', 'Volume', NUM, { required: false })],
      rows: { min: 2 }, whole: false, size: 'window', claims: [{ claim: 'range', channel: 'x' }],
      styles: [{ name: 'candlestick', label: 'Candles' }, { name: 'volume', label: 'Candles and volume', needs: ['volume'] }],
      priority: { band: 'time-encoded', terms: ['temporal-key'] },
    }),
  },
};

/** The built-in visuals as ranking takes them, in registry order. */
export const BUILT_IN_ENTRIES: readonly RankedEntry[] = VISUAL_FAMILIES.map((name) => ({ name, shape: BUILT_IN_VISUALS[name].shape }));

/** How many colours the categorical chart palette has (`--chart-1` … `--chart-8` in the web app's tokens). */
export const CHART_PALETTE_SIZE = 8;
