/**
 * The one store migration of the injected-context change (plan `injected-context-2026-11-22`, "Stored data": a clean
 * rename, no aliases). It runs at every start before the catalog imports anything, and is idempotent: a store already
 * migrated is left as it is.
 *
 * What it does, in order:
 *
 * 1. **Tool-call names in stored transcripts** (slice A): every session's transcript is rewritten so each tool call is
 *    named the one way (`modelFnName`): an old call's name is read back by the old rule (`fs__Entry--reveal`, `/` as
 *    `__` and `.` as `--`), renamed (`renames`), and written by the new rule (`fs__Entry__reveal`); the static `run`
 *    tool's `fn` argument the same. Static tools' own names (`find`, `load`, …) are left alone.
 * 2. **Renamed fns** (slice B, `FN_RENAMES`): the qualified names in each session's tools, context and suggestions go
 *    through `renames`; B adds the other tables' renames (policies, grants, item switches, search decisions, hub MCP
 *    rules, examples, runs) as steps of their own in `FN_NAME_MIGRATION_STEPS`.
 * 3. **Further steps** (`FN_NAME_MIGRATION_STEPS`): slice C's `alwaysFor` on hub-made context turned into an
 *    approved `inject` with the same agents as exact names, and dropped on a system's (`always-for.ts`).
 *
 * Model call records (`llmInteractions`, the raw requests) are history and stay as they were: the web reads their old
 * spelling through core's display-only `fnOfStoredToolName`.
 *
 * Extension points: `FN_RENAMES` (old qualified name → new) and `FN_NAME_MIGRATION_STEPS` (named steps given the store,
 * the log and `renamed`). Add to them; don't add another migration.
 */
import type { Logger } from '@ayepi/log';
import { fnOfStoredToolName, modelFnName, QualifiedName, QUALIFIED_FN_RENAMES, type LlmMessage, type LlmToolCall, type Session } from '@harness/core';
import { ALWAYS_FOR_STEP } from './always-for.ts';
import { FN_RENAME_STEPS } from './fn-renames.ts';
import type { HubStore } from './index.ts';
import { rows } from './rows.ts';

/** What a migration step is given. */
export interface FnNameMigrationContext {
  readonly store: HubStore;
  readonly log: Logger;
  /** A qualified name through the renames (itself when it wasn't renamed). */
  readonly renamed: <N extends string>(name: N) => N | QualifiedName;
}

/** One step of the migration: named for its log line, idempotent, returns how many rows it changed. */
export interface FnNameMigrationStep {
  readonly name: string;
  run(ctx: FnNameMigrationContext): Promise<number>;
}

/**
 * Slice B's renames, old qualified name → new (`hub/load_fns` → `hub/fns_load`, …): applied to every name this
 * migration rewrites. Extension point: B fills it in.
 */
export const FN_RENAMES: ReadonlyMap<QualifiedName, QualifiedName> = new Map<QualifiedName, QualifiedName>(
  [...QUALIFIED_FN_RENAMES].map(([from, to]) => [QualifiedName.parse(from), QualifiedName.parse(to)]),
);

/** Steps after the transcripts and sessions, in order. Extension point: B's other tables, C's `alwaysFor` → `inject`. */
export const FN_NAME_MIGRATION_STEPS: readonly FnNameMigrationStep[] = [...FN_RENAME_STEPS, ALWAYS_FOR_STEP];

/** What the migration may be given instead of the module's own lists (tests). */
export interface FnNameMigrationOptions {
  readonly renames?: ReadonlyMap<string, QualifiedName>;
  readonly steps?: readonly FnNameMigrationStep[];
}

/** The static toolset's own tool names, which name no fn and are left as they are. */
const RUN_TOOL = 'run';

/**
 * The fn a stored tool call's name means: a qualified name; the new rule; or the old one (`--` for a method's `.`,
 * which a new name never holds). Undefined for a static tool's name, or a name cut short by the old rule.
 */
export function storedCallFn(name: string): QualifiedName | undefined {
  return fnOfStoredToolName(name);
}

/** A tool call named the one way, its `run` target too; the same call when nothing changes. */
export function migratedCall(call: LlmToolCall, renamed: (name: QualifiedName) => QualifiedName): LlmToolCall {
  if (call.name === RUN_TOOL) {
    try {
      const args: unknown = JSON.parse(call.arguments);
      if (typeof args !== 'object' || args === null || !('fn' in args) || typeof args.fn !== 'string') return call;
      const fn = storedCallFn(args.fn);
      if (fn === undefined) return call;
      const name = modelFnName(renamed(fn));
      return name === args.fn ? call : { ...call, arguments: JSON.stringify({ ...args, fn: name }) };
    } catch {
      return call;
    }
  }
  const fn = storedCallFn(call.name);
  if (fn === undefined) return call;
  const name = modelFnName(renamed(fn));
  return name === call.name ? call : { ...call, name };
}

/** A transcript with every tool call named the one way; the same array when nothing changes. */
export function migratedTranscript(transcript: readonly LlmMessage[], renamed: (name: QualifiedName) => QualifiedName): readonly LlmMessage[] {
  const out = transcript.map((message) => {
    if (message.toolCalls === undefined) return message;
    const calls = message.toolCalls.map((call) => migratedCall(call, renamed));
    return calls.every((call, i) => call === message.toolCalls?.[i]) ? message : { ...message, toolCalls: calls };
  });
  return out.some((message, i) => message !== transcript[i]) ? out : transcript;
}

/** A list of qualified names through the renames; the same list when none was renamed. */
function renamedList<N extends string>(names: readonly N[], renamed: (name: N) => N | QualifiedName): Array<N | QualifiedName> | undefined {
  const out = names.map(renamed);
  return out.some((name, i) => name !== names[i]) ? out : undefined;
}

/** Run the migration. Returns how many rows each part changed. */
export async function migrateFnNames(store: HubStore, log: Logger, options: FnNameMigrationOptions = {}): Promise<Record<string, number>> {
  const renames = options.renames ?? FN_RENAMES;
  const renamed = <N extends string>(name: N): N | QualifiedName => renames.get(name) ?? name;
  const renamedFn = (name: QualifiedName): QualifiedName => renames.get(name) ?? name;
  const report: Record<string, number> = { sessions: 0 };
  for await (const session of rows(store.table('sessions'))) {
    const transcript = migratedTranscript(session.transcript, renamedFn);
    const tools = renamedList(session.tools, renamed);
    const context = renamedList(session.context, renamed);
    const suggested = session.suggested === undefined ? undefined : renamedList(session.suggested, renamed);
    const patch: Partial<Session> = {
      ...(transcript === session.transcript ? {} : { transcript: [...transcript] }),
      ...(tools === undefined ? {} : { tools: tools.map((name) => QualifiedName.parse(name)) }),
      ...(context === undefined ? {} : { context: context.map((name) => QualifiedName.parse(name)) }),
      ...(suggested === undefined ? {} : { suggested: suggested.map((name) => QualifiedName.parse(name)) }),
    };
    // a session's key never changes, so writing it doesn't disturb the paged read
    if (Object.keys(patch).length === 0) continue;
    await store.table('sessions').update(session.id, patch);
    report['sessions'] = (report['sessions'] ?? 0) + 1;
  }
  for (const step of options.steps ?? FN_NAME_MIGRATION_STEPS) report[step.name] = await step.run({ store, log, renamed });
  const total = Object.values(report).reduce((sum, n) => sum + n, 0);
  if (total > 0) log.info('store.fn-names.migrated', report);
  return report;
}
