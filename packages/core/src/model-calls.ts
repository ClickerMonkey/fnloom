/**
 * Every model call, of every modality, made through the hub. A system never calls a provider: chat goes through the
 * `llm` link endpoint and every other modality (embeddings, images, transcription, speech) through `model`. Each call
 * is one `ModelCall` record with what it used, cost and took, attributed to the run that made it, so performance and
 * spend show for all of them. A chat call also keeps its whole request and response as an `LlmInteraction`.
 *
 * Model roles say which model (and provider) the hub uses for each job that isn't an agent's own choice:
 * transcribing audio, dictation in the composer, speaking answers, describing images, reading text in images.
 */
import { z } from 'zod';
import { ModelChoice } from './llm.ts';
import {
  ActorId, Duration, LlmInteractionId, ModelCallId, PageRequest, Priority, ProviderId, QualifiedName, RunId, SessionId, SystemName, Timestamp, TurnId, Usd,
} from './primitives.ts';
import { ContentRef } from './resources.ts';

// ─── Modalities ───────────────────────────────────────────────────────────────

/** What a model call does. */
export const MODALITIES = ['chat', 'embed', 'image', 'transcribe', 'speech'] as const;
export const Modality = z.enum(MODALITIES);
export type Modality = z.infer<typeof Modality>;

/** What a call used, by modality: the units its price and its speed are measured in. */
export const ModelUnits = z.discriminatedUnion('modality', [
  z.object({ modality: z.literal('chat'), input: z.number().int().min(0), output: z.number().int().min(0), cached: z.number().int().min(0).optional(), reasoning: z.number().int().min(0).optional() }),
  z.object({ modality: z.literal('embed'), texts: z.number().int().min(0), characters: z.number().int().min(0), tokens: z.number().int().min(0).optional(), dimensions: z.number().int().min(1) }),
  z.object({ modality: z.literal('image'), images: z.number().int().min(0), size: z.string().optional() }),
  z.object({ modality: z.literal('transcribe'), seconds: z.number().min(0), bytes: z.number().int().min(0) }),
  z.object({ modality: z.literal('speech'), characters: z.number().int().min(0), seconds: z.number().min(0).optional() }),
]);
export type ModelUnits = z.infer<typeof ModelUnits>;

/** Where a model call is. */
export const ModelCallStatus = z.enum(['running', 'done', 'failed', 'aborted']);
export type ModelCallStatus = z.infer<typeof ModelCallStatus>;

/**
 * One call to a model, of any modality. `queued` is how long it waited for a slot (rate limits, concurrency);
 * `firstByte` how long until the provider answered; `total` from start to end.
 */
export const ModelCall = z.object({
  id: ModelCallId,
  modality: Modality,
  provider: z.string(),
  model: z.string(),
  /** The run it was made for; absent only for the hub's own background work (indexing, conversions). */
  run: RunId.optional(),
  turn: TurnId.optional(),
  session: SessionId.optional(),
  /** The system whose code asked (through `ctx.llm` or the forwarding provider); absent when the hub asked. */
  system: SystemName.optional(),
  fn: QualifiedName.optional(),
  /** What the hub's own work was for, when no run asked: `index`, `form:description`, `contextor`. */
  purpose: z.string().optional(),
  /** The chat call's whole request and response. */
  interaction: LlmInteractionId.optional(),
  units: ModelUnits,
  cost: Usd,
  status: ModelCallStatus,
  error: z.string().optional(),
  priority: Priority.optional(),
  /** Bytes sent and received, for calls whose size matters (audio, images, embeddings). */
  sent: z.number().int().min(0),
  received: z.number().int().min(0),
  queued: Duration,
  firstByte: Duration.optional(),
  total: Duration.optional(),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
});
export type ModelCall = z.infer<typeof ModelCall>;

/** A model call in a list: everything (it has no large fields). */
export const ModelCallFilter = z.object({
  modality: Modality.optional(),
  model: z.string().optional(),
  system: SystemName.optional(),
  run: RunId.optional(),
  session: SessionId.optional(),
  status: ModelCallStatus.optional(),
});
export type ModelCallFilter = z.infer<typeof ModelCallFilter>;
export const ModelCallQuery = PageRequest.extend(ModelCallFilter.shape);
export type ModelCallQuery = z.infer<typeof ModelCallQuery>;

