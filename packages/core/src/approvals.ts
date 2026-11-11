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
import { ActorId, ApprovalId, FnKindName, InstanceName, InstanceRef, Json, LocalName, RunId, SystemName, Timestamp } from './primitives.ts';
import { InstallChecks } from './checks.ts';
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

/**
 * Build 6: what installing a system from the chat would start (`fs/install_system`). The hub reads it when the approved
 * run asks for a pairing grant (`grantPairing`), and the system that connects with the grant must say the same name,
 * instance and manifest hash. The parts are shown on the card; only these fields bind.
 */
export const InstallSubject = z.object({
  kind: z.literal('system-install'),
  system: SystemName,
  instance: InstanceName,
  version: z.string().min(1),
  /** The hash of the contract the built bundle declares (`Manifest.hash`). */
  manifestHash: z.string().min(1),
  /** sha-256 of the self-contained bundle that will run. */
  bundleHash: z.string().min(1),
  /** sha-256 of the source folder, so a change after approval is caught. */
  sourceHash: z.string().min(1),
  /** The system instance that builds, starts and supervises it (`fs/main`). */
  host: InstanceRef,
  /** Build 7: the hosted source folder it was built from, so the hub never reads the host fn's args for it. */
  source: z.string().min(1).optional(),
  /** The version running now, when this replaces one. */
  replaces: z.object({ version: z.string().min(1), manifestHash: z.string().min(1) }).optional(),
});
export type InstallSubject = z.infer<typeof InstallSubject>;

/** Build 6: what an approval binds, beyond its words. One kind so far. */
export const ApprovalSubject = z.discriminatedUnion('kind', [InstallSubject]);
export type ApprovalSubject = z.infer<typeof ApprovalSubject>;

/** What a run would do, worked out before it is approved. */
export const ApprovalPreview = z.object({
  /** One line: "Insert 3 rows into orders". */
  title: z.string().min(1),
  parts: z.array(PreviewPart),
  /** Whether it changes data or schema in a way an undo cannot take back (a drop, a delete without a backup). */
  irreversible: z.boolean(),
  /** Build 6: what the approval binds (an install's hashes), checked again when the run acts on it. */
  subject: ApprovalSubject.optional(),
  /** Build 7: an install's bundle scan and test results, shown on its card (not part of what the approval binds). */
  checks: InstallChecks.optional(),
});
export type ApprovalPreview = z.infer<typeof ApprovalPreview>;

/** Who answers a proposed run or a fn that always asks: the run's person, or an admin (only an admin's decision counts). */
export const ProposalApprover = z.enum(['person', 'admins']);
export type ProposalApprover = z.infer<typeof ProposalApprover>;

/**
 * A fn whose every run waits for approval (`FnDecl.approval`). `preview`: the hub asks the system for a preview first.
 * `remember`: whether the person may say "don't ask again" for it (never for writes and schema changes).
 */
export const FnApproval = z.object({
  preview: z.boolean(),
  remember: z.boolean(),
  /** Build 6: who decides; `person` when absent. With `admins` a member's call waits for an admin, who is notified. */
  approver: ProposalApprover.optional(),
});
export type FnApproval = z.infer<typeof FnApproval>;

/** The hub asks a fn's system what a run would do (`preview` on the system link). */
export const PreviewRequest = z.object({
  run: RunId,
  fn: LocalName,
  args: Json,
  user: UserInfo,
  /** The fn's kind; absent or `native` for a native fn. */
  kind: FnKindName.optional(),
  /** A kind fn's payload, since the kind's system works out the preview from it. */
  payload: Json.optional(),
});
export type PreviewRequest = z.infer<typeof PreviewRequest>;

/** The system's answer: the preview, or why the run can't go ahead at all (it then fails as invalid input). */
export const PreviewAnswer = z.union([
  z.object({ preview: ApprovalPreview }),
  z.object({ refused: z.string().min(1) }),
]);
export type PreviewAnswer = z.infer<typeof PreviewAnswer>;

/**
 * A system adds a run of one of its own fns that waits for approval (`propose` on the hub link). With `parent` the run
 * is that run's child, in its turn and session; without one it belongs to the system and `approver` must be `admins`.
 */
export const ProposeRun = z.object({
  fn: LocalName,
  args: Json,
  /**
   * The caller's key, so a retried proposal makes no second run. Under a run it names that run's child for good (a
   * replayed parent gets the same answer); outside any run it holds only while the proposal is open, so once it
   * settles (done, declined, cancelled) the same key proposes afresh.
   */
  key: z.string().min(1),
  parent: RunId.optional(),
  approver: ProposalApprover,
  preview: ApprovalPreview,
}).refine((value) => value.parent !== undefined || value.approver === 'admins', { message: 'A run proposed outside a run waits for an admin.', path: ['approver'] });
export type ProposeRun = z.infer<typeof ProposeRun>;

/** Build 6: the approval a run went ahead on (`RunRequest.approved`, `ctx.approved` in the SDK). */
export const ApprovedRun = z.object({ by: ActorId, preview: ApprovalPreview });
export type ApprovedRun = z.infer<typeof ApprovedRun>;

/** Build 6: an approved install run asks the hub for a one-time pairing token bound to its subject (`grantPairing`). */
export const PairingGrantRequest = z.object({ run: RunId, subject: InstallSubject });
export type PairingGrantRequest = z.infer<typeof PairingGrantRequest>;

/** The token (shown once, valid for one hello with the subject's name, instance and manifest hash) and when it lapses. */
export const PairingGrant = z.object({ token: z.string().min(1), expiresAt: Timestamp });
export type PairingGrant = z.infer<typeof PairingGrant>;

/** The run the hub made, waiting, and its approval. */
export const ProposedRun = z.object({ run: RunId, approval: ApprovalId });
export type ProposedRun = z.infer<typeof ProposedRun>;
