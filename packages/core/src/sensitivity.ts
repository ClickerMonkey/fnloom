/**
 * Sensitive files (build 8). A system that touches files (fs) keeps one list of rules saying which files are sensitive:
 * gitignored files, env files, keys, credentials, tokens, and files whose content looks like a secret. Before a run of
 * a fn that declares `FnDecl.flags`, the hub asks the fn's system (`flags` on the system link) which sensitive files
 * the call would read or write. Then:
 *
 * - a flag whose action is `refuse` stops the run as invalid input, with the rule's words;
 * - any write flag, or a read flag whose action is `ask`, makes the run wait for the person (never remembered, never
 *   let through by a policy or by `auto` mode);
 * - in `auto` chat mode the classifier model sees the flags with the call;
 * - the approval card lists them (`PreviewPart` `flags`).
 *
 * The same rules decide which files a system never serves as resources, so there is one list per instance.
 */
import { z } from 'zod';

/** What makes a file sensitive. */
/**
 * `runs-code`: a file whose change leads to running code (git internals, package scripts, tool configs);
 * `unknown-path`: a command line's path that can't be told (a variable, `~`, a glob, or outside the roots).
 */
export const SENSITIVITY_KINDS = ['gitignored', 'env', 'key', 'credential', 'token', 'secret-content', 'runs-code', 'unknown-path'] as const;
export const SensitivityKind = z.enum(SENSITIVITY_KINDS);
export type SensitivityKind = z.infer<typeof SensitivityKind>;

/** What happens on a read of a sensitive file: go ahead, ask the person, or refuse. */
export const SensitiveRead = z.enum(['allow', 'ask', 'refuse']);
export type SensitiveRead = z.infer<typeof SensitiveRead>;

/** What happens on a write of a sensitive file: always at least ask. */
export const SensitiveWrite = z.enum(['ask', 'refuse']);
export type SensitiveWrite = z.infer<typeof SensitiveWrite>;

/**
 * How a rule finds files: a glob (a name at any depth without `/`, a path from the root with one; `!` is not used,
 * an exception is a rule with `except`), a pattern over the first bytes of a text file, or git's own ignore rules.
 */
export const SensitivityMatch = z.discriminatedUnion('type', [
  z.object({ type: z.literal('glob'), glob: z.string().min(1) }),
  /** A JavaScript regular expression source, tried on the first `SENSITIVE_SCAN_BYTES` of a text file. */
  z.object({ type: z.literal('content'), pattern: z.string().min(1) }),
  z.object({ type: z.literal('gitignored') }),
]);
export type SensitivityMatch = z.infer<typeof SensitivityMatch>;

/** One rule of the list: what it finds, what kind of file that is, and what reads and writes of it do. */
export const SensitivityRule = z.object({
  /** A short stable name ("env-files"), shown on flags. */
  name: z.string().min(1),
  kind: SensitivityKind,
  match: SensitivityMatch,
  /** Globs this rule leaves alone (`.env.example`). */
  except: z.array(z.string().min(1)).optional(),
  read: SensitiveRead,
  write: SensitiveWrite,
  /** Why, in plain words, for the person and the classifier ("Env files hold keys and passwords."). */
  why: z.string().min(1),
});
export type SensitivityRule = z.infer<typeof SensitivityRule>;

/** How many bytes of a text file content rules look at. */
export const SENSITIVE_SCAN_BYTES = 64 * 1024;

/** One sensitive file a call would touch, and what the rule says about it. */
export const SensitivityFlag = z.object({
  path: z.string().min(1),
  kind: SensitivityKind,
  /** The rule's name. */
  rule: z.string().min(1),
  access: z.enum(['read', 'write']),
  action: z.enum(['allow', 'ask', 'refuse']),
  why: z.string().min(1),
  /**
   * Whether the system is sure the call touches it (`read` and `write` name their path) or only found the path in
   * what it was given (a bash command line).
   */
  certain: z.boolean(),
});
export type SensitivityFlag = z.infer<typeof SensitivityFlag>;

/** The system's answer to `flags`: the files the call would touch that its rules flag (empty when none). */
export const FlagsAnswer = z.object({ flags: z.array(SensitivityFlag) });
export type FlagsAnswer = z.infer<typeof FlagsAnswer>;

/** What the hub does with a call's flags: go ahead, ask the person, or refuse with the rules' words. */
export type FlagsVerdict = { readonly effect: 'pass' } | { readonly effect: 'ask'; readonly reason: string } | { readonly effect: 'refuse'; readonly reason: string };

/** The hub's one rule over a call's flags: any refusal refuses; any write, or a read the rule asks about, asks. */
export function flagsVerdict(flags: readonly SensitivityFlag[]): FlagsVerdict {
  const refused = flags.filter((flag) => flag.action === 'refuse');
  if (refused.length > 0) { return { effect: 'refuse', reason: refused.map(flagLine).join(' ') }; }
  const asked = flags.filter((flag) => flag.access === 'write' || flag.action === 'ask');
  if (asked.length > 0) { return { effect: 'ask', reason: asked.map(flagLine).join(' ') }; }
  return { effect: 'pass' };
}

/** A flag in one sentence: "Writes .env (env file: Env files hold keys and passwords.)". */
export function flagLine(flag: SensitivityFlag): string {
  const does = flag.certain ? (flag.access === 'write' ? 'Writes' : 'Reads') : (flag.access === 'write' ? 'May write' : 'May read');
  return `${does} ${flag.path} (${flag.kind}: ${flag.why})`;
}
