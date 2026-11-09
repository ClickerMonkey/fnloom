/**
 * Runs that wait for a person (build 5). Two ways in, one approval record:
 *
 * - **A fn that always asks** (`FnDecl.approval`): every run of it waits in `awaiting-approval` before it starts. When
 *   `preview` is set, the hub first asks the fn's system what the run would do (`preview` on the system link) and
 *   keeps the answer on the approval, so the person sees the SQL, the rows it touches or the schema change.
 * - **A run a system adds** (`propose` on the hub link): the system makes a run of one of its own fns, with the preview
 *   already worked out, that waits for its person (from inside a run) or for an admin (outside one, such as a schema
 *   change found at start). It runs when approved.
 *
 * A declined run settles `cancelled` and the decline's reason goes back to whoever called it, the model included.
 */
import { z } from 'zod';
import { GinTypeDef } from './gin.ts';
import { ApprovalId, Json, LocalName, RunId } from './primitives.ts';
import { ResultTable } from './registries.ts';
import { UserInfo } from './run.ts';

/** One part of what a run would do, as the approval card shows it. */
export const PreviewPart = z.discriminatedUnion('type', [
  /** Plain words, in markdown. */
  z.object({ type: z.literal('text'), text: z.string() }),
  /** Code to run, such as the SQL of a write or the DDL of a schema change. */
  z.object({ type: z.literal('code'), language: z.string(), code: z.string(), title: z.string().optional() }),
  /** Rows the run would touch (a write's matched rows, the rows an insert adds). */
  z.object({ type: z.literal('table'), title: z.string(), table: ResultTable }),
  /**
   * A type before and after (a table-backed type, or a table's type after a rescan). `before` is absent for a new
   * type, `after` for one that goes away; `changes` says each difference in words.
   */
  z.object({
    type: z.literal('type-diff'),
    name: z.string(),
    before: GinTypeDef.optional(),
    after: GinTypeDef.optional(),
    changes: z.array(z.string()),
    /** Saved fns this change would break, by qualified name, with why. */
    breaks: z.array(z.object({ fn: z.string(), why: z.string() })),
  }),
]);
export type PreviewPart = z.infer<typeof PreviewPart>;

/** What a run would do, worked out before it is approved. */
export const ApprovalPreview = z.object({
  /** One line: "Insert 3 rows into orders". */
  title: z.string().min(1),
  parts: z.array(PreviewPart),
  /** Whether it changes data or schema in a way an undo cannot take back (a drop, a delete without a backup). */
  irreversible: z.boolean(),
});
export type ApprovalPreview = z.infer<typeof ApprovalPreview>;

/**
 * A fn whose every run waits for approval (`FnDecl.approval`). `preview`: the hub asks the system for a preview first.
 * `remember`: whether the person may say "don't ask again" for it (never for writes and schema changes).
 */
export const FnApproval = z.object({ preview: z.boolean(), remember: z.boolean() });
export type FnApproval = z.infer<typeof FnApproval>;

/** The hub asks a fn's system what a run would do (`preview` on the system link). */
export const PreviewRequest = z.object({ run: RunId, fn: LocalName, args: Json, user: UserInfo });
export type PreviewRequest = z.infer<typeof PreviewRequest>;

/** The system's answer: the preview, or why the run can't go ahead at all (it then fails as invalid input). */
export const PreviewAnswer = z.union([
  z.object({ preview: ApprovalPreview }),
  z.object({ refused: z.string().min(1) }),
]);
export type PreviewAnswer = z.infer<typeof PreviewAnswer>;

/** Who answers a proposed run: the person of the run that proposed it, or an admin. */
export const ProposalApprover = z.enum(['person', 'admins']);
export type ProposalApprover = z.infer<typeof ProposalApprover>;

/**
 * A system adds a run of one of its own fns that waits for approval (`propose` on the hub link). With `parent` the run
 * is that run's child, in its turn and session; without one it belongs to the system and `approver` must be `admins`.
 */
export const ProposeRun = z.object({
  fn: LocalName,
  args: Json,
  /** The caller's key, so a retried proposal makes no second run. */
  key: z.string().min(1),
  parent: RunId.optional(),
  approver: ProposalApprover,
  preview: ApprovalPreview,
}).refine((value) => value.parent !== undefined || value.approver === 'admins', { message: 'A run proposed outside a run waits for an admin.', path: ['approver'] });
export type ProposeRun = z.infer<typeof ProposeRun>;

/** The run the hub made, waiting, and its approval. */
export const ProposedRun = z.object({ run: RunId, approval: ApprovalId });
export type ProposedRun = z.infer<typeof ProposedRun>;
