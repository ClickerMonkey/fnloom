/**
 * A system's context folder under test: `contextFolder(dir, contract)` reads it with the SDK's reader, follows every
 * link against the contract's own fns and context (plus the names it says it uses from other systems or the hub), and
 * gives back the context each file becomes, the fns each one brings, and every problem as a `file:line:col` line.
 */
import { qualify, type ContextDecl, type QualifiedName } from '@harness/core';
import { checkContextFolder } from '../server/context-check.ts';
import { formatContextProblem } from '../server/context-files.ts';
import type { AnyContract } from '../system.ts';

/** Names a folder may link to beyond its own system: other systems' or the hub's fns and context, qualified. */
export interface OtherNames {
  readonly fns?: readonly QualifiedName[];
  readonly context?: readonly QualifiedName[];
}

/** A checked context folder. */
export interface TestedContext {
  /** What each file becomes in the manifest, by qualified key. */
  readonly context: ReadonlyMap<QualifiedName, ContextDecl>;
  /** The fns each context brings when it is loaded, by qualified key. */
  readonly fns: ReadonlyMap<QualifiedName, readonly QualifiedName[]>;
  /** Every problem, as `file:line:col message`; empty when the folder is sound. */
  readonly problems: readonly string[];
}

/** Check a system's context folder (`<system>/context`): every file parses, every link resolves, no imports cycle. */
export async function contextFolder(dir: string, contract: AnyContract, other: OtherNames = {}): Promise<TestedContext> {
  const system = contract.name;
  const checked = await checkContextFolder(dir, {
    system,
    fns: new Set([...Object.keys(contract.defs.fns).map((name) => qualify(system, name)), ...(other.fns ?? [])]),
    context: new Set([...Object.keys(contract.defs.context).map((name) => qualify(system, name)), ...(other.context ?? [])]),
  });
  return {
    context: new Map(checked.files.map((file) => [qualify(system, file.header.key), file.decl])),
    fns: new Map(checked.files.map((file) => [qualify(system, file.header.key), file.header.fns])),
    problems: checked.problems.map(formatContextProblem),
  };
}
