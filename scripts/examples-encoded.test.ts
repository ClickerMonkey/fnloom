/**
 * Every example a model is shown is written as that model writes the args it illustrates, and reads back through the
 * schema actually sent with it: no example the model is shown is refused by its own schema. For OpenAI strict
 * (records as `[{key, value}]` pairs, absent optionals as `null`), Anthropic strict, Gemini and a model with no strict
 * dialect (the code shape), over the hub's and every system's real fns (plus one with a record, an optional field and
 * a fn's name, so all three are always covered):
 *
 * - **tools mode**: each fn's native tool, its examples in its description written through the request's plan
 *   (several fns per request, and every fn in one request, so the tool cap's dispatcher is covered too);
 * - **static mode**: the five static tools' and `run`'s examples, through their own plan entries; the fn cards'
 *   examples as `run`'s args for that fn (the fn's own args in the code shape, its fn names as the model spells them);
 * - **examples of a fn that isn't a tool here** (a suggestion, a page of `hub/fns_examples`): through the fn's own
 *   args under the model's tool profile, as it is sent once loaded.
 *
 * The systems' authoring prompts are checked where they run, in each system's test (`examplesChecked`).
 */
import { planRequest, type ToolDefinition } from '@aeye/core';
import { DEFERRED_SPAN, fillDeferred, plainDeferred, profileFor, type DeferredSpec, type ModelLike, type RenderedRequest, type RequestEntry } from '@aeye/schema';
import { fn, g, manifestOf, system } from '@harness/sdk';
import { DIALECT_MODELS } from '@harness/sdk/testing';
import { JsonObject, QualifiedName, type FnExample } from '@harness/core';
import { describe, expect, it } from 'vitest';
import type { FnView } from '../packages/hub/src/contextor/index.ts';
import { promptExamples } from '../packages/hub/src/contextor/examples.ts';
import { fnModeTool, modeNames, ownArgs, REPLACED_BY_STATIC, runTool, staticToolOf } from '../packages/hub/src/contextor/modes.ts';
import { CatalogFnViews } from '../packages/hub/src/contextor/views.ts';
import type { ModeTool } from '../packages/hub/src/contextor/index.ts';
import { catalogOfEverything } from './everything.ts';

/** A fn whose args hold a record, an optional field and a fn's name, with examples that use each. */
const rich = system('rich', { description: 'Rich args.' }).with({
  fns: {
    plan: fn({
      description: 'Plans spending per category for a fn.',
      args: g.obj({ fn: g.fnName(), limits: g.record(g.num()), note: g.optional(g.text()), tags: g.list(g.text()) }),
      returns: g.text(),
      examples: [
        { args: { fn: 'fs/read', limits: { food: 200, rent: 900 }, tags: ['home'] }, note: 'No note.' },
        { args: { fn: 'hub/fns_search', limits: {}, note: 'nothing yet', tags: [] }, result: 'ok' },
      ],
    }),
  },
});

/** Every fn a model can see with object args, as its view, with its examples. */
async function everything() {
  const { catalog, manifests } = await catalogOfEverything();
  const extra = await manifestOf(rich, { version: '1.0.0' });
  await catalog.importManifest(extra);
  const views = new CatalogFnViews(catalog);
  const found: FnView[] = [];
  for (const manifest of [...manifests, extra]) {
    for (const decl of manifest.fns) {
      if (decl.visibility !== 'llm' && decl.visibility !== 'both') continue;
      const view = await views.view(QualifiedName.parse(`${manifest.name}/${decl.name}`));
      if (view !== undefined && (view.record.decl.examples ?? []).length > 0) found.push(view);
    }
  }
  return { views: found, names: await modelNamesOf(catalog) };
}

/** The fn names a prompt speaks in each mode, over the catalog. */
async function modelNamesOf(catalog: Awaited<ReturnType<typeof catalogOfEverything>>['catalog']) {
  return { tools: modeNames('tools', await catalog.modelNames()), static: modeNames('static', await catalog.modelNames()) };
}

/** A request of these tools, planned for a model as its provider would (`planRequest`), on copies of their definitions. */
async function planned(tools: readonly ModeTool[], model: ModelLike): Promise<RenderedRequest> {
  const definitions = await Promise.all(tools.map(async (tool): Promise<ToolDefinition> => ({
    name: tool.name, description: tool.spec.description ?? tool.description, parameters: await Promise.resolve(tool.schema.bind()), strict: 1,
  })));
  return planRequest({ tools: definitions }, model);
}

/** A plan's entry by name (a plan of runtime tools is typed by no item names). */
function entryOf(plan: RenderedRequest, name: string): RequestEntry {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the names are runtime data
  return plan.get(name as never) as unknown as RequestEntry;
}

/** The deferred values of a text. */
function deferredIn(text: string): Array<{ text: string; spec: DeferredSpec }> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `deferEncode` wrote it
  return text.split(DEFERRED_SPAN).filter((_part, index) => index % 2 === 1).map((part) => ({ text: part, spec: JSON.parse(/^⟦\w+ (.*)⟧$/s.exec(part)?.[1] ?? '{}') as DeferredSpec }));
}

/** Whether two JSON values are the same, key order aside. */
function same(x: unknown, y: unknown): boolean {
  return JSON.stringify(sorted(x)) === JSON.stringify(sorted(y));
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
}

