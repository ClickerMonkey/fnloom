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
 *
 * The loop is aeye's own (`ai.prompt` with tools); this helper adds no second loop.
 */
import type { AI, AIContextRequired, AIMetadataRequired } from '@aeye/ai';
import type { ToolCompatible } from '@aeye/core';
import { env } from '@ayepi/env';
import { z } from 'zod';
import { g, type Infer } from './gin.ts';
import type { HarnessAi } from './server/llm.ts';

/** The authoring agents' tunables. */
export const authoringEnv = env({
  /** How many failed checks an authoring agent may fix before it gives up. */
  HARNESS_AUTHORING_FIXES: z.coerce.number().int().min(0).default(3),
  /** The most model rounds one authoring run takes. */
  HARNESS_AUTHORING_ROUNDS: z.coerce.number().int().min(2).default(24),
});

/** The fixed workflow, in order. `fix` is entered when a check fails and left when a draft checks clean. */
export const AUTHORING_STAGES = ['find', 'inspect', 'draft', 'check', 'fix', 'save'] as const;
export type AuthoringStage = (typeof AUTHORING_STAGES)[number];

/** The stages a tool belongs to (`check` and `fix` are the built-in `draft` tool's; `save` the built-in `save`). */
export type ToolStage = 'find' | 'inspect' | 'draft';

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
  preview: g.optional(g.any()),
  /** How to call it again, as the chat model would write the call. */
  call: g.text(),
});
export type AuthoredFn = Infer<typeof authoredFn>;

/** What a check of a draft found: the problems (one per line; empty when it is clean) and a preview when clean. */
export interface DraftCheck {
  readonly problems: readonly string[];
  readonly preview?: unknown;
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

