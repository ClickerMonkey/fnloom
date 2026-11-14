/**
 * The fns the mock hub lets someone open (a run card's fn in a chat, the runs browser, a graph node, the agent and
 * invocation lists) that its systems' generated fn lists don't carry, written as their systems declare them: the
 * description, kind, args, effects and group of the real contract (`systems/<name>/shared`, the hub's own in
 * `packages/sdk/src/hub.ts`), the saved queries with their SQL. `systemFns` adds these to a system's list, so the fn
 * modal (which finds a fn in its system's fns) loads every one of them, as the real hub's catalog would.
 */
import { InstanceName, QualifiedName, splitName, type FnDecl, type FnRecord, type GinTypeDef, type SystemName } from '@harness/core';
import { fnRecord } from '../src/admin/test/fakes.ts';

const text: GinTypeDef = { name: 'text' };
const num: GinTypeDef = { name: 'num' };
const bool: GinTypeDef = { name: 'bool' };
const any: GinTypeDef = { name: 'any' };
const optional = (inner: GinTypeDef): GinTypeDef => ({ name: 'optional', generic: { T: inner } });
const list = (inner: GinTypeDef): GinTypeDef => ({ name: 'list', generic: { V: inner } });
const obj = (props: Record<string, GinTypeDef>): GinTypeDef => ({ name: 'obj', props: Object.fromEntries(Object.entries(props).map(([key, type]) => [key, { type }])) });

/** One fn as its system declares it: the parts that differ from a plain native read. */
interface Openable {
  readonly name: string;
  readonly description: string;
  readonly decl?: Partial<FnDecl>;
  readonly origin?: FnRecord['origin'];
  /** Its runs so far, for its numbers. */
  readonly runs: number;
}

const SAMPLE_SQL = `SELECT family, label, value
FROM chart_samples
WHERE family = $1
ORDER BY position`;

const REFUND_SQL = `UPDATE orders
SET status = 'refunded', refunded_at = now()
WHERE id = ANY($1)
RETURNING id, total`;

/** A saved query of the `shop` instance, routed to it, with its SQL. */
function shopQuery(local: string, description: string, sql: string, args: GinTypeDef, write: boolean): Partial<FnDecl> {
  return {
    kind: 'database/query', payload: { instance: 'shop', description, sql }, readable: { language: 'sql', code: sql }, args, returns: any,
    deps: ['database/shop.Orders'].map((n) => QualifiedName.parse(n)), tags: ['database', 'query', ...(write ? ['write'] : [])],
    routing: { to: 'instance', instance: InstanceName.parse('shop') }, effects: { mode: write ? 'write' : 'read', free: true }, name: `shop.${local}`,
  };
}

