/**
 * Authoring agents: a fn that writes something hard (a query, a gin type, an expression, later an API or code) runs a
 * sub-agent on `ctx.ai()` through a fixed workflow, so the chat model only passes a description of what it wants and
 * gets back the saved fn, never the working context. Ported from product's kind agents (`kinds/authoring.ts`,
 * `kinds/disclosure.ts`): search first, then load what is needed a little at a time, then draft against a typed
 * schema, check, fix and save.
 *
 * - **Stages:** find → inspect → draft → check → fix → save. A stage's tools are offered only once the stage before
 *   it is done (aeye's `dynamic` prompt re-resolves the tools every round; each tool's `applicable` reads the stage).
 * - **Disclosure:** `Disclosure` keeps what the agent has seen (aware), loaded and searched, per level, so a load tool
 *   is offered only while something is aware but not loaded, and nothing is printed twice.
 * - **Check and fix:** the `draft` tool checks every draft at once and answers with the problems; a draft that fails
 *   moves the agent to `fix`. Past the fix cap (`HARNESS_AUTHORING_FIXES`) the run fails with the last problems.
 * - **Save:** `save` is offered only after a draft checked clean. `reuse` (in `find`) answers with an existing fn.
 * - **Shape:** an agent handed what it builds on (a report given its source fn) skips `find` (`stages: { find:
 *   false }`), and may name its draft and save tools for its job (`toolNames: { draft: 'report_check', save:
 *   'report_save' }`).
 *
 * The loop is aeye's own (`ai.prompt` with tools); this helper adds no second loop.
 */
import type { AI, AIContextRequired, AIMetadataRequired } from '@aeye/ai';
import type { ToolCompatible } from '@aeye/core';
import { a, Bound, deferEncode, LENIENT, type Bindable, type ErrorFormatInput, type JsonSchema } from '@aeye/schema';
import { env } from '@ayepi/env';
import { z } from 'zod';
import { g, json, type Infer } from './gin.ts';
import { HUB_MODEL, type HarnessAi } from './server/llm.ts';

/** The authoring agents' tunables. */
export const authoringEnv = env({
  /** How many failed checks an authoring agent may fix before it gives up. */
  HARNESS_AUTHORING_FIXES: z.coerce.number().int().min(0).default(3),
  /** The most model rounds one authoring run takes. */
  HARNESS_AUTHORING_ROUNDS: z.coerce.number().int().min(2).default(24),
  /**
   * The most tokens one model step of an authoring run may write (its `maxTokens`). A draft is a few thousand tokens at
   * most; without a cap a stuck model once wrote 65k tokens of whitespace into one call over four minutes. A step that
   * reaches it comes back to the model as that call's error (the hub's stream guard), so it writes a smaller call.
   */
  HARNESS_AUTHORING_MAX_TOKENS: z.coerce.number().int().min(256).default(16_000),
});

/** The fixed workflow, in order. `fix` is entered when a check fails and left when a draft checks clean. */
export const AUTHORING_STAGES = ['find', 'inspect', 'draft', 'check', 'fix', 'save'] as const;
export type AuthoringStage = (typeof AUTHORING_STAGES)[number];

/** The stages a tool belongs to (`check` and `fix` are the built-in `draft` tool's; `save` the built-in `save`). */
export type ToolStage = 'find' | 'inspect' | 'draft';

/** The stage an agent may leave out: `find`, when it is handed what it builds on. */
export type SkippableStage = 'find';

/**
 * What an authoring fn answers the chat model with: the saved fn, what it does, how to call it again, and a short
 * preview of what it gives. Never the working context.
 */
