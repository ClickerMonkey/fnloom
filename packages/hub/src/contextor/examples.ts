/**
 * Examples as the model writes them. A fn's example args are kept in the code shape (qualified fn names, records as
 * objects, absent optionals absent); the model writes args in the shape of the schema it was sent, which can differ
 * (records as `[{key, value}]` pairs and absent optionals as `null` on a strict dialect, a fn's name as the model name
 * its tools spell, deep parts as JSON text). Every example a model reads goes through `@aeye/schema`'s encoder for the
 * schema it illustrates, never as JSON written by hand or respelled by the fn-name guess (`ModelFnNames.text`):
 *
 * - **A tool's own examples** (a fn's native tool, a static tool, `run`): a deferred value (`deferEncode`) of the
 *   tool's args. `@aeye/core`'s `prepareRequest` writes it through the request's plan once the provider has planned
 *   the request for its model, so the example is the shape of the schema sent with it, plan adjustments included
 *   (optionals as `null` past Anthropic's budget, a tool behind the dispatcher).
 * - **Static mode's fn cards** (in the prompt, a result's exposed cards, a suggestion, a page of `hub/fns_examples`):
 *   the fn is run through `run`, so its example is `run`'s `args` for that fn, a deferred value of that part of `run`
 *   (`path`), its fn names as the model's tools spell them: on a dialect of pairs (OpenAI strict, Anthropic strict,
 *   Gemini's OpenAPI subset) one string of JSON text, elsewhere an open object. The text protocol has no tools: there
 *   the hub reads a block's args back itself, in the code shape with its fn names as the model spells them (`LENIENT`
 *   with the prompt's names).
 * - **Tools mode, a fn that isn't a tool here** (a suggestion, a page of `hub/fns_examples`): as its tool takes them
 *   once loaded, the fn's args planned alone for the model (`profileFor(model)`), kept from the fn-name speller as a
 *   value already written (`verbatim`).
 * - **Outside a prompt** (an MCP's inspect, the web) and in a hub fn's own output (static `inspect`, whose result is
 *   kept on its run): the code shape with the model's fn names, or plain.
 *
 * Before a plan exists (estimates, previews, records) a deferred value reads as its fallback, the code shape with the
 * prompt's fn names (`plainDeferred`). An example's result is shown as results come back (`ModelFnNames.value`, by the
 * fn's result type). An example its schema no longer fits (a stale one) is shown as it was written.
 */
import { deferEncode, DEFERRED_SPAN, LENIENT, ModelProfile, plainDeferred, profileFor, type Bound, type DeferredSpec, type ModelLike } from '@aeye/schema';
import type { AnyFnRef } from '@harness/sdk';
import { ginBundle, type Json, type FnExample, type FnNameSpelling, type FnRecord, type ModelFnNames } from '@harness/core';
import type { FnView } from './index.ts';

/** An example as a card or tool shows it: its args and result as the model reads them, and its note. */
export interface ShownExample {
  readonly args: string;
  readonly result?: string | undefined;
  readonly note?: string | undefined;
}

/** How one prompt shows fns' example args (and their results). */
export interface ExampleWriter {
  /** A fn's args as the model would write them here: JSON text, or a deferred value written when the request is planned. */
  args(view: Pick<FnView, 'record' | 'signature'>, args: Json): string;
  /** A hub fn's args (one the hub's contract declares) the same way. */
  contract(ref: AnyFnRef, args: Json): string;
  /** An example's result as results reach the model here. */
  result(record: Pick<FnRecord, 'decl'>, result: Json): string;
}

/** The name a lone tool is planned under, to write one fn's args as its tool takes them. */
const LONE_TOOL = 'args';

/**
 * A value written as the lone tool of a request planned for `target` (its schema `bound`), read back to check it: the
 * code shape (`plain`) when it doesn't fit or doesn't read back as itself (a stale example, an optional nullable field a
 * strict dialect can only write as `null`).
 */
function writeAlone(bound: Bound<object>, target: ModelProfile, value: Json, plain: () => unknown): unknown {
  try {
    const entry = target.request([{ kind: 'tool', name: LONE_TOOL, schema: bound }]).get(LONE_TOOL);
    const code = bound.render(LENIENT).parse(value, { inPlace: false, repair: false });
    if (!code.ok) return plain();
    const wire = entry.encode(code.value);
    const back = entry.parse(wire, { inPlace: false, repair: false });
    return back.ok && JSON.stringify(back.value) === JSON.stringify(code.value) ? wire : plain();
  } catch {
    return plain();
  }
}

/** The hub contract fns' args as `a` schemas, made once each. */
const contractBundles = new Map<string, ReturnType<typeof ginBundle<object>>>();
function contractArgs(ref: AnyFnRef, names: FnNameSpelling | undefined): Bound<object> {
  let bundle = contractBundles.get(ref.name);
  if (bundle === undefined) contractBundles.set(ref.name, (bundle = ginBundle<object>(ref.args)));
  return bundle.bind(ref.args.registry, names);
}

/** Outside a prompt: the code shape. */
export const PLAIN_EXAMPLES: ExampleWriter = {
  args: (_view, args) => JSON.stringify(args),
  contract: (_ref, args) => JSON.stringify(args),
  result: (_record, result) => JSON.stringify(result),
};

/**
 * A value already in the model's shape, kept as it is by the fn-name speller (`ModelFnNames.text` skips deferred
 * values); `spelled` writes it as this JSON.
 */
export function verbatim(wire: unknown): string {
  return deferEncode({ value: wire });
}

/** The code shape with the prompt's fn names: what the hub reads back itself (a `<run>` block), and every fallback. */
function named(names: ModelFnNames, args: Json, record?: Pick<FnRecord, 'decl'>): unknown {
  return record === undefined ? args : names.value(args, record.decl.args);
}

