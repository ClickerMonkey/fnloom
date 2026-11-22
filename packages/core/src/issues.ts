/**
 * Short validation problems for the model (iteration 2): a zod error over a nested shape (a gin type in a table's row
 * type, a gin program in an authoring draft) used to reach the model whole, a union's every failed branch nested in
 * the next, megabytes for one wrong key, or a misleading one-liner at the wrong level. `conciseIssues` turns it into
 * the first few problems, each at its full dotted path with what was expected there:
 *
 * - **Unions:** the branch the value got furthest into is followed (the one whose problems lie deepest, not just at
 *   the branch's own `kind` or `name`); when no branch got past its tag, the problem says which tags fit
 *   (`program.vars.0.value: no form fits; "kind" must be one of: get, if, new, …`).
 * - **Gin types:** a value at the failing path that looks like a gin type (`{ name, … }`) is parsed by gin itself
 *   (`ginTypeProblem`), whose message names the real fault (`prop 'id' has unknown key 'name' — valid keys: docs,
 *   type, …`), with the shape of an object type.
 * - **Bounds:** at most `max` problems (and how many more), each at most `chars` long.
 */
import type { z } from 'zod';
import { ginTypeProblem, isGinTypeDef } from './gin.ts';

/** One problem at a dotted path (`type.props.id`; empty for the whole value). */
export interface ConciseIssue {
  readonly path: string;
  readonly message: string;
}

/** How many problems and how long each, by default. */
export const CONCISE_LIMITS = { max: 5, chars: 300 } as const;

/** The shape of a gin object type, for problems with one. */
export const OBJ_TYPE_SHAPE = 'An object type is {"name":"obj","props":{"store":{"type":{"name":"text"}},"total":{"type":{"name":"num"}}}}: each prop wraps its type in "type".';

type Issue = z.core.$ZodIssue;
type Path = readonly PropertyKey[];

/** The issue's union branches, when it is a union that failed with them. */
function branchesOf(issue: Issue): ReadonlyArray<readonly Issue[]> | undefined {
  return issue.code === 'invalid_union' && Array.isArray(issue.errors) && issue.errors.length > 0 ? issue.errors : undefined;
}

/** How deep a branch's problems go (the deepest, through nested unions): how far the value got into it. */
function depthOf(issues: readonly Issue[]): number {
  let deepest = 0;
  for (const issue of issues) {
    const nested = branchesOf(issue);
    const inner = nested === undefined ? 0 : Math.max(...nested.map(depthOf));
    deepest = Math.max(deepest, issue.path.length + inner);
  }
  return deepest;
}

/** Whether a branch failed on its own tag (a literal at its top: `kind`, `name`): it was the wrong form. */
function tagOnly(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.code === 'invalid_value' && issue.path.length === 1);
}

/** The tag values a union's branches wanted (`kind` must be one of these), with the tag's key. */
function tagsOf(branches: ReadonlyArray<readonly Issue[]>): { key: string; values: string[] } | undefined {
  const values = new Set<string>();
  let key: string | undefined;
  for (const branch of branches) {
    for (const issue of branch) {
      if (issue.code === 'invalid_value' && issue.path.length === 1) {
        key ??= String(issue.path[0]);
        for (const value of issue.values) values.add(String(value));
      }
    }
  }
  return key === undefined || values.size === 0 ? undefined : { key, values: [...values] };
}

/** The value at a path in the checked input, when it can be followed. */
function valueAt(value: unknown, path: Path): unknown {
  let at = value;
  for (const key of path) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = Reflect.get(at, key);
  }
  return at;
}

const dotted = (path: Path): string => path.map(String).join('.');

/** The problems of one issue at `prefix`, unions followed into the branch the value got furthest into. */
function flatten(issue: Issue, prefix: Path, value: unknown, out: ConciseIssue[]): void {
  const path = [...prefix, ...issue.path];
  const branches = branchesOf(issue);
  if (branches !== undefined) {
    const real = branches.filter((branch) => !tagOnly(branch));
    if (real.length === 0) {
      const tags = tagsOf(branches);
      out.push({ path: dotted(path), message: tags === undefined ? 'no form fits here' : `no form fits; "${tags.key}" must be one of: ${tags.values.join(', ')}` });
      return;
    }
    // the branch the value got furthest into, the fewest problems among equals
    const best = [...real].sort((a, b) => depthOf(b) - depthOf(a) || a.length - b.length)[0] ?? [];
    for (const inner of best) flatten(inner, path, value, out);
    return;
  }
  out.push({ path: dotted(path), message: messageOf(issue, valueAt(value, path)) });
}

/** One issue's words: gin's own for a gin type that doesn't parse, else zod's, with what was expected. */
function messageOf(issue: Issue, at: unknown): string {
  if ((issue.code === 'unrecognized_keys' || issue.code === 'custom' || issue.code === 'invalid_union') && isGinTypeDef(at)) {
    const gin = ginTypeProblem(at);
    if (gin !== undefined) return `${gin}. ${OBJ_TYPE_SHAPE}`;
  }
  if (issue.code === 'invalid_union' && issue.message === 'Invalid input') {
    return 'no form fits here';
  }
  return issue.message;
}

/** Cut a text to `chars`, saying so. */
export function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, Math.max(0, chars - 1))}…`;
}

/**
 * The first `max` problems of a zod error, each at its full path with what was expected, unions followed into the
 * branch the value got furthest into; `value` is what was checked (so a gin type at a failing path is parsed by gin).
 * The last entry says how many more there were, when there were.
 */
export function conciseIssues(error: z.ZodError, value?: unknown, limits: { max?: number; chars?: number } = {}): ConciseIssue[] {
  const max = limits.max ?? CONCISE_LIMITS.max;
  const chars = limits.chars ?? CONCISE_LIMITS.chars;
  const all: ConciseIssue[] = [];
  for (const issue of error.issues) flatten(issue, [], value, all);
  const seen = new Set<string>();
  const unique = all.filter((issue) => { const key = `${issue.path}\u0000${issue.message}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const shown = unique.slice(0, max).map((issue) => ({ path: issue.path, message: clip(issue.message, chars) }));
  const more = unique.length - shown.length;
  return more > 0 ? [...shown, { path: '', message: `and ${more} more problem${more === 1 ? '' : 's'} like these` }] : shown;
}

/** The problems as lines for the model: `- type.props.id: …`. */
export function issueLines(issues: readonly ConciseIssue[]): string {
  return issues.map((issue) => `- ${issue.path === '' ? '' : `${issue.path}: `}${issue.message}`).join('\n');
}