// ─── Non-chat calls over the link ─────────────────────────────────────────────

/** A non-chat model call a system forwards to the hub (the `model` link endpoint), by modality. */
export const ModelForward = z.discriminatedUnion('modality', [
  z.object({ modality: z.literal('embed'), texts: z.array(z.string()).min(1), model: ModelChoice.optional() }),
  z.object({ modality: z.literal('image'), prompt: z.string().min(1), model: ModelChoice.optional(), size: z.string().optional(), count: z.number().int().min(1).max(10).optional() }),
  z.object({ modality: z.literal('transcribe'), audio: ContentRef, model: ModelChoice.optional(), language: z.string().optional() }),
  z.object({ modality: z.literal('speech'), text: z.string().min(1), model: ModelChoice.optional(), voice: z.string().optional(), format: z.enum(['mp3', 'wav', 'ogg']).optional() }),
]).and(z.object({ run: RunId.optional() }));
export type ModelForward = z.infer<typeof ModelForward>;

/** What a forwarded non-chat call gives back, by modality, with its record and cost. Large outputs come by ref. */
export const ModelForwardResult = z.discriminatedUnion('modality', [
  z.object({ modality: z.literal('embed'), vectors: z.array(z.array(z.number())) }),
  z.object({ modality: z.literal('image'), images: z.array(ContentRef) }),
  z.object({ modality: z.literal('transcribe'), text: z.string(), segments: z.array(z.object({ start: z.number().min(0), end: z.number().min(0), text: z.string() })).optional() }),
  z.object({ modality: z.literal('speech'), audio: ContentRef }),
]).and(z.object({ call: ModelCallId, cost: Usd, model: z.string() }));
export type ModelForwardResult = z.infer<typeof ModelForwardResult>;

// ─── Model roles ──────────────────────────────────────────────────────────────

/**
 * The jobs the hub picks a model for itself. `chat`: the default agent model (an agent's own `model` wins).
 * `transcribe`: audio resources and recordings. `dictate`: the composer's voice input. `speak`: reading answers aloud.
 * `describe`: describing images. `ocr`: reading the text in images and scanned pages.
 */
export const MODEL_ROLES = ['chat', 'transcribe', 'dictate', 'speak', 'describe', 'ocr'] as const;
export const ModelRole = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof ModelRole>;

/** A model for a role, optionally pinned to one configured provider (when several serve the same model). */
export const RoleModel = z.object({ model: ModelChoice, provider: ProviderId.optional() });
export type RoleModel = z.infer<typeof RoleModel>;

/** Dictation runs in the browser (its speech recognition, no model call) or through a transcription model. */
export const DictationEngine = z.discriminatedUnion('engine', [
  z.object({ engine: z.literal('browser') }),
  RoleModel.extend({ engine: z.literal('model') }),
]);
export type DictationEngine = z.infer<typeof DictationEngine>;

/** The roles whose setting is a model (every role but dictation, which has an engine). */
export const ModelOnlyRole = ModelRole.exclude(['dictate']);
export type ModelOnlyRole = z.infer<typeof ModelOnlyRole>;

/** The setting of one role: dictation has its engine; every other role is a model. `language` is a BCP 47 hint. */
export const RoleChoice = z.discriminatedUnion('role', [
  z.object({ role: z.literal('dictate'), engine: DictationEngine, language: z.string().optional() }),
  RoleModel.extend({ role: ModelOnlyRole, language: z.string().optional() }),
]);
export type RoleChoice = z.infer<typeof RoleChoice>;

/** A stored role setting. Without one, a role falls back to the hub's env default (or is off). */
export const ModelRoleRecord = z.object({ role: ModelRole, choice: RoleChoice, setBy: ActorId, updatedAt: Timestamp });
export type ModelRoleRecord = z.infer<typeof ModelRoleRecord>;

/** A role as the settings page shows it: its choice (stored, or from env), and whether it can be used now. */
export const ModelRoleView = z.object({
  role: ModelRole,
  choice: RoleChoice.optional(),
  from: z.enum(['setting', 'env', 'none']),
  /** The model the choice resolves to now, and why not when it can't be used (no provider, no such model). */
  resolved: z.union([z.object({ model: z.string(), provider: z.string() }), z.object({ problem: z.string() })]).optional(),
});
export type ModelRoleView = z.infer<typeof ModelRoleView>;