/** Each tool example of these tools, filled through the plan and read back through its own entry: the problems. */
function toolProblems(tools: readonly ModeTool[], plan: RenderedRequest, label: string): { problems: string[]; checked: number; differ: number } {
  const problems: string[] = [];
  let checked = 0;
  let differ = 0;
  for (const tool of tools) {
    for (const { text, spec } of deferredIn(tool.spec.description ?? tool.description)) {
      if (spec.tool === undefined) continue;
      const written = fillDeferred(text, plan);
      const back = entryOf(plan, spec.tool).parseText(written, { repair: false });
      checked += 1;
      if (written !== plainDeferred(text)) differ += 1;
      if (!back.ok) problems.push(`${label} ${tool.name}: ${written}\n${back.message}`);
      else if (!same(back.value, spec.value)) problems.push(`${label} ${tool.name}: ${JSON.stringify(spec.value)} reads back as ${JSON.stringify(back.value)}`);
    }
  }
  return { problems, checked, differ };
}

const label = (model: ModelLike): string => model.id;

describe('every example a model is shown reads back through the schema sent with it', () => {
  it.each(DIALECT_MODELS.map((model) => [label(model), model] as const))('tools mode, %s: each fn tool\'s examples, a few tools a request and all at once', async (_name, model) => {
    const { views, names } = await everything();
    const tools = views.flatMap((view) => {
      const tool = fnModeTool(view, [], view.record.decl.examples ?? [], names.tools);
      return tool === undefined ? [] : [tool];
    });
    expect(tools.length).toBeGreaterThan(100);
    const problems: string[] = [];
    let checked = 0;
    let differ = 0;
    for (let at = 0; at < tools.length; at += 20) {
      const some = tools.slice(at, at + 20);
      const found = toolProblems(some, await planned(some, model), label(model));
      problems.push(...found.problems);
      checked += found.checked;
      differ += found.differ;
    }
    // every fn at once: past the tool cap the rest go behind the dispatcher, each still with its own entry
    problems.push(...toolProblems(tools, await planned(tools, model), `${label(model)} (all)`).problems);
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(100);
    // on a strict dialect the shapes differ (pairs, nulls, the fns' model names); a lenient one still spells fns
    expect(differ).toBeGreaterThan(0);
  });

  it.each(DIALECT_MODELS.map((model) => [label(model), model] as const))('static mode, %s: the static tools, run, and the cards as run\'s args', async (_name, model) => {
    const { views, names } = await everything();
    const decoded = ownArgs();
    for (const view of views) decoded.set(view.record.name, view.signature.argsFor().root);
    const tools: ModeTool[] = [...(['find', 'find_ctx', 'inspect', 'load', 'unload'] as const).map((name) => staticToolOf(name, false, names.static)), runTool(false, names.static, decoded)];
    const plan = await planned(tools, model);
    const { problems, checked } = toolProblems(tools, plan, label(model));
    expect(problems).toEqual([]);
    expect(checked).toBe(tools.length);
    // a card's example: run's args for that fn, as the model sends them (on a strict dialect, JSON text of this content)
    const writer = promptExamples('static', names.static, model);
    const run = entryOf(plan, 'run');
    const cards: string[] = [];
    // the fns whose jobs the static tools do are never shown in static mode
    for (const view of views.filter((one) => !REPLACED_BY_STATIC.has(one.record.name))) {
      for (const example of view.record.decl.examples ?? []) {
        // the card shows run's args for the fn as this plan writes them
        const shown: unknown = JSON.parse(fillDeferred(writer.args(view, example.args), plan));
        const sent = { fn: names.static.name(view.record.name), args: shown, ...(run.profile.optional === 'null' ? { on: null } : {}) };
        const back = run.parse(sent, { inPlace: false, repair: false });
        if (!back.ok) { cards.push(`${label(model)} ${view.record.name}: ${JSON.stringify(sent)}\n${back.message}`); continue; }
        const value = JsonObject.parse(back.value);
        if (value['fn'] !== view.record.name || !same(value['args'], example.args)) cards.push(`${label(model)} ${view.record.name}: ${JSON.stringify(example.args)} reads back as ${JSON.stringify(value)}`);
      }
    }
    expect(cards).toEqual([]);
  });

  it.each(DIALECT_MODELS.map((model) => [label(model), model] as const))('a fn that isn\'t a tool here, %s: its args as its tool would take them once loaded', async (_name, model) => {
    const { views, names } = await everything();
    const writer = promptExamples('tools', names.tools, model);
    const problems: string[] = [];
    let pairs = 0;
    for (const view of views) {
      const entry = profileFor(model).request([{ kind: 'tool', name: 'it', schema: view.signature.argsFor(names.tools) }]).get('it');
      for (const example of view.record.decl.examples ?? [] satisfies FnExample[]) {
        const wire: unknown = JSON.parse(plainDeferred(writer.args(view, example.args)));
        if (JSON.stringify(wire).includes('"key":')) pairs += 1;
        const back = entry.parse(wire, { inPlace: false, repair: false });
        if (!back.ok) problems.push(`${label(model)} ${view.record.name}: ${JSON.stringify(wire)}\n${back.message}`);
        else if (!same(back.value, example.args)) problems.push(`${label(model)} ${view.record.name}: ${JSON.stringify(example.args)} reads back as ${JSON.stringify(back.value)}`);
      }
    }
    expect(problems).toEqual([]);
    // records go as pairs exactly where the dialect wants them
    if (profileFor(model).tool.records === 'pairs') expect(pairs).toBeGreaterThan(0);
  });
});

describe('the code shape before a plan', () => {
  it('reads every deferred value as its fallback: the code shape with the fn names the prompt speaks', async () => {
    const { views, names } = await everything();
    const view = views.find((one) => one.record.name === 'rich/plan');
    const tool = view === undefined ? undefined : fnModeTool(view, [], view.record.decl.examples ?? [], names.tools);
    expect(plainDeferred(tool?.spec.description ?? '')).toContain('Example args: {"fn":"fs__read","limits":{"food":200,"rent":900},"tags":["home"]}');
  });
});
