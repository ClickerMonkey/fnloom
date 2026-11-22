/**
 * Every fn a model can call is sent as a strict tool whose parameters are the JSON schema the hub derives from the fn's
 * gin args (`StoreCatalog.signature`). A position in that schema with nothing in it (`{}`, or only a description)
 * tells the model nothing and lets the hub's own check accept anything: that is how `create_table` failed, when its
 * row type was a `z.custom` that became gin `any`. This test loads the hub's and every system's real manifest into
 * the catalog and fails on any such position, except the ones listed below, each with the reason it is any JSON.
 */
import { manifestOf, hub, type AnyContract } from '@harness/sdk';
import { QualifiedName, type Manifest } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../packages/hub/src/catalog/catalog.ts';
import type { KindDescriber } from '../packages/hub/src/catalog/index.ts';
import { withHubGroups } from '../packages/hub/src/boot/hub-groups.ts';
import { fnModeTool } from '../packages/hub/src/contextor/modes.ts';
import { CatalogFnViews } from '../packages/hub/src/contextor/views.ts';
import { agentTool, PendingCalls } from '../packages/hub/src/execution/tools.ts';
import { RecordingBus, memoryLog, testStore } from '../packages/hub/src/testing.ts';
import { api } from '../systems/api/shared/index.ts';
import { claude } from '../systems/claude/shared/index.ts';
import { code } from '../systems/code/shared/index.ts';
import { database } from '../systems/database/shared/index.ts';
import { embedderSystem } from '../systems/embedder/shared/index.ts';
import { fs } from '../systems/fs/shared/index.ts';
import { googleCalendar } from '../systems/google-calendar/shared/index.ts';
import { input } from '../systems/input/shared/index.ts';
import { mcp } from '../systems/mcp/shared/index.ts';
import { web } from '../systems/web/shared/index.ts';
import { widgets } from '../systems/widgets/shared/index.ts';

const SYSTEMS: readonly AnyContract[] = [api, claude, code, database, embedderSystem, fs, googleCalendar, input, mcp, web, widgets];

/**
 * Positions that are any JSON on purpose, as `fn` then the dotted path in its args. Each says why; a new entry needs a
 * reason as good, and a position that can be typed should be typed instead. Most are a value whose type another arg
 * names (a record of the type named, a system's config): the hub checks the value against that type when the fn runs.
 */
const ANY_JSON: Readonly<Record<string, string>> = {
  'hub/fns_save payload': "the payload of the kind named; that kind's system checks and describes it before it is saved",
  'hub/fns_save examples.[].args': "values of the saved fn's own args type, checked against it on save",
  'hub/fns_save examples.[].result': "values of the saved fn's own returns type, checked against it on save",
  'hub/connection_update settings': "the connection's system's settings type, checked against it",
  'hub/connection_update fns': "options keyed by fn name: a record over open keys, which a gin obj cannot say",
  'hub/record_save value': "a record of the type named, checked against that type",
  'hub/record_update set': "fields of the type named, checked against that type",
  'hub/set_actor_setting value': "the named setting's own type, checked against it",
  'hub/approve_pairing config': "the system's config type, checked against it",
  'hub/configure_system config': "the system's config type, checked against it",
  'hub/install_system config': "the system's config type, checked against it",
  'hub/install_package config': "the package's config type, checked against it",
  'hub/add_instance config': "the system's config type, checked against it",
  'api/test_request params.[].value': "a parameter value serialised by the operation's style: text, a number, a list or an object",
  'database/run_query args': "values of the saved query's own args, checked against them",
  'widgets/make_widget args': "values of the widget's own args, checked against them",
};

/**
 * Inside gin's TypeDef schema (an arg that holds a gin type), a literal's value, an enum's values and a class's options
 * in an inline extension are any JSON by gin's design: gin parses the definition, which checks them.
 */
const GIN_TYPEDEF_INSIDE = [/\.options\.(\*|value|values\.\*)$/, /^\$defs\.__schema\d+\|\d+\.value$/];

/** A JSON schema node. */
type Node = Readonly<Record<string, unknown>>;

