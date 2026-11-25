/**
 * Forms a model makes, through the hub like every other model call: an image's description and the text in it go to
 * the role's vision model through the LLM gateway (an `LlmInteraction` and a `ModelCall`), a recording's transcript
 * to the transcription role through the model gateway (a `ModelCall`). Which model is the admin's model role
 * (`describe`, `ocr`, `transcribe`); with the role off, the form is refused and offered without a model.
 */
import { reject } from '@ayepi/core';
import type { LlmContentPart, MadeFormKind, ModelRole } from '@harness/core';
import type { LlmGateway } from '../execution/index.ts';
import type { ModelGateway, ModelRoles } from '../models/index.ts';
import type { Asking, FormModels, MadeForm, MadeFormInput } from './index.ts';

/** The system name the hub's own model calls are made as. */
const HUB = 'hub';

/** The model role that makes each kind, or undefined when no model makes it here (thumbnails). */
export const FORM_ROLES: Readonly<Record<MadeFormKind, ModelRole | undefined>> = {
  description: 'describe',
  ocr: 'ocr',
  transcript: 'transcribe',
  thumbnail: undefined,
};

/** What the vision model is asked, by kind. */
export const VISION_PROMPTS = {
  description: 'Describe this image for someone who cannot see it: what it shows, its layout, any text in it, and anything notable. Plain prose, no preamble.',
  ocr: 'Write out all of the text in this image exactly as it appears, in reading order, keeping line breaks. Write nothing else. If there is no text, write nothing.',
} as const satisfies Partial<Record<MadeFormKind, string>>;

/** The code `hub/image_read` is refused with when no vision model is set up. */
export const NO_IMAGE_MODEL = 'NO_IMAGE_MODEL';

/** What it says then: plainly, and who can change it. */
export const NO_IMAGE_MODEL_TEXT = 'no image model is set up: nothing here can look at images. An admin chooses a model that can see images for the "describe" role under Models (or with hub/set_model_role)';

/** What the vision model is asked for a model that can't see the image. */
export function imageQuestion(question: string): string {
  return [
    'Another assistant, which cannot see images, asks you about this image. Answer its question from what the image shows.',
    'Be exact: quote any text, numbers and names word for word, and keep their order. Say plainly when the image does not show something or you cannot make it out; never guess.',
    'Answer directly, with no preamble.',
    '',
    `Question: ${question}`,
  ].join('\n');
}

/** What making forms with models needs. */
export interface HubFormModelsOptions {
  readonly roles: () => Pick<ModelRoles, 'resolve'>;
  readonly llm: () => Pick<LlmGateway, 'forward'>;
  readonly gateway: () => Pick<ModelGateway, 'forward'>;
}

/** Model-made forms over the hub's model roles and gateways. */
export class HubFormModels implements FormModels {
  readonly #o: HubFormModelsOptions;

  constructor(options: HubFormModelsOptions) {
    this.#o = options;
  }

  async model(kind: MadeFormKind): Promise<string | undefined> {
    const role = FORM_ROLES[kind];
    return role === undefined ? undefined : (await this.#o.roles().resolve(role))?.model;
  }

  async make(kind: MadeFormKind, input: MadeFormInput, who: Asking, signal?: AbortSignal): Promise<MadeForm> {
    const role = FORM_ROLES[kind];
    if (role === undefined) { throw reject(422, 'NO_FORM_MODEL', `the hub does not make ${kind} forms with a model`); }
    const chosen = await this.#o.roles().resolve(role);
    if (chosen === undefined) { throw reject(409, 'ROLE_OFF', `no model is set to ${role}; choose one in the model settings`); }
    const abort = signal ?? new AbortController().signal;
    switch (kind) {
      case 'description': case 'ocr': return this.#vision(VISION_PROMPTS[kind], chosen.model, input, who, abort);
      case 'transcript': return this.#transcribe(chosen.model, input, who, abort);
      case 'thumbnail': throw reject(422, 'NO_FORM_MODEL', 'the hub does not make thumbnails with a model');
    }
  }

  async ask(question: string, input: MadeFormInput, who: Asking, signal?: AbortSignal): Promise<MadeForm> {
    const chosen = await this.#o.roles().resolve('describe');
    if (chosen === undefined) { throw reject(409, NO_IMAGE_MODEL, NO_IMAGE_MODEL_TEXT); }
    return this.#vision(imageQuestion(question), chosen.model, input, who, signal ?? new AbortController().signal);
  }

  /** Ask the vision model about an image. */
  async #vision(prompt: string, model: string, input: MadeFormInput, who: Asking, signal: AbortSignal): Promise<MadeForm> {
    if (!input.raw.mime.startsWith('image/')) { throw reject(422, 'NOT_AN_IMAGE', `${input.name} is ${input.raw.mime}, not an image`); }
    const image: LlmContentPart = { type: 'image', content: `data:${input.raw.mime};base64,${Buffer.from(input.bytes).toString('base64')}`, format: input.raw.mime, name: input.name };
    const stream = this.#o.llm().forward({
      system: HUB, stream: false, model: { model },
      request: { messages: [{ role: 'user', content: [{ type: 'text', content: prompt }, image] }] },
      ...(who.run === undefined ? {} : { run: who.run }),
    }, signal);
    let text = '';
    let served = model;
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'chunk': text += chunk.chunk.content ?? ''; break;
        case 'done': served = chunk.model; break;
        case 'error': throw reject(502, 'FORM_MODEL_FAILED', `${model} could not read ${input.name}: ${chunk.message}`);
      }
    }
    return { text: text.trim(), model: served };
  }

  /** Transcribe a recording. */
  async #transcribe(model: string, input: MadeFormInput, who: Asking, signal: AbortSignal): Promise<MadeForm> {
    const mime = input.raw.mime;
    if (!mime.startsWith('audio/') && !mime.startsWith('video/')) { throw reject(422, 'NOT_A_RECORDING', `${input.name} is ${mime}, not audio or video`); }
    const run = who.run === undefined ? {} : { run: who.run };
    const result = await this.#o.gateway().forward({ modality: 'transcribe', audio: input.raw, model: { model }, ...run }, { purpose: 'form:transcript', ...run }, signal);
    if (result.modality !== 'transcribe') { throw reject(502, 'FORM_MODEL_FAILED', `${model} gave ${result.modality}, not a transcript`); }
    return { text: result.text.trim(), model: result.model, call: result.call };
  }
}
