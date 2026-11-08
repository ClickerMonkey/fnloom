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
  ActorId, Duration, LlmInteractionId, ModelCallId, PageRequest, Priority, ProviderId, QualifiedName, RunId, type Same, SessionId, SystemName, Timestamp, TurnId, Usd,
} from './primitives.ts';
import { ContentRef } from './resources.ts';

// ─── Modalities ───────────────────────────────────────────────────────────────

/** What a model call does. */
export const MODALITIES = ['chat', 'embed', 'image', 'transcribe', 'speech'] as const;
export const Modality = z.enum(MODALITIES);
export type Modality = z.infer<typeof Modality>;

/** What a chat call used: tokens in and out. */
export const ChatUnits = z.object({ modality: z.literal('chat'), input: z.number().int().min(0), output: z.number().int().min(0), cached: z.number().int().min(0).optional(), reasoning: z.number().int().min(0).optional() });
/** What an embedding call used: texts, their characters, and the vectors' size. */
export const EmbedUnits = z.object({ modality: z.literal('embed'), texts: z.number().int().min(0), characters: z.number().int().min(0), tokens: z.number().int().min(0).optional(), dimensions: z.number().int().min(1) });
/** What an image call used: images made, and their size. */
export const ImageUnits = z.object({ modality: z.literal('image'), images: z.number().int().min(0), size: z.string().optional() });
/** What a transcription call used: seconds and bytes of audio. */
export const TranscribeUnits = z.object({ modality: z.literal('transcribe'), seconds: z.number().min(0), bytes: z.number().int().min(0) });
/** What a speech call used: characters read, and the seconds of audio made. */
export const SpeechUnits = z.object({ modality: z.literal('speech'), characters: z.number().int().min(0), seconds: z.number().min(0).optional() });

/** What a call used, by modality: the units its price and its speed are measured in. */
export const ModelUnits = z.discriminatedUnion('modality', [ChatUnits, EmbedUnits, ImageUnits, TranscribeUnits, SpeechUnits]);
export type ModelUnits = z.infer<typeof ModelUnits>;

/** The formats speech audio comes in. */
export const SPEECH_FORMATS = ['mp3', 'wav', 'ogg'] as const;
export const SpeechFormat = z.enum(SPEECH_FORMATS);
export type SpeechFormat = z.infer<typeof SpeechFormat>;

/** Where a model call is. */
export const ModelCallStatus = z.enum(['running', 'done', 'failed', 'aborted']);
export type ModelCallStatus = z.infer<typeof ModelCallStatus>;

/** The fields every model call has, whatever its modality. */
const ModelCallBase = z.object({
  id: ModelCallId,
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
/** A call's modality with its units, which the schema keeps in step (units always carry their own modality). */
const usageOf = <U extends typeof ModelUnits.options[number]>(units: U) => z.object({ modality: units.shape.modality, units });

/** The part of a `ModelCall` that varies by modality: the modality and what the call used, in its units. */
export const ModelUsage = z.discriminatedUnion('modality', [usageOf(ChatUnits), usageOf(EmbedUnits), usageOf(ImageUnits), usageOf(TranscribeUnits), usageOf(SpeechUnits)]);
export type ModelUsage = z.infer<typeof ModelUsage>;

/** The usage of a call that used `units`: their modality with them. */
export function usageFor(units: ModelUnits): ModelUsage {
  return ModelUsage.parse({ modality: units.modality, units });
}

/** A call of one modality. */
const callOf = <U extends typeof ModelUsage.options[number]>(usage: U) => ModelCallBase.extend(usage.shape);

/**
 * One call to a model, of any modality. `queued` is how long it waited for a slot (rate limits, concurrency);
 * `firstByte` how long until the provider answered; `total` from start to end. A discriminated union on `modality`,
 * so a call's units are always its own modality's.
 */
export const ModelCall = z.discriminatedUnion('modality', [
  callOf(ModelUsage.options[0]), callOf(ModelUsage.options[1]), callOf(ModelUsage.options[2]), callOf(ModelUsage.options[3]), callOf(ModelUsage.options[4]),
]);
export type ModelCall = z.infer<typeof ModelCall>;

// Every modality has its units and its call shape, and nothing else does.
true satisfies Same<ModelCall['modality'], Modality>;

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
  z.object({ modality: z.literal('speech'), text: z.string().min(1), model: ModelChoice.optional(), voice: z.string().optional(), format: SpeechFormat.optional() }),
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

/**
 * The ability each role's model needs, in aeye's capability words (`ModelInfo.capabilities`). The hub pins these to
 * aeye's `ModelCapability` at compile time; the admin's role editor offers the able models first.
 */
export const ROLE_CAPABILITY = {
  chat: 'chat', transcribe: 'hearing', dictate: 'hearing', speak: 'audio', describe: 'vision', ocr: 'vision',
} as const satisfies Record<ModelRole, string>;

/** A model for a role, optionally pinned to one configured provider (when several serve the same model). */
export const RoleModel = z.object({ model: ModelChoice, provider: ProviderId.optional() });
export type RoleModel = z.infer<typeof RoleModel>;

/** Dictation runs in the browser (its speech recognition, no model call) or through a transcription model. */
export const DictationEngine = z.discriminatedUnion('engine', [
  z.object({ engine: z.literal('browser') }),
  RoleModel.extend({ engine: z.literal('model') }),
]);
export type DictationEngine = z.infer<typeof DictationEngine>;
/** The ways dictation can run: exactly `DictationEngine`'s engines (a new one fails to compile here until listed). */
export const DICTATION_ENGINES = ['browser', 'model'] as const;
true satisfies Same<(typeof DICTATION_ENGINES)[number], DictationEngine['engine']>;

/** The roles whose setting is a model (every role but dictation, which has an engine). */
export const ModelOnlyRole = ModelRole.exclude(['dictate']);
export type ModelOnlyRole = z.infer<typeof ModelOnlyRole>;

/** The setting of one role: dictation has its engine; every other role is a model. `language` is a BCP 47 hint. */
export const RoleChoice = z.discriminatedUnion('role', [
  z.object({ role: z.literal('dictate'), engine: DictationEngine, language: z.string().optional() }),
  RoleModel.extend({ role: ModelOnlyRole, language: z.string().optional() }),
]);
export type RoleChoice = z.infer<typeof RoleChoice>;

/** A stored role setting, keyed by its choice's role. Without one, a role falls back to the hub's env default (or is off). */
export const ModelRoleRecord = z.object({ choice: RoleChoice, setBy: ActorId, updatedAt: Timestamp });
export type ModelRoleRecord = z.infer<typeof ModelRoleRecord>;

/**
 * What a role's choice resolves to now: the model and the provider (aeye's provider name, as `ModelInfo.provider`)
 * that serves it, or why the choice can't be used (no provider, no such model, a model that can't do the job).
 */
export const RoleResolution = z.union([z.object({ model: z.string(), provider: z.string() }), z.object({ problem: z.string() })]);
export type RoleResolution = z.infer<typeof RoleResolution>;
/** A resolution that found its model. */
export type ResolvedRole = Extract<RoleResolution, { model: string }>;

/** A role as the settings page shows it: its choice (stored, or from env), and whether it can be used now. */
export const ModelRoleView = z.object({
  role: ModelRole,
  choice: RoleChoice.optional(),
  from: z.enum(['setting', 'env', 'none']),
  /** What the choice resolves to now; absent without a choice, or for dictation in the browser (no model). */
  resolved: RoleResolution.optional(),
});
export type ModelRoleView = z.infer<typeof ModelRoleView>;
