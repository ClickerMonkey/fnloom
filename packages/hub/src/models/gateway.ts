/**
 * The model gateway (`ModelGateway`): every non-chat model call, for a system's run (the `model` link endpoint behind
 * the SDK's forwarding provider) or the hub's own work (dictation, forms). It picks the model (the call's choice, else
 * the role that does the job: `transcribe` for transcription, `speak` for speech; embeddings and images are chosen by
 * capability), reads audio from the content store, makes the call through the execution module's gateway (budgeted,
 * rate-limited and recorded as a `ModelCall`), and keeps images and speech in the content store, answering with refs.
 */
import type { Logger } from '@ayepi/log';
import type { ContentRef, ModelChoice, ModelForward, ModelForwardResult, ModelRole } from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import type { LlmGateway, Recorded } from '../execution/index.ts';
import type { HubCallMetadata } from '../execution/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { ModelGateway, ModelRoles, ModelSite } from './index.ts';

/** The role whose model a modality uses when the call names none. */
const ROLE_OF = { embed: undefined, image: undefined, transcribe: 'transcribe', speech: 'speak' } as const satisfies Record<ModelForward['modality'], ModelRole | undefined>;

/** What the gateway uses. */
export interface ModelGatewayDeps {
  readonly store: HubStore;
  readonly log: Logger;
  readonly roles: Pick<ModelRoles, 'resolve'>;
  readonly llm: Pick<LlmGateway, 'embed' | 'image' | 'transcribe' | 'speech'>;
  readonly content: Pick<ContentStore, 'put' | 'read'>;
}

/** A refusal the caller can act on (no model for the job). */
export class NoModel extends Error {
  override readonly name = 'NoModel';
}

/** The hub's model gateway. */
export class HubModelGateway implements ModelGateway {
  readonly #deps: ModelGatewayDeps;

  constructor(deps: ModelGatewayDeps) {
    this.#deps = deps;
  }

  async forward(request: ModelForward, site: ModelSite, signal: AbortSignal, role?: ModelRole): Promise<ModelForwardResult> {
    const metadata = await this.#metadata(role ?? ROLE_OF[request.modality], request.model);
    const { llm, content } = this.#deps;
    switch (request.modality) {
      case 'embed': {
        const out = await llm.embed({ texts: request.texts, metadata }, site, signal);
        return { modality: 'embed', vectors: out.value, ...receipt(out) };
      }
      case 'image': {
        const out = await llm.image({ prompt: request.prompt, metadata, size: request.size, count: request.count }, site, signal);
        const images = await Promise.all(out.value.map((image) => content.put(image.bytes, image.mime)));
        return { modality: 'image', images, ...receipt(out) };
      }
      case 'transcribe': {
        const audio = await this.#bytes(request.audio);
        const out = await llm.transcribe({ audio, mime: request.audio.mime, metadata, language: request.language }, site, signal);
        return { modality: 'transcribe', text: out.value.text, ...(out.value.segments === undefined ? {} : { segments: [...out.value.segments] }), ...receipt(out) };
      }
      case 'speech': {
        const out = await llm.speech({ text: request.text, metadata, voice: request.voice, format: request.format }, site, signal);
        return { modality: 'speech', audio: await content.put(out.value.audio, out.value.mime), ...receipt(out) };
      }
    }
  }

  /** The aeye selection for a call: its own choice, else its role's model on its role's provider, else selection by capability. */
  async #metadata(role: ModelRole | undefined, choice: ModelChoice | undefined): Promise<HubCallMetadata> {
    if (choice !== undefined) {
      if ('model' in choice) return { model: choice.model };
      if ('auto' in choice) return { weights: compactWeights(choice.auto) };
      const category = (await this.#deps.store.table('modelCategories').find({ where: { name: choice.category }, limit: 1 })).items[0];
      const first = category?.models[0];
      if (first === undefined) throw new NoModel(`The model category ${choice.category} has no models.`);
      return { model: first };
    }
    if (role === undefined) return {};
    const resolved = await this.#deps.roles.resolve(role);
    if (resolved === undefined) throw new NoModel(`No model is set for ${role} (an admin chooses one under model roles).`);
    return { model: resolved.model, provider: resolved.provider };
  }

  /** The bytes of a content ref. */
  #bytes(ref: ContentRef): Promise<Uint8Array> {
    return this.#deps.content.read(ref, 0, ref.size);
  }
}

/** Selection weights with the absent ones left out. */
function compactWeights(auto: { cost?: number | undefined; speed?: number | undefined; accuracy?: number | undefined }): NonNullable<HubCallMetadata['weights']> {
  return { ...(auto.cost === undefined ? {} : { cost: auto.cost }), ...(auto.speed === undefined ? {} : { speed: auto.speed }), ...(auto.accuracy === undefined ? {} : { accuracy: auto.accuracy }) };
}

/** The record part of a forwarded result. */
function receipt<T>(out: Recorded<T>): Pick<ModelForwardResult, 'call' | 'cost' | 'model'> {
  return { call: out.call, cost: out.cost, model: out.model };
}
