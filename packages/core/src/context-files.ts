/**
 * Context folders and loading context. A system's `context/` folder holds markdown files, each a YAML header
 * (`ContextFileHeader`, any context metadata) and then the content. The system's build checks the folder and fails with
 * `ContextFileProblem`s; in dev it watches the folder and sends changes as runtime patches. The hub keys every item by
 * its stable `key` (`ContextDecl.name`), so a moved or renamed file updates the same record.
 */
import { z } from 'zod';
import { ContextDecl } from './manifest.ts';
import { Audience, LocalName, QualifiedName } from './primitives.ts';
import { FnRefusal } from './fn-block.ts';

/**
 * The YAML header of a context file: `ContextDecl` without its content (the body is the content), with `key` for its
 * name and the lists optional. A summary is required, so every item has a short form for small models. Every link
 * (`fns`, `imports`, `choices`, `links`, `parent`, `next`, `alwaysFor`) is a qualified name.
 */
export const ContextFileHeader = ContextDecl.omit({ name: true, content: true }).extend({
  key: LocalName,
  summary: z.string().min(1).max(300),
  imports: z.array(QualifiedName).default([]),
  fns: z.array(QualifiedName).default([]),
  suggestFns: z.array(QualifiedName).default([]),
  suggest: Audience.default('both'),
  visible: Audience.default('both'),
  alwaysFor: z.array(QualifiedName).default([]),
  tags: z.array(z.string()).default([]),
}).strict();
export type ContextFileHeader = z.infer<typeof ContextFileHeader>;

/** The declaration a checked context file becomes: its header, its key as the name, and its body as the content. */
export function contextDeclOf(header: ContextFileHeader, body: string): ContextDecl {
  const { key, ...rest } = header;
  return { ...rest, name: key, content: body };
}

/**
 * References in a context body that the check follows: `[text](context:fs/authoring.kinds)` and `fn:fs/read` (either
 * bare or as a link target). Group 1 is `context` or `fn`, group 2 the qualified name (never ending in a full stop).
 */
export const CONTEXT_BODY_REFERENCE = /\b(context|fn):([a-z][a-z0-9-]*\/[A-Za-z_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/g;

/** Why a context folder doesn't build. */
export const CONTEXT_FILE_PROBLEMS = ['header', 'duplicate-key', 'broken-link', 'cycle', 'missing-summary'] as const;
export const ContextFileProblemCode = z.enum(CONTEXT_FILE_PROBLEMS);
export type ContextFileProblemCode = z.infer<typeof ContextFileProblemCode>;

/** One problem, at a file and line (1-based), as the build prints it: `context/kinds.md:3:1 broken-link …`. */
export const ContextFileProblem = z.object({
  file: z.string().min(1),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  code: ContextFileProblemCode,
  message: z.string().min(1),
});
export type ContextFileProblem = z.infer<typeof ContextFileProblem>;

/**
 * What `hub/load_context` did: the context it loaded (with what each loads with it, every time), the fns that context
 * brings that went into the session's tools, the fns it brings that could not (`fnsRefused`, each with what blocks it), and
 * what it refused, each with the closest names it knows.
 */
export const LoadContextResult = z.object({
  loaded: z.array(QualifiedName),
  fns: z.array(QualifiedName),
  fnsRefused: z.array(FnRefusal),
  refused: z.array(z.object({ context: z.string(), reason: z.string().min(1), closest: z.array(QualifiedName) })),
});
export type LoadContextResult = z.infer<typeof LoadContextResult>;