/** Keys that make a JSON schema say something about its value. */
const SAYS = ['type', 'anyOf', 'oneOf', 'allOf', '$ref', 'const', 'enum', 'not'];

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The dotted paths in a JSON schema whose schema says nothing. */
function emptyPositions(schema: Node, path: string, out: string[], seen: Set<Node>): string[] {
  if (seen.has(schema)) { return out; }
  seen.add(schema);
  if (!SAYS.some((key) => key in schema)) { out.push(path === '' ? '(args)' : path); return out; }
  const at = (part: string) => (path === '' ? part : `${path}.${part}`);
  const properties = schema['properties'];
  if (isNode(properties)) { for (const [key, child] of Object.entries(properties)) { if (isNode(child)) { emptyPositions(child, at(key), out, seen); } } }
  const extra = schema['additionalProperties'];
  if (isNode(extra)) { emptyPositions(extra, at('*'), out, seen); }
  const items = schema['items'];
  if (isNode(items)) { emptyPositions(items, at('[]'), out, seen); }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const members = schema[key];
    if (Array.isArray(members)) { members.forEach((member, i) => { if (isNode(member)) { emptyPositions(member, `${path}|${i}`, out, seen); } }); }
  }
  const defs = schema['$defs'];
  if (isNode(defs)) { for (const [key, child] of Object.entries(defs)) { if (isNode(child)) { emptyPositions(child, `$defs.${key}`, out, seen); } } }
  return out;
}

/** The hub's and every system's manifest, imported into a catalog. */
async function catalogOfEverything(): Promise<{ catalog: StoreCatalog; manifests: Manifest[] }> {
  const describer: KindDescriber = { describe: () => Promise.resolve({ problems: ['not in this test'] }) };
  const catalog = new StoreCatalog({ store: await testStore(), bus: new RecordingBus(), log: memoryLog().log, clock: () => 1_000, describer });
  const manifests = [withHubGroups(await manifestOf(hub, { version: '1.0.0' })), ...await Promise.all(SYSTEMS.map((contract) => manifestOf(contract, { version: '1.0.0', resources: false })))];
  for (const manifest of manifests) {
    const report = await catalog.importManifest(manifest);
    // fns of a kind (hub/chat) need their kind's system to describe them; they are checked where that runs
    expect(report.refused.filter((refusal) => !refusal.problems.includes('not in this test')), manifest.name).toEqual([]);
  }
  return { catalog, manifests };
}

