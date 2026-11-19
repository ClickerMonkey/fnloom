/**
 * The models module (hub-platform lane): model roles and every non-chat modality through the hub provider.
 *
 * - `ModelRoles`: which model (and provider) the hub uses for each job that isn't an agent's own choice: the default
 *   chat model, transcribing audio, dictation (or the browser's speech recognition), speaking answers, describing
 *   images and reading text in them. Set in the admin's model settings or by asking in chat (`hub/set_model_role`);
 *   without a setting a role falls back to its env default (`HARNESS_TRANSCRIBE_MODEL`, `HARNESS_DEFAULT_MODEL`) or
 *   is off. `ChatCapabilities.voiceInput` and `.dictation` follow it.
 * - `ModelGateway`: embeddings, images, transcription, speech and decisions for systems (the `model` link endpoint
 *   behind the SDK's forwarding provider) and for the hub's own work (forms, dictation), each budgeted, rate-limited and
 *   recorded as a `ModelCall`. Chat stays on the execution module's `LlmGateway`.
 * - `Decider`: the hub's own decisions by a decision model (the `decide` role's, or one a job chose), its questions split
 *   by the model's `maxQuestions`, and the role's threshold for what counts as yes.
 */
import type { DecisionAnswer } from '@aeye/ai';
import type {
  ActorId, DecisionInput, DecisionQuestions, InstanceName, ModelCallId, ModelForward, ModelForwardResult, ModelRole, ModelRoleView, ResolvedRole, RoleChoice, RoleModel,
  RoleResolution, RunId, SystemName, TurnId, Usd,
} from '@harness/core';

/** Which model each role uses. */
export interface ModelRoles {
  list(): Promise<ModelRoleView[]>;
  get(role: ModelRole): Promise<ModelRoleView>;
  set(choice: RoleChoice, by: ActorId): Promise<ModelRoleView>;
  clear(role: ModelRole, by: ActorId): Promise<ModelRoleView>;
  /** Whether a role has a choice (its setting, or its env default), without resolving it: what `FnDecl.roles` checks. */
  isSet(role: ModelRole): Promise<boolean>;
  /** The model and provider a role resolves to now, or undefined when the role is off. */
  resolve(role: ModelRole): Promise<ResolvedRole | undefined>;
  /** A model chosen for a role's job (not the role's own setting) against what providers offer now. */
  resolveModel(role: ModelRole, wanted: RoleModel): Promise<RoleResolution>;
}

/** A decision model ready to ask: which model on which provider, the threshold a yes needs, and its question cap. */
export interface DecisionModel {
  readonly model: string;
  readonly provider: string;
  /** The decide role's threshold: the probability a yes/no answer needs to count as yes. */
  readonly threshold: number;
  /** The most questions it answers in one call (aeye's `ModelInfo.maxQuestions`); none when it has no cap. */
  readonly maxQuestions?: number;
  /** The most bytes of input and questions it takes in one call (aeye's `ModelInfo.maxRequestBytes`); none when no cap is known. */
  readonly maxRequestBytes?: number;
}

/** Every answer by question name, and the calls that gave them, with what they cost in all. */
export interface DecidedAnswers {
  readonly answers: Record<string, DecisionAnswer>;
  readonly calls: readonly ModelCallId[];
  readonly cost: Usd;
}

/** The hub's own decisions by a decision model. */
export interface Decider {
  /**
   * The decision model a job uses: `choice` when it names one, else the `decide` role's; with the role's threshold.
   * When there is none, or it can't be used now, why (`problem`), for the caller's record.
   */
  model(choice?: RoleModel): Promise<DecisionModel | { readonly problem: string }>;
  /** Ask `questions` about `input`, in calls within the model's `maxQuestions` and `maxRequestBytes`, one after another. */
  ask(request: { input: DecisionInput; questions: DecisionQuestions; model: DecisionModel; site: ModelSite; signal: AbortSignal }): Promise<DecidedAnswers>;
}

/** Who a non-chat call is for: a system's run, or the hub's own work. */
export type ModelSite = { readonly system: SystemName; readonly instance?: InstanceName; readonly run?: RunId; readonly turn?: TurnId } | { readonly purpose: string; readonly run?: RunId };

/** Every non-chat modality through the hub provider. */
export interface ModelGateway {
  /**
   * One call. Without a model in the request it goes to `role`'s model (default: the modality's role) on the provider
   * that role resolved to, so the provider the settings page shows is the one that answers.
   */
  forward(request: ModelForward, site: ModelSite, signal: AbortSignal, role?: ModelRole): Promise<ModelForwardResult>;
}

/** The models module's services (`HubServices.models`). */
export interface ModelServices {
  readonly roles: ModelRoles;
  readonly gateway: ModelGateway;
  readonly decider: Decider;
}