/**
 * Fns' args as their own tool takes them once loaded, planned alone for `target` (tools mode: the model's profiles;
 * the text protocol: `LENIENT`). `protect`: each comes as a `verbatim` value, for text the hub spells afterwards (the
 * prompt's region, a message), else as JSON text (a hub fn's own output).
 */
export function loneToolExamples(names: ModelFnNames, target: ModelProfile, protect = true): ExampleWriter {
  const text = (value: unknown): string => (protect ? verbatim(value) : JSON.stringify(value));
  return {
    args: (view, args) => text(writeAlone(view.signature.argsFor(names), target, args, () => named(names, args, view.record))),
    contract: (ref, args) => text(writeAlone(contractArgs(ref, names), target, args, () => args)),
    result: (record, result) => text(names.value(result, record.decl.returns)),
  };
}

/**
 * Static mode's cards with native tools: a fn's example is `run`'s args for it, a deferred value of `run`'s `args`
 * (`path`) written through the request's plan: one string of JSON text on a dialect of pairs, an open object elsewhere.
 * Its fn-name fields are spelled as the model's tools spell them (the code shape of the fn's args bound with the
 * prompt's names: `g.fnName()` fields only, so `run` reads every one back, through the fn's own args where the prompt
 * decodes them, hub-side by `ModelFnNames.read` where it doesn't; other text is left as it is). Its fallback, before a
 * plan or where the request has no `run`, is that same code shape as JSON.
 */
export function runExamples(names: ModelFnNames, protect = true): ExampleWriter {
  const run = (args: unknown): string => {
    const plain = JSON.stringify(args);
    return protect ? deferEncode({ tool: 'run', path: 'args', value: args, fallback: plain }) : plain;
  };
  return {
    args: (view, args) => run(writeAlone(view.signature.argsFor(names), ModelProfile.of(LENIENT), args, () => named(names, args, view.record))),
    contract: (ref, args) => run(writeAlone(contractArgs(ref, names), ModelProfile.of(LENIENT), args, () => args)),
    result: (record, result) => (protect ? verbatim(names.value(result, record.decl.returns)) : JSON.stringify(names.value(result, record.decl.returns))),
  };
}

/** The mode a prompt shows fns in, for its writer. */
export type ExamplesMode = 'tools' | 'static' | 'text';

/**
 * A prompt's writer for examples that aren't a tool's own: tools mode, each fn as its tool once loaded under the
 * model's profiles (`LENIENT` for a model the hub doesn't know); static mode, `run`'s args; the text protocol, the code
 * shape with the prompt's fn names.
 */
export function promptExamples(mode: ExamplesMode, names: ModelFnNames, model: ModelLike | undefined, protect = true): ExampleWriter {
  switch (mode) {
    case 'tools': return loneToolExamples(names, model === undefined ? ModelProfile.of(LENIENT) : profileFor(model), protect);
    case 'static': return runExamples(names, protect);
    case 'text': return loneToolExamples(names, ModelProfile.of(LENIENT), protect);
  }
}

/**
 * A tool's own examples, in its description: each a deferred value of the tool's args, written through the request's
 * plan once the provider has planned it (its fallback: the code shape with the prompt's fn names). Results through
 * `names.value`, kept from the speller (`verbatim`).
 */
export function toolExamples(tool: string, names: ModelFnNames | undefined): Pick<ExampleWriter, 'args' | 'result'> {
  return {
    args: (view, args) => deferEncode({ tool, value: args, ...(names === undefined ? {} : { fallback: JSON.stringify(named(names, args, view.record)) }) }),
    result: (record, result) => verbatim(names === undefined ? result : names.value(result, record.decl.returns)),
  };
}

/** Examples as a card or tool shows them, through a writer. */
export function shownExamples(view: Pick<FnView, 'record' | 'signature'>, examples: readonly FnExample[], writer: Pick<ExampleWriter, 'args' | 'result'>): ShownExample[] {
  return examples.map((example) => ({
    args: writer.args(view, example.args),
    ...(example.result === undefined ? {} : { result: writer.result(view.record, example.result) }),
    ...(example.note === undefined ? {} : { note: example.note }),
  }));
}

/** Whether a deferred value is one only the request's plan can write (a tool's or the output's), not a `verbatim` one. */
function planned(value: string): boolean {
  const json = /^⟦\w+ (.*)⟧$/s.exec(value)?.[1];
  if (json === undefined) return false;
  try {
    const spec: unknown = JSON.parse(json);
    return typeof spec === 'object' && spec !== null && (('tool' satisfies keyof DeferredSpec) in spec || ('output' satisfies keyof DeferredSpec) in spec);
  } catch {
    return false;
  }
}

/**
 * Text for the model with its fns spelled (`ModelFnNames.text`, prose only), then each `verbatim` value written as it
 * is. A deferred value of a tool stays for the request's plan to write (`prepareRequest`), its fallback in estimates.
 */
export function spelled(names: Pick<ModelFnNames, 'text'>, text: string): string {
  const spoken = names.text(text);
  return spoken.split(DEFERRED_SPAN).map((part, index) => (index % 2 === 1 && !planned(part) ? plainDeferred(part) : part)).join('');
}

/**
 * A JSON text holding deferred values as strings (written into JSON before it was stringified): each such string put
 * back as the deferred value itself, so the text reads as JSON with the value in place once it is written.
 */
export function inlineDeferred(json: string): string {
  return json.replace(/"(⟦(?:encode|schema) (?:[^"\\]|\\.)*⟧)"/g, (whole, quoted: string) => {
    try {
      const value: unknown = JSON.parse(`"${quoted}"`);
      return typeof value === 'string' ? value : whole;
    } catch {
      return whole;
    }
  });
}