describe('tool schemas', () => {
  it('give every arg position of every fn a model can call a schema, but the listed any-JSON ones', async () => {
    const { catalog, manifests } = await catalogOfEverything();
    const found: string[] = [];
    let checked = 0;
    for (const manifest of manifests) {
      for (const fn of manifest.fns) {
        if (fn.visibility !== 'llm' && fn.visibility !== 'both') { continue; }
        const name = `${manifest.name}/${fn.name}`;
        if (await catalog.fn(QualifiedName.parse(name)) === undefined) { continue; } // a kind's fn this test can't describe
        const { argsJsonSchema } = await catalog.signature(QualifiedName.parse(name));
        checked += 1;
        for (const position of emptyPositions(argsJsonSchema, '', [], new Set())) {
          if (ANY_JSON[`${name} ${position}`] === undefined && !GIN_TYPEDEF_INSIDE.some((inside) => inside.test(position))) { found.push(`${name} ${position}`); }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(found).toEqual([]);
  });

  it('let the chat model create and edit saved queries only by describing them, never with query JSON', async () => {
    const manifest = await manifestOf(database, { version: '1.0.0', resources: false });
    const visible = new Set(manifest.fns.filter((fn) => fn.visibility === 'llm' || fn.visibility === 'both').map((fn) => fn.name));
    expect([...visible]).toEqual(expect.arrayContaining(['get_query', 'edit_query']));
    // query JSON is only ever the authoring agent's: no fn takes a draft from outside it
    expect(manifest.fns.map((fn) => fn.name)).not.toEqual(expect.arrayContaining(['check_query']));
    expect(manifest.fns.map((fn) => fn.name)).not.toEqual(expect.arrayContaining(['save_query']));
    expect(visible.has('author_query')).toBe(false);
    for (const fn of manifest.fns.filter((item) => visible.has(item.name))) {
      expect(JSON.stringify(fn.args), fn.name).not.toContain('"draft"');
    }
  });

  it("sends create_table's row type as gin's obj TypeDef schema, and refuses the shapes a model guessed", async () => {
    const { catalog } = await catalogOfEverything();
    const signature = await catalog.signature(QualifiedName.parse('database/create_table'));
    const text = JSON.stringify(signature.argsJsonSchema);
    expect(text).toContain('"const":"obj"');
    const row = { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, title: { type: { name: 'text' } } } };
    expect(signature.argsSchema.safeParse({ table: 'Todo', type: row }).success).toBe(true);
    for (const type of ['{"id":"string"}', [{ key: 'id', value: 'integer' }], null, { id: 'integer' }, { name: 'obj', props: { id: { type: { name: 'integer' } } } }]) {
      expect(signature.argsSchema.safeParse({ table: 'Todo', type }).success, JSON.stringify(type)).toBe(false);
    }
  });

  it("refuses, in the hub's own check of a chat call, query JSON sent to the query fns and wrong row types sent to alter_table", async () => {
    const { catalog } = await catalogOfEverything();
    const check = async (fn: string, args: unknown) => (await catalog.signature(QualifiedName.parse(fn))).argsSchema.safeParse(args).success;
    const query = { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'orders', field: 'id' } }], from: { kind: 'type', type: 'orders' } };
    expect(await check('database/get_query', { detailedDescription: 'paid orders' })).toBe(true);
    expect(await check('database/get_query', { detailedDescription: 'paid orders', query })).toBe(false);
    expect(await check('database/get_query', { query })).toBe(false);
    expect(await check('database/edit_query', { name: 'database/main.orders', instructions: 'Add the date.' })).toBe(true);
    expect(await check('database/edit_query', { name: 'database/main.orders', instructions: 'Add the date.', query })).toBe(false);
    const row = { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, done: { type: { name: 'bool' } } } };
    expect(await check('database/alter_table', { table: 'Todo', type: row })).toBe(true);
    for (const type of [{ done: 'boolean' }, [{ name: 'done', type: 'bool' }], JSON.stringify(row), { name: 'obj', props: { done: { type: 'bool' } } }]) {
      expect(await check('database/alter_table', { table: 'Todo', type }), JSON.stringify(type)).toBe(false);
    }
  });
});

/**
 * Phil (2026-11-21): "Verify tool calls are sending json schema and if examples are available are sending at least
 * one." Every fn the chat model can see has an example (docs/harness.md "Kinds"), and its native tool in tools mode
 * ends its description with the first one, whether or not the turn chose any, and that description is what the model
 * gets (`agentTool`).
 */
describe('tool examples', () => {
  it('give every fn a model can see at least one example, and send the first with its native tool', async () => {
    const { catalog, manifests } = await catalogOfEverything();
    const views = new CatalogFnViews(catalog);
    const missing: string[] = [];
    const unsent: string[] = [];
    let checked = 0;
    for (const manifest of manifests) {
      for (const fn of manifest.fns) {
        if (fn.visibility !== 'llm' && fn.visibility !== 'both') { continue; }
        const name = `${manifest.name}/${fn.name}`;
        const [first] = fn.examples ?? [];
        if (first === undefined) { missing.push(name); continue; }
        const view = await views.view(QualifiedName.parse(name));
        if (view === undefined) { continue; } // a kind's fn this test can't describe
        for (const chosen of [undefined, []]) {
          const tool = fnModeTool(view, [], chosen);
          if (tool === undefined) { continue; }
          checked += 1;
          const sent = agentTool(tool, new PendingCalls()).input.description;
          if (!sent.includes(`Example args: ${JSON.stringify(first.args)}`) || tool.spec.parameters === undefined) { unsent.push(name); }
        }
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(100);
    expect([...new Set(unsent)]).toEqual([]);
  });
});