const OPENABLE: readonly Openable[] = [
  // fs: the real contract's names (the generated list has stand-ins such as read_file)
  { name: 'fs/read', description: 'Read a text file, or part of it by line.', runs: 412, decl: { group: 'files', args: obj({ path: text, offset: optional(num), limit: optional(num) }), returns: obj({ text, lines: num, truncated: bool }), effects: { mode: 'read', free: true }, flags: true, tags: ['read'] } },
  { name: 'fs/write', description: 'Write a file, creating it if needed.', runs: 96, decl: { group: 'files', args: obj({ path: text, text }), returns: obj({ created: bool }), effects: { mode: 'write', free: true }, flags: true, tags: [] } },
  { name: 'fs/edit', description: 'Replace exact text in a file.', runs: 188, decl: { group: 'files', args: obj({ path: text, find: text, replace: text, all: optional(bool) }), returns: obj({ replacements: num }), effects: { mode: 'write', free: true }, flags: true, tags: [] } },
  { name: 'fs/bash', description: 'Run a shell command. It runs in the working folder set with cd unless cwd is given.', runs: 254, decl: { group: 'shell', args: obj({ command: text, cwd: optional(text), timeout: optional(num) }), returns: obj({ exitCode: num, stdout: text, stderr: text }), effects: { mode: 'delete', free: true }, flags: true, progress: { type: 'linear' }, tags: [] } },
  { name: 'fs/install_system', description: 'Build, check and start a system folder on this machine, and connect it to the hub, once an admin approves.', runs: 9, decl: { group: 'systems', args: obj({ path: text, instance: optional(text), replace: optional(bool) }), returns: obj({ system: text, instance: text, version: text, status: text, fns: list(text), folder: text }), effects: { mode: 'write', registry: [{ thing: 'fns', action: 'create' }] }, visibility: 'llm', tags: [] } },
  { name: 'fs/explore', description: 'Answers questions about the code by reading it.', runs: 31, decl: { group: 'files', kind: 'hub/llm', args: obj({ question: text }), returns: text, effects: { mode: 'read' }, tags: ['agent'] } },
  // the database's own fns, and the shop instance's saved queries the chats ran
  { name: 'database/apply_type_changes', description: 'Apply the table type changes a rescan found that would break saved queries or drop a type. Proposed by the system for an admin to approve.', runs: 2, decl: { group: 'schema', args: obj({ scan: text }), returns: obj({ applied: num }), visibility: 'none', effects: { mode: 'write', free: true, registry: [{ thing: 'types', action: 'update' }, { thing: 'types', action: 'remove' }] }, tags: [] } },
  { name: 'database/query', description: 'Run a saved query.', runs: 64, decl: { group: 'queries', args: obj({ name: text, args: optional(any) }), returns: any, effects: { mode: 'read', free: true }, tags: ['read'] } },
  { name: 'database/create_query', description: 'Write a query from a description and save it as a fn.', runs: 12, decl: { group: 'queries', args: obj({ instance: text, request: text }), returns: obj({ fn: text }), effects: { mode: 'write', registry: [{ thing: 'fns', action: 'create', kind: 'database/query' }] }, tags: [] } },
  { name: 'database/shop.sample', description: 'One sample table per chart family, for the chart gallery.', runs: 22, origin: 'runtime', decl: shopQuery('sample', 'One sample table per chart family, for the chart gallery.', SAMPLE_SQL, obj({ family: text }), false) },
  { name: 'database/shop.refund_orders', description: 'Refund orders by id: marks them refunded and returns their totals.', runs: 4, origin: 'runtime', decl: shopQuery('refund_orders', 'Refund orders by id: marks them refunded and returns their totals.', REFUND_SQL, obj({ ids: list(num) }), true) },
  // claude: the runs it proposes for the person, never called by a model
  { name: 'claude/permit', description: 'Let Claude use a tool it waits on (the person\'s approval of the proposed run); a decline denies it with the reason.', runs: 6, decl: { group: 'attention', args: obj({ instance: text, session: text, request: text, tool: text, input: any, always: bool }), returns: obj({ allowed: bool }), visibility: 'none', effects: { mode: 'write', free: true }, tags: [] } },
  { name: 'claude/answer', description: 'Give Claude the person\'s answer to a question it waits on (the form on the proposed run); a decline tells Claude the person did not answer.', runs: 3, decl: { group: 'attention', args: obj({ instance: text, session: text, request: text, from: text, answer: any }), returns: obj({ answered: bool }), visibility: 'none', effects: { mode: 'write', free: true }, tags: [] } },
  // widgets and the hub's own
  { name: 'widgets/make_widget', description: 'Propose a widget (a chart, calendar, cards or table with its controls and presets) over a fn that returns a table; the person saves it.', runs: 11, decl: { group: 'widgets', args: obj({ source: text, request: text, args: optional(any), widget: optional(text), show: bool }), returns: any, effects: { mode: 'read' }, tags: [] } },
  { name: 'hub/records_table', description: 'Records of one stored type as a table (one column per field, then the record id), offset-paged: what widgets and the result view draw.', runs: 58, decl: { group: 'data', args: obj({ type: text, query: optional(any), search: optional(text), offset: optional(num), limit: optional(num) }), returns: any, effects: { mode: 'read', free: true }, tags: ['read'] } },
  { name: 'hub/chat', description: 'The chat agent.', runs: 640, decl: { kind: 'hub/llm', args: obj({ message: text }), returns: text, tags: ['agent'] } },
  // notes, as the graph shows them
  { name: 'notes/add', description: 'Add a note.', runs: 27, decl: { args: obj({ title: text, body: text }), returns: obj({ id: text }), effects: { mode: 'write', writes: [QualifiedName.parse('notes/note')] }, tags: [] } },
  { name: 'notes/list', description: 'List the notes.', runs: 45, decl: { args: obj({ limit: optional(num) }), returns: list(any), effects: { mode: 'read', reads: [QualifiedName.parse('notes/note')] }, tags: ['read'] } },
];

/** The fn as its system's fn list holds it. */
function recordOf(fn: Openable, now: number): FnRecord {
  const name = QualifiedName.parse(fn.name);
  const { system, local } = splitName(name);
  const base = fnRecord().decl;
  return fnRecord({
    name, system, version: `v${String(fn.runs % 7 + 1)}`, origin: fn.origin ?? 'contract', available: true, paused: false, disabled: false, updatedAt: now - fn.runs * 60_000,
    stats: { outcomes: { done: fn.runs, 'invalid-input': 0, failed: Math.floor(fn.runs / 40), cancelled: 0 }, averageCost: 0, averageTime: 40 + fn.runs % 90, tokens: 0, lastRunAt: now - fn.runs * 30_000 },
    decl: { ...base, name: local, description: fn.description, ...fn.decl },
  });
}

/** A system's fns with those it lacks of the openable ones added (a fn it already lists stays as it is). */
export function withOpenable(system: SystemName, listed: readonly FnRecord[], now: number): FnRecord[] {
  const have = new Set<string>(listed.map((fn) => fn.name));
  return [...listed, ...OPENABLE.filter((fn) => fn.name.startsWith(`${system}/`) && !have.has(fn.name)).map((fn) => recordOf(fn, now))];
}