export const authoredFn = g.obj({
  /** The fn's qualified name. */
  fn: g.text({ minLength: 1 }),
  version: g.num({ whole: true, min: 1 }),
  /** One line: `database/main.overdue(customer: text, limit?: num)`. */
  signature: g.text(),
  about: g.text(),
  /** An existing fn was the answer; nothing new was saved. */
  reused: g.bool(),
  /** A short look at what it gives (the first rows, the type), when there is one. */
  preview: g.optional(json()),
  /** How to call it again, as the chat model would write the call. */
  call: g.text(),
});
export type AuthoredFn = Infer<typeof authoredFn>;

/** What a check of a draft found: the problems (one per line; empty when it is clean) and a preview when clean. */
export interface DraftCheck {
  readonly problems: readonly string[];
  readonly preview?: AuthoredFn['preview'];
  /** Extra text for the model about the draft (the SQL it makes, the type it produces). */
  readonly note?: string;
}

/**
 * What has been seen, loaded and searched, per level (`type`, `fn`, `table`, …): product's progressive disclosure
 * bookkeeping. Aware names have appeared somewhere (a search result, a reference); loaded names are fully shown.
 */
export class Disclosure {
  readonly #aware = new Map<string, Set<string>>();
  readonly #loaded = new Map<string, Set<string>>();
  readonly #searched = new Set<string>();

  /** A level's search ran, even with no results: a search proving absence is when creating becomes right. */
  markSearched(level: string): void {
    this.#searched.add(level);
  }

  searched(level: string): boolean {
    return this.#searched.has(level);
  }

  markAware(level: string, names: readonly string[]): void {
    const set = this.#set(this.#aware, level);
    for (const name of names) set.add(name);
  }

  /** Loading makes a name aware too. */
  markLoaded(level: string, names: readonly string[]): void {
    this.markAware(level, names);
    const set = this.#set(this.#loaded, level);
    for (const name of names) set.add(name);
  }

  isLoaded(level: string, name: string): boolean {
    return this.#loaded.get(level)?.has(name) ?? false;
  }

