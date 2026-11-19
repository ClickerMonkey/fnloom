/**
 * A/B compare as the web sees it: what starting one sends, and a compared turn with each variant's answer, spend,
 * tokens, time and the approvals it waits on. The stored shapes are in `records/compare.ts`.
 */
import { z } from 'zod';
import { Duration, MessageId, SessionId, Timestamp, TurnId, Usd } from './primitives.ts';
import { ClientInfo } from './run.ts';
import { Approval } from './records/actors.ts';
import { ChatMessage, OutgoingPart } from './records/chat.ts';
import { CompareVariant, CompareVariantInputs, TurnCompare, VariantIndex } from './records/compare.ts';
import { TurnStatus } from './records/runs.ts';

/** Send a message answered by several variants of the chat's settings at once. */
export const CompareStart = z.object({ session: SessionId, parts: z.array(OutgoingPart).min(1), variants: CompareVariantInputs, client: ClientInfo });
export type CompareStart = z.infer<typeof CompareStart>;

/** One variant as the compare view shows it: how it stands, what it spent, its answer and what it waits on. */
export const CompareVariantView = CompareVariant.extend({
  status: TurnStatus,
  /** What it spent so far, of its `reserved` share. */
  spent: Usd,
  /** Model tokens its agent used. */
  tokens: z.number().int().min(0),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  /** How long it took (or has taken, while it runs). */
  time: Duration,
  /** Its answer: the assistant messages of its turn, oldest first. */
  messages: z.array(ChatMessage),
  /** Approvals its runs wait on, each marked with the variant (`Approval.variant`). */
  approvals: z.array(Approval),
});
export type CompareVariantView = z.infer<typeof CompareVariantView>;

/** A compared turn: its message, each variant, and which was chosen and what the others did. */
export const CompareView = TurnCompare.omit({ variants: true }).extend({
  turn: TurnId,
  session: SessionId,
  message: MessageId,
  status: TurnStatus,
  variants: z.array(CompareVariantView),
});
export type CompareView = z.infer<typeof CompareView>;

/** Choose a variant's answer; `adopt` also makes its settings the chat's own. */
export const CompareChoose = z.object({ turn: TurnId, variant: VariantIndex, adopt: z.boolean().optional() });
export type CompareChoose = z.infer<typeof CompareChoose>;