  constructor(request: string, state: S) {
    this.request = request;
    this.state = state;
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

/** One tool of an authoring agent, typed by its args; `authoringTool` erases the args for the agent's list. */
export interface AuthoringToolInput<S, D, I extends object> {
  readonly name: string;
  /** What it does, for the model. */
  readonly description: string;
  /** How and when to use it, for the model (added to the prompt's tools section). */
  readonly instructions?: string;
  readonly stage: ToolStage;
  /** Its args: a zod schema, or one built from the session (a typed schema per instance). */
  readonly schema: z.ZodType<I> | ((session: AuthoringSession<S, D>) => z.ZodType<I>);
  /** Offered only while this also holds (a load tool while something is aware but not loaded). */
  readonly when?: (session: AuthoringSession<S, D>) => boolean;
  /** Do it; the text is what the model reads. A thrown error is shown to the model as the tool's failure. */
  call(input: I, session: AuthoringSession<S, D>): Promise<string> | string;
}

/** An authoring tool with its args type erased: it makes its aeye tool for a session. */
export interface AuthoringTool<S, D> {
  readonly name: string;
  readonly stage: ToolStage;
  make(ai: HarnessAi, session: AuthoringSession<S, D>): AeyeTool;
}

/** An aeye tool as `ai.tool()` makes it. */
export type AeyeTool = ToolCompatible<AIContextRequired<HarnessAiTypes>, AIMetadataRequired<HarnessAiTypes>>;

/** The aeye types of `ctx.ai()`. */
type HarnessAiTypes = HarnessAi extends AI<infer T> ? T : never;

/** Declare an authoring tool. */
export function authoringTool<S, D, I extends object>(def: AuthoringToolInput<S, D, I>): AuthoringTool<S, D> {
  return {
    name: def.name,
    stage: def.stage,
    make: (ai, session) => ai.tool({
      name: def.name,
      description: def.description,
      ...(def.instructions === undefined ? {} : { instructions: def.instructions }),
      schema: () => (typeof def.schema === 'function' ? def.schema(session) : def.schema),
      applicable: () => session.open(def.stage) && (def.when?.(session) ?? true),
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
   * the stage guide are added after it each round.
   */
  readonly instructions: string;
  /** Find and inspect tools (search, load, examples, …). */
  readonly tools: ReadonlyArray<AuthoringTool<S, D>>;
  /** The draft's args: the typed authoring schema (`buildQueryTool`'s for queries, gin's `buildSchemas` for types). */
  readonly draft: { readonly description: string; readonly schema: z.ZodType<D> | ((session: AuthoringSession<S, D>) => z.ZodType<D>) };
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

/** What each stage is for, shown to the model with the stage it is in. */
const STAGE_GUIDE: Readonly<Record<AuthoringStage, string>> = {
  find: 'Find what exists first: search for an existing fn or the pieces you need. If an existing fn already does it, reuse it.',
  inspect: 'Inspect what you will build on: load the details (types, fields, examples) of what the search found. Load only what you need.',
  draft: 'Write the draft with the draft tool. Its args are checked against the real schema.',
  check: 'The draft is being checked.',
  fix: 'The last draft has problems. Fix exactly those problems and call draft again with the whole corrected draft.',
  save: 'The draft checked clean. Call save to keep it.',
};

/** A declared authoring agent: run it inside a fn with the run's `ctx.ai()`. */
export interface AuthoringAgent<S, D> {
  readonly name: string;
  run(ai: HarnessAi, request: string, state: S): Promise<{ result: AuthoredFn; session: AuthoringSession<S, D> }>;
}

/** Declare an authoring agent: a forced find → inspect → draft → check → fix → save workflow on aeye. */
export function authoringAgent<S, D>(def: AuthoringAgentInput<S, D>): AuthoringAgent<S, D> {
  const fixCap = def.fixes ?? authoringEnv.get('HARNESS_AUTHORING_FIXES');
  const rounds = def.rounds ?? authoringEnv.get('HARNESS_AUTHORING_ROUNDS');
  return {
    name: def.name,
    async run(ai, request, state) {
      const session = new AuthoringSession<S, D>(request, state);
      const draftTool = authoringTool<S, D, { draft: D }>({
        name: 'draft',
        stage: 'draft',
        description: `Write (or rewrite) the whole draft: ${def.draft.description} It is checked at once; the answer lists every problem, or says it is clean.`,
        schema: (s) => z.object({ draft: typeof def.draft.schema === 'function' ? def.draft.schema(s) : def.draft.schema }),
        call: async ({ draft }, s) => {
          const check = await def.check(draft, s);
          s.checked(draft, check);
          if (check.problems.length === 0) {
            return [`Clean.${check.note === undefined ? '' : `\n${check.note}`}`, check.preview === undefined ? '' : `Preview:\n${JSON.stringify(check.preview, null, 2)}`, 'Call save to keep it.'].filter((line) => line !== '').join('\n');
          }
          if (s.fixes >= fixCap) {
            s.stop(check);
            return 'Too many fixes: stop now and answer that it could not be written.';
          }
          return [`Problems (${check.problems.length}); fix them and call draft again with the whole draft:`, ...check.problems.map((p) => `- ${p}`), check.note ?? ''].filter((line) => line !== '').join('\n');
        },
      });
      const save = ai.tool({
        name: 'save',
        description: 'Save the draft that checked clean as a fn. Answer after this with one line saying what you saved.',
        schema: z.object({}),
        applicable: () => session.going && session.stage === 'save',
        call: async () => {
          const draft = session.draft;
          if (draft === undefined) throw new Error('There is no draft to save.');
          const result = await def.save(draft, session);
          session.finish(result);
          session.done('save', 'save');
          return `Saved ${result.fn} (version ${result.version}). Now answer in one line.`;
        },
      });
      const reuseDef = def.reuse?.bind(def);
      const tools: [AeyeTool, ...AeyeTool[]] = [
        draftTool.make(ai, session),
        save,
        ...def.tools.map((tool) => tool.make(ai, session)),
        ...(reuseDef === undefined ? [] : [ai.tool({
          name: 'reuse',
          description: 'Answer with an existing fn that already does what was asked, instead of writing a new one.',
          schema: z.object({ fn: z.string().min(1) }),
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
        content: `${def.instructions}\n\n<request>\n{{request}}\n</request>\n\nYou are in the {{stage}} stage. {{guide}}`,
        input: () => ({ request: session.request, stage: session.stage, guide: STAGE_GUIDE[session.stage] }),
        tools,
        dynamic: true,
        toolIterations: rounds,
        toolExecution: 'sequential',
        ...(def.model === undefined ? {} : { metadata: { model: def.model } }),
        validate: () => {
          if (session.going) {
            throw new Error(`Nothing is saved yet: you are in the ${session.stage} stage. ${STAGE_GUIDE[session.stage]}`);
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
