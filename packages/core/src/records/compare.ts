/**
 * A/B compare (plan item 11): one message answered by 2 to 4 variants of the chat's settings side by side, each in a
 * fork of the session, so the person can choose the answer they want. The session's own settings are `SessionSettings`;
 * a variant changes any of them (`CompareSettings`), the system prompt too.
 */
import { z } from 'zod';
import { ModelChoice } from '../llm.ts';
import { ChatFnMode, ChatModeConfig, ContextorConfig } from '../modes.ts';
import { ActorId, QualifiedName, RunId, SessionId, SystemName, Timestamp, TurnId, Usd } from '../primitives.ts';

/** The fewest and most variants a compare runs. */
export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 4;

/** A variant's place in its compare: 0 to `MAX_VARIANTS - 1`. */
export const VariantIndex = z.number().int().min(0).max(MAX_VARIANTS - 1);
export type VariantIndex = z.infer<typeof VariantIndex>;

/** How a chat answers: who answers, with which model, mode and contextor, how far it may go, its systems, its system prompt. */
export const SessionSettings = z.object({
  /** The agent fn that answers. Default `hub/chat`. */
  agent: QualifiedName,
  /** The model the agent answers with in this chat, instead of the one its fn chooses. */
  model: ModelChoice.optional(),
  /** The chat mode and contextor here, instead of the agent fn's. */
  mode: ChatModeConfig.optional(),
  contextor: ContextorConfig.optional(),
  /** How far the agent may go with fns here (absent: as far as the policies allow, like `delete`). */
  fnMode: ChatFnMode.optional(),
  /** Only these systems' fns, context, mentions and hooks apply. The hub's own message extras always do. */
  systems: z.union([z.array(SystemName), z.literal('all')]),
  /** The agent's system prompt here, instead of its fn's instructions. */
  instructions: z.string().optional(),
});
export type SessionSettings = z.infer<typeof SessionSettings>;

/** What a variant changes of the chat's settings; anything left out is as the chat has it. */
export const CompareSettings = SessionSettings.partial();
export type CompareSettings = z.infer<typeof CompareSettings>;

/** A variant as the person asks for it: its settings and, optionally, a name ("Fast", "Strict"). */
export const CompareVariantInput = z.object({ label: z.string().trim().min(1).max(40).optional(), settings: CompareSettings });
export type CompareVariantInput = z.infer<typeof CompareVariantInput>;

/** The variants of a compare, as asked for. */
export const CompareVariantInputs = z.array(CompareVariantInput).min(MIN_VARIANTS).max(MAX_VARIANTS);

/** Which compare a fork session (and an approval in it) belongs to: the compared turn and the variant. */
export const CompareFork = z.object({ turn: TurnId, variant: VariantIndex, label: z.string() });
export type CompareFork = z.infer<typeof CompareFork>;

/** One variant of a compare: its settings, the fork session it answers in, and its own turn there. */
export const CompareVariant = z.object({
  variant: VariantIndex,
  label: z.string(),
  settings: CompareSettings,
  session: SessionId,
  turn: TurnId,
});
export type CompareVariant = z.infer<typeof CompareVariant>;

/** Something a discarded variant did that stays done: a run that changed something and was not undone. */
export const CompareEffect = z.object({ run: RunId, fn: QualifiedName });
export type CompareEffect = z.infer<typeof CompareEffect>;

/** A variant that was not chosen, with the effects it already had. */
export const DiscardedVariant = z.object({ variant: VariantIndex, effects: z.array(CompareEffect) });
export type DiscardedVariant = z.infer<typeof DiscardedVariant>;

/**
 * What one variant did that stays done once its compared turn is undone: the turn was undone before a variant was chosen,
 * or the variant was not chosen. Undo leaves it as it is (only the chosen variant's runs belong to the turn), so the
 * undo report and note list it, by variant.
 */
export const KeptVariant = z.object({ variant: VariantIndex, label: z.string(), effects: z.array(CompareEffect).min(1) });
export type KeptVariant = z.infer<typeof KeptVariant>;

/**
 * A compared turn's variants (`Turn.compare`). Each variant is reserved its share of the turn's budget up front
 * (`reserved`), so all of them together never spend more than one answer may. Once one is chosen (`chosen`) its answer
 * is the turn's, and the others are discarded with what they did listed.
 */
export const TurnCompare = z.object({
  variants: z.array(CompareVariant).min(MIN_VARIANTS).max(MAX_VARIANTS),
  /** Each variant's budget: the turn's cost cap split evenly between them. */
  reserved: Usd,
  chosen: VariantIndex.optional(),
  chosenBy: ActorId.optional(),
  chosenAt: Timestamp.optional(),
  discarded: z.array(DiscardedVariant),
});
export type TurnCompare = z.infer<typeof TurnCompare>;