  /** Names seen but not loaded yet, in the order they were seen: what a load tool may load. */
  awareUnloaded(level: string): string[] {
    const loaded = this.#loaded.get(level);
    return [...(this.#aware.get(level) ?? [])].filter((name) => !(loaded?.has(name) ?? false));
  }

  loaded(level: string): string[] {
    return [...(this.#loaded.get(level) ?? [])];
  }

  #set(map: Map<string, Set<string>>, level: string): Set<string> {
    const known = map.get(level);
    if (known !== undefined) return known;
    const made = new Set<string>();
    map.set(level, made);
    return made;
  }
}

/** One run's working state: the stage reached, what was disclosed, the draft and its last check, the result. */
export class AuthoringSession<S, D> {
  readonly disclosure = new Disclosure();
  /** Each stage a tool call has completed. */
  readonly #done = new Set<AuthoringStage>();
  #draft: D | undefined;
  #check: DraftCheck | undefined;
  #fixes = 0;
  #result: AuthoredFn | undefined;
  #stopped: DraftCheck | undefined;
  #log: Array<{ stage: AuthoringStage; tool: string }> = [];

  /** What the caller asked for, word for word. */
  readonly request: string;
  /** The authoring fn's own state (the database, the instance, the type registry, …). */
  readonly state: S;

  /** `skip`: stages the agent has no use for, done from the start (`find` for an agent handed what it builds on). */
  constructor(request: string, state: S, skip: readonly SkippableStage[] = []) {
    this.request = request;
    this.state = state;
    for (const stage of skip) { this.#done.add(stage); }
  }

  /** The current stage: the first one not done, `fix` while the last check failed, `save` once it passed. */
  get stage(): AuthoringStage {
    if (this.#result !== undefined) return 'save';
    if (this.#check !== undefined) return this.#check.problems.length === 0 ? 'save' : 'fix';
    if (this.#draft !== undefined) return 'check';
    for (const stage of ['find', 'inspect'] as const) if (!this.#done.has(stage)) return stage;
    return 'draft';
  }

  /** Whether a tool of a stage may be offered now: every stage before it is done, and the run is still going. */
  open(stage: ToolStage): boolean {
    if (!this.going) return false;
    switch (stage) {
      case 'find': return true;
      case 'inspect': return this.#done.has('find');
      case 'draft': return this.#done.has('find') && this.#done.has('inspect');
    }
  }

  /** Mark a stage done (a tool call of that stage succeeded). */
  done(stage: AuthoringStage, tool: string): void {
    this.#done.add(stage);
    this.#log.push({ stage, tool });
  }

  get draft(): D | undefined {
    return this.#draft;
  }

  get lastCheck(): DraftCheck | undefined {
    return this.#check;
  }

  get fixes(): number {
    return this.#fixes;
  }

  get result(): AuthoredFn | undefined {
    return this.#result;
  }

  /** The tools called, in order, with their stage: what tests and status lines read. */
  get log(): ReadonlyArray<{ stage: AuthoringStage; tool: string }> {
    return this.#log;
  }

  /** Keep a draft and its check; a failed check after an earlier draft counts as a fix. */
  checked(draft: D, check: DraftCheck): void {
    if (this.#check !== undefined && this.#check.problems.length > 0) this.#fixes += 1;
    this.#draft = draft;
    this.#check = check;
  }

  finish(result: AuthoredFn): void {
    this.#result = result;
  }

  /** Give up: the fix cap was reached with this check. Every tool is withdrawn. */
  stop(check: DraftCheck): void {
    this.#stopped = check;
  }

  /** The check it gave up on, when it did. */
  get stopped(): DraftCheck | undefined {
    return this.#stopped;
  }

  /** Neither saved nor given up. */
  get going(): boolean {
    return this.#result === undefined && this.#stopped === undefined;
  }
}

/**
 * A call's args as the model will write them: `show('set', { draft: … })` is a deferred value (`@aeye/schema`'s
 * `deferEncode`), written through the plan the hub's provider makes for the model the request goes to (records as
 * pairs and absent optionals as `null` on a strict dialect, …). A tool of the agent that isn't offered this round goes
 * with its schema, so it is written as that tool would be sent to this model. `path`: the value is that part of the
 * args (`'draft'`: a draft alone). Every example call an authoring prompt shows goes through it, never as JSON written
 * by hand.
 */
export type ShowArgs = (tool: string, args: unknown, path?: string) => string;

/** Text for the model that may show example calls: as it is, or made with `ShowArgs` each round. */
export type AuthoringText = string | ((show: ShowArgs) => string);

/** An authoring text for this round. */
function textOf(text: AuthoringText, show: ShowArgs): string {
  return typeof text === 'string' ? text : text(show);
}

/** One tool of an authoring agent, typed by its args; `authoringTool` erases the args for the agent's list. */
export interface AuthoringToolInput<S, D, I extends object> {
  readonly name: string;
  /** What it does, for the model. */
  readonly description: string;
  /** How and when to use it, for the model (added to the prompt's tools section); example calls through `ShowArgs`. */
  readonly instructions?: AuthoringText;
  readonly stage: ToolStage;
  /** Its args (`AuthoringSchema`): an `a` schema, or one bound from the session (a typed schema per instance). */
  readonly schema: AuthoringSchema<S, D, I>;
  /** Offered only while this also holds (a load tool while something is aware but not loaded). */
  readonly when?: (session: AuthoringSession<S, D>) => boolean;
  /** aeye's strictness for its args (default: prefer strict). */
  readonly strict?: boolean | number;
  /** How args that don't fit are told back to the model (aeye's default when absent: its JSON, marked where it is wrong). */
  readonly errorFormat?: ErrorFormatInput;
  /** Do it; the text is what the model reads. A thrown error is shown to the model as the tool's failure. */
  call(input: I, session: AuthoringSession<S, D>): Promise<string> | string;
}

/** An authoring tool with its args type erased: it makes its aeye tool for a session. */
export interface AuthoringTool<S, D> {
  readonly name: string;
  readonly stage: ToolStage;
  /** Its strictness (`ShowArgs` writes an example of a tool not offered as the tool would be sent). */
  readonly strict?: boolean | number;
  /** Its args for this session, as their lenient JSON Schema (the code shape). */
  argsJson(session: AuthoringSession<S, D>): JsonSchema;
  /** Whether it is offered this round. */
  offered(session: AuthoringSession<S, D>): boolean;
  make(ai: HarnessAi, session: AuthoringSession<S, D>, show?: ShowArgs): AeyeTool;
}

/** An aeye tool as `ai.tool()` makes it. */
export type AeyeTool = ToolCompatible<AIContextRequired<HarnessAiTypes>, AIMetadataRequired<HarnessAiTypes>>;

/** The aeye types of `ctx.ai()`. */
type HarnessAiTypes = HarnessAi extends AI<infer T> ? T : never;

/**
 * An authoring tool's (or draft's) args: an `a` schema or a bundle with nothing left to bind, or the bound schema of
 * this session (`(session) => Bundle.bind(…)`: a typed schema over what the session has loaded). The function is
 * called each round (aeye's `dynamic` prompt re-resolves the tools), so it sees the session as it is now; a bundle's
 * key keeps the bind (and its rendering) until what it reads changes.
 */
export type AuthoringSchema<S, D, I> = Bindable<I> | ((session: AuthoringSession<S, D>) => Bound<I>);

/** A schema as aeye's tools take it: the static one, or a bindable whose bind reads the session. */
function sessionSchema<S, D, I>(schema: AuthoringSchema<S, D, I>, session: AuthoringSession<S, D>): Bindable<I> {
  if (typeof schema !== 'function') return schema;
  // the phantom fields only carry the type; aeye calls `bind` (with the call's ctx, which this one has no use for)
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `_out` / `_refs` are type-only
  return { bind: () => schema(session) } as unknown as Bindable<I>;
}

/** The bound `{ draft: <draft> }` of a draft's bound schema, kept per bound (so its rendering is kept with it). */
const draftArgs = new WeakMap<object, unknown>();
function wrapDraft<D>(draft: Bound<D>): Bound<{ draft: D }> {
  const kept = draftArgs.get(draft);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- kept for this very bound, below
  if (kept !== undefined) return kept as Bound<{ draft: D }>;
  const made = new Bound<{ draft: D }>(draft.env, a.object({ draft: draft.root }));
  draftArgs.set(draft, made);
  return made;
}

/** Declare an authoring tool. */
export function authoringTool<S, D, I extends object>(def: AuthoringToolInput<S, D, I>): AuthoringTool<S, D> {
  const offered = (session: AuthoringSession<S, D>): boolean => session.open(def.stage) && (def.when?.(session) ?? true);
  const instructions = def.instructions;
  return {
    name: def.name,
    stage: def.stage,
    ...(def.strict === undefined ? {} : { strict: def.strict }),
    argsJson: (session) => (typeof def.schema === 'function' ? def.schema(session) : def.schema.bind()).render(LENIENT).jsonSchema,
    offered,
    make: (ai, session, show = (tool, args, path) => deferEncode({ tool, value: args, ...(path === undefined ? {} : { path }) })) => ai.tool({
      name: def.name,
      description: def.description,
      ...(instructions === undefined ? {} : typeof instructions === 'string' ? { instructions } : { instructionsFn: () => instructions(show) }),
      ...(def.strict === undefined ? {} : { strict: def.strict }),
      ...(def.errorFormat === undefined ? {} : { errorFormat: def.errorFormat }),
      // aeye decodes the args (a container sent as JSON text is repaired) and answers args that don't fit with the
      // model's own JSON, marked where it is wrong, then lets it call again
      schema: sessionSchema(def.schema, session),
      applicable: () => offered(session),
      call: async (input: I) => {
        const text = await def.call(input, session);
        session.done(def.stage, def.name);
        return text;
      },
    }),
  };
}

/** What `authoringAgent` takes. */
export interface AuthoringAgentInput<S, D> {
  readonly name: string;
  readonly description: string;
  /**
   * The agent's job, step by step, with worked examples. Write it for the model. The current stage, the request and
   * the stage guide are added after it each round. Its example calls go through `ShowArgs` (a function of it), so each
   * is written as the model the hub sends the request to writes that tool's args.
   */
  readonly instructions: AuthoringText;
  /** Find and inspect tools (search, load, examples, …). */
  readonly tools: ReadonlyArray<AuthoringTool<S, D>>;
  /**
   * The draft: the typed authoring schema, bound per session (`QueryGrammar` over the loaded tables for queries,
   * `HarnessGrammar` over the session's registry for programs). The draft tool's args are `{ draft: <it> }`.
   */
  readonly draft: { readonly description: string; readonly schema: AuthoringSchema<S, D, D> };
  /** Check a draft: every problem, one per line, in words the model can act on; a preview when it is clean. */
  check(draft: D, session: AuthoringSession<S, D>): Promise<DraftCheck>;
  /** Save a clean draft as a fn. */
  save(draft: D, session: AuthoringSession<S, D>): Promise<AuthoredFn>;
  /** Answer with an existing fn instead (found in `find`); a string is why it can't be reused. */
  reuse?(fn: string, session: AuthoringSession<S, D>): Promise<AuthoredFn | string>;
  /** The model, the aeye way (`role/chat`, `openrouter/…`); the hub picks when absent. */
  readonly model?: string;
  /** Failed checks it may fix; `HARNESS_AUTHORING_FIXES` when absent. */
  readonly fixes?: number;
  /** Model rounds; `HARNESS_AUTHORING_ROUNDS` when absent. */
  readonly rounds?: number;
  /** The most tokens one model step may write; `HARNESS_AUTHORING_MAX_TOKENS` when absent. */
  readonly maxTokens?: number;
  /** `find: false`: the agent is handed what it builds on, so it starts in `inspect` (no find tools, no `reuse`). */
  readonly stages?: { readonly find?: boolean };
  /** Names for the built-in tools when the job wants its own words (default `draft` and `save`). */
  readonly toolNames?: { readonly draft?: string; readonly save?: string };
  /**
   * What the save tool answers the agent once `save` returns, when the job's save keeps nothing itself (a widget is only
   * offered to the person; iteration 3: "Saved widgets/… (version 1)" read as kept, beside a result saying it was not).
   * Default: `Saved <fn> (version <n>). Now answer in one line.`
   */
  readonly savedLine?: (result: AuthoredFn) => string;
}

/** Why an authoring run stopped without a fn. */
export class AuthoringError extends Error {
  readonly stage: AuthoringStage;
  readonly problems: readonly string[];

  constructor(message: string, stage: AuthoringStage, problems: readonly string[]) {
    super(message);
    this.stage = stage;
    this.problems = problems;
    this.name = 'AuthoringError';
  }
}

/** What each stage is for, shown to the model with the stage it is in, in the words of the agent's tool names. */
function stageGuide(names: { readonly draft: string; readonly save: string }): Readonly<Record<AuthoringStage, string>> {
  return {
    find: 'Find what exists first: search for an existing fn or the pieces you need. If an existing fn already does it, reuse it.',
    inspect: 'Inspect what you will build on: load the details (types, fields, examples, a sample) you need. Load only what you need.',
    draft: `Write the draft with ${names.draft}. Its args are checked against the real schema.`,
    check: 'The draft is being checked.',
    fix: `The last draft has problems. Fix exactly those problems and call ${names.draft} again with the whole corrected draft.`,
    save: `The draft checked clean. Call ${names.save} to keep it.`,
  };
}

/** A declared authoring agent: run it inside a fn with the run's `ctx.ai()`. */
export interface AuthoringAgent<S, D> {
  readonly name: string;
  run(ai: HarnessAi, request: string, state: S): Promise<{ result: AuthoredFn; session: AuthoringSession<S, D> }>;
}

/** Declare an authoring agent: a forced find → inspect → draft → check → fix → save workflow on aeye. */
export function authoringAgent<S, D>(def: AuthoringAgentInput<S, D>): AuthoringAgent<S, D> {
  const fixCap = def.fixes ?? authoringEnv.get('HARNESS_AUTHORING_FIXES');
  const rounds = def.rounds ?? authoringEnv.get('HARNESS_AUTHORING_ROUNDS');
  const maxTokens = def.maxTokens ?? authoringEnv.get('HARNESS_AUTHORING_MAX_TOKENS');
  const names = { draft: def.toolNames?.draft ?? 'draft', save: def.toolNames?.save ?? 'save' };
  const guide = stageGuide(names);
  const skip: SkippableStage[] = def.stages?.find === false ? ['find'] : [];
  const misplaced = skip.length === 0 ? [] : def.tools.filter((tool) => tool.stage === 'find').map((tool) => tool.name);
  if (misplaced.length > 0) { throw new Error(`${def.name} skips find, so it can't have find tools (${misplaced.join(', ')}).`); }
  return {
    name: def.name,
    async run(ai, request, state) {
      const session = new AuthoringSession<S, D>(request, state, skip);
      const draftTool = authoringTool<S, D, { draft: D }>({
        name: names.draft,
        stage: 'draft',
        // A draft is a whole program or query: a recursive grammar with optional fields at every level. Strict decoding
        // makes the model write each absent optional as null at every level and steers it into wrong branches, so a
        // draft took minutes (or never finished) and came back malformed, where non-strict took seconds and was right
        // (measured on GPT-6 Luna). The schema still guides the model, and the check names every problem by path.
        strict: false,
        description: `Write (or rewrite) the whole draft: ${def.draft.description} It is checked at once; the answer lists every problem, or says it is clean.`,
        schema: (s) => wrapDraft(typeof def.draft.schema === 'function' ? def.draft.schema(s) : def.draft.schema.bind()),
        call: async ({ draft }, s) => {
          const check = await def.check(draft, s);
          s.checked(draft, check);
          if (check.problems.length === 0) {
            return [`Clean.${check.note === undefined ? '' : `\n${check.note}`}`, check.preview === undefined ? '' : `Preview:\n${JSON.stringify(check.preview, null, 2)}`, `Call ${names.save} to keep it.`].filter((line) => line !== '').join('\n');
          }
          if (s.fixes >= fixCap) {
            s.stop(check);
            return 'Too many fixes: stop now and answer that it could not be written.';
          }
          return [`Problems (${check.problems.length}); fix them and call ${names.draft} again with the whole draft:`, ...check.problems.map((p) => `- ${p}`), check.note ?? ''].filter((line) => line !== '').join('\n');
        },
      });
      const SAVE_ARGS = a.object({});
      const REUSE_ARGS = a.object({ fn: a.string().min(1) });
      const reuseDef = skip.length === 0 ? def.reuse?.bind(def) : undefined;
      // every tool of the agent by name, so an example of one (`ShowArgs`) is written as that tool is (or would be) sent
      const known = new Map<string, Pick<AuthoringTool<S, D>, 'argsJson' | 'offered' | 'strict'>>([
        [names.draft, draftTool],
        [names.save, { argsJson: () => SAVE_ARGS.render(LENIENT).jsonSchema, offered: (s) => s.going && s.stage === 'save' }],
        ...def.tools.map((tool): [string, AuthoringTool<S, D>] => [tool.name, tool]),
        ...(reuseDef === undefined ? [] : [['reuse', { argsJson: () => REUSE_ARGS.render(LENIENT).jsonSchema, offered: (s: AuthoringSession<S, D>) => s.going && s.disclosure.searched('fn') }] as const]),
      ]);
      const show: ShowArgs = (tool, args, path) => {
        const it = known.get(tool);
        const at = path === undefined ? {} : { path };
        // a tool offered now is in the request; one that isn't goes with its schema, unless it is never strict (its
        // dialect then writes the code shape) or its schema can't be made yet (a draft over what isn't loaded)
        if (it === undefined || it.offered(session) || it.strict === false) return deferEncode({ tool, value: args, ...at });
        let schema: JsonSchema;
        try {
          schema = it.argsJson(session);
        } catch {
          return deferEncode({ tool, value: args, ...at });
        }
        return deferEncode({ tool, value: args, ...at, schema, strict: it.strict ?? 1 });
      };
      const save = ai.tool({
        name: names.save,
        description: 'Save the draft that checked clean as a fn. Answer after this with one line saying what you saved.',
        schema: SAVE_ARGS,
        applicable: () => session.going && session.stage === 'save',
        call: async () => {
          const draft = session.draft;
          if (draft === undefined) throw new Error('There is no draft to save.');
          const result = await def.save(draft, session);
          session.finish(result);
          session.done('save', names.save);
          return def.savedLine?.(result) ?? `Saved ${result.fn} (version ${result.version}). Now answer in one line.`;
        },
      });
      const tools: [AeyeTool, ...AeyeTool[]] = [
        draftTool.make(ai, session, show),
        save,
        ...def.tools.map((tool) => tool.make(ai, session, show)),
        ...(reuseDef === undefined ? [] : [ai.tool({
          name: 'reuse',
          description: 'Answer with an existing fn that already does what was asked, instead of writing a new one.',
          schema: REUSE_ARGS,
          applicable: () => session.going && session.disclosure.searched('fn'),
          call: async (input: { fn: string }) => {
            const answer = await reuseDef(input.fn, session);
            if (typeof answer === 'string') return answer;
            session.finish(answer);
            session.done('find', 'reuse');
            return `Reusing ${answer.fn}. Now answer in one line.`;
          },
        })]),
      ];
      const prompt = ai.prompt({
        name: def.name,
        description: def.description,
        // the instructions are a variable, never a template: their example calls are deferred values (`ShowArgs`)
        content: '{{{instructions}}}\n\n<request>\n{{request}}\n</request>\n\nYou are in the {{stage}} stage. {{guide}}',
        input: () => ({ instructions: textOf(def.instructions, show), request: session.request, stage: session.stage, guide: guide[session.stage] }),
        tools,
        dynamic: true,
        // until something is saved (or reused) every round must call a tool: a model that answers in words mid-way (a
        // clean draft and no `save`) otherwise ends the run with nothing kept
        // and no step writes past the cap: a stuck model ends there, its call failing back to it (the hub's stream guard)
        config: () => (session.going ? { maxTokens, toolChoice: 'required' } : { maxTokens }),
        toolIterations: rounds,
        toolExecution: 'sequential',
        // no model named: the hub picks (its stand-in has every capability), never aeye among the hub's whole list,
        // whose free entries may not all say they take tools
        metadata: { model: def.model ?? HUB_MODEL },
        validate: () => {
          if (session.going) {
            throw new Error(`Nothing is saved yet: you are in the ${session.stage} stage. ${guide[session.stage]}`);
          }
        },
      });
      await prompt.get('result', {});
      const result = session.result;
      const stopped = session.stopped;
      if (stopped !== undefined) {
        throw new AuthoringError(`${def.name} gave up: the draft still had problems after ${session.fixes} fixes.`, 'fix', stopped.problems);
      }
      if (result === undefined) {
        throw new AuthoringError(`${def.name} stopped in the ${session.stage} stage without saving.`, session.stage, session.lastCheck?.problems ?? []);
      }
      return { result, session };
    },
  };
}
