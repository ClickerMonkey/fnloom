/**
 * The models module (hub-platform lane): model roles and every non-chat modality through the hub provider.
 *
 * - `ModelRoles`: which model (and provider) the hub uses for each job that isn't an agent's own choice: the default
 *   chat model, transcribing audio, dictation (or the browser's speech recognition), speaking answers, describing
 *   images and reading text in them. Set in the admin's model settings or by asking in chat (`hub/set_model_role`);
 *   without a setting a role falls back to its env default (`HARNESS_TRANSCRIBE_MODEL`, `HARNESS_DEFAULT_MODEL`) or
 *   is off. `ChatCapabilities.voiceInput` and `.dictation` follow it.
 * - `ModelGateway`: embeddings, images, transcription and speech for systems (the `model` link endpoint behind the
 *   SDK's forwarding provider) and for the hub's own work (forms, dictation), each budgeted, rate-limited and recorded
 *   as a `ModelCall`. Chat stays on the execution module's `LlmGateway`.
 */
import type { ActorId, ModelForward, ModelForwardResult, ModelRole, ModelRoleView, ResolvedRole, RoleChoice, RunId, SystemName, TurnId } from '@harness/core';

/** Which model each role uses. */
export interface ModelRoles {
  list(): Promise<ModelRoleView[]>;
  get(role: ModelRole): Promise<ModelRoleView>;
  set(choice: RoleChoice, by: ActorId): Promise<ModelRoleView>;
  clear(role: ModelRole, by: ActorId): Promise<ModelRoleView>;
  /** The model and provider a role resolves to now, or undefined when the role is off. */
  resolve(role: ModelRole): Promise<ResolvedRole | undefined>;
}

/** Who a non-chat call is for: a system's run, or the hub's own work. */
export type ModelSite = { readonly system: SystemName; readonly run?: RunId; readonly turn?: TurnId } | { readonly purpose: string; readonly run?: RunId };

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
}
