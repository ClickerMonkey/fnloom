/**
 * Model calls other than chat, as the hub AI makes them: what each engine call takes and gives (`EmbedCall`, …), and
 * how the hub AI's hooks read a call into a `ModelCall`. The engine method that makes a call carries its modality and
 * its typed aeye request (`MediaRequest`) to the hooks; `MODALITY_READERS` (one reader per modality, typed by that
 * modality's aeye request and response) gives the units it used (`unitsOf`) and how many bytes went each way
 * (`sizesOf`). A new modality fails to compile until it has its aeye shapes and its reader here.
 */
import type {
  DecisionRequest, DecisionResponse, EmbeddingInput, EmbeddingRequest, EmbeddingResponse, ImageGenerationRequest, ImageGenerationResponse, SpeechRequest, SpeechResponse, TranscriptionRequest,
  TranscriptionResponse,
} from '@aeye/ai';
import { embeddingInputs, isEmbeddingImage } from '@aeye/ai';
import type { BaseResponse, Message, Request, Resource, Response, Usage } from '@aeye/core';
import type { DecisionQuestions, Modality, ModelUnits, SpeechFormat } from '@harness/core';
import type { HubCallMetadata } from './scope.ts';

/** Embeddings of some inputs: texts and images (aeye's one `inputs` list), one vector each in order. */
export interface EmbedCall {
  readonly inputs: readonly EmbeddingInput[];
  readonly metadata: HubCallMetadata;
}

/** Images made from a prompt. */
export interface ImageCall {
  readonly prompt: string;
  readonly metadata: HubCallMetadata;
  readonly size?: string | undefined;
  readonly count?: number | undefined;
}

/** One image a model made: its bytes and type. */
export interface MadeImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/** The text spoken in a recording. */
export interface TranscribeCall {
  readonly audio: Uint8Array;
  readonly mime: string;
  readonly metadata: HubCallMetadata;
  readonly language?: string | undefined;
}

/** What a transcription heard. */
export interface Heard {
  readonly text: string;
  readonly segments?: ReadonlyArray<{ start: number; end: number; text: string }> | undefined;
}

/** Speech made from text. */
export interface SpeechCall {
  readonly text: string;
  readonly metadata: HubCallMetadata;
  readonly voice?: string | undefined;
  readonly format?: SpeechFormat | undefined;
}

/** Audio a model spoke. */
export interface Spoken {
  readonly audio: Uint8Array;
  readonly mime: string;
}

/** Typed answers about an input from a decision model, within its `maxQuestions`. */
export interface DecideCall {
  readonly input: string | Message[];
  readonly questions: DecisionQuestions;
  readonly metadata: HubCallMetadata;
}

/** Each modality's aeye request and response. */
export interface ModalityShapes {
  readonly chat: { readonly request: Request; readonly response: Response };
  readonly embed: { readonly request: EmbeddingRequest; readonly response: EmbeddingResponse };
  readonly image: { readonly request: ImageGenerationRequest; readonly response: ImageGenerationResponse };
  readonly transcribe: { readonly request: TranscriptionRequest; readonly response: TranscriptionResponse };
  readonly speech: { readonly request: SpeechRequest; readonly response: SpeechResponse };
  readonly decide: { readonly request: DecisionRequest; readonly response: DecisionResponse };
}

/** A call of one modality with its typed request. */
export interface ModalityRequest<M extends Modality> {
  readonly modality: M;
  readonly request: ModalityShapes[M]['request'];
}

/** A call of any modality with its typed request: what an engine method hands its hooks. */
export type MediaRequest = { readonly [M in Modality]: ModalityRequest<M> }[Modality];

/** A modality's units. */
export type UnitsOf<M extends Modality> = Extract<ModelUnits, { readonly modality: M }>;

/** How the hooks read one modality's calls. */
export interface ModalityReader<M extends Modality> {
  /** Whether an answer the hooks were handed is this modality's response. */
  isResponse(response: BaseResponse): response is ModalityShapes[M]['response'];
  /** What the call used, in the modality's units. */
  units(request: ModalityShapes[M]['request'], response: ModalityShapes[M]['response'] | undefined, usage: Usage): UnitsOf<M>;
  /** Bytes sent and received, roughly: the text and media each way. */
  sizes(request: ModalityShapes[M]['request'], response: ModalityShapes[M]['response'] | undefined): { sent: number; received: number };
}

/** The bytes of an audio resource, as far as they can be told without reading a stream. */
function resourceBytes(resource: Resource): number {
  if (typeof resource === 'string') return resource.length;
  if (resource instanceof Uint8Array || resource instanceof ArrayBuffer || resource instanceof DataView) return resource.byteLength;
  if (resource instanceof Blob) return resource.size;
  return 0;
}

/** The characters of the texts an embedding request sends. */
function characters(texts: readonly string[]): number {
  return texts.reduce((sum, text) => sum + text.length, 0);
}

/** An embedding request's texts and how many images it has (aeye's one `inputs` list, or its `texts`). */
function embedParts(request: EmbeddingRequest): { texts: string[]; images: number } {
  const inputs = embeddingInputs(request);
  const texts = inputs.filter((input): input is string => !isEmbeddingImage(input));
  return { texts, images: inputs.length - texts.length };
}

/** The characters a decision call reads: its text, or its conversation's text parts. */
function inputCharacters(input: string | Message[]): number {
  if (typeof input === 'string') return input.length;
  return input.reduce((sum, message) => sum + (typeof message.content === 'string'
    ? message.content.length
    : message.content.reduce((part, content) => part + (typeof content.content === 'string' ? content.content.length : 0), 0)), 0);
}

/** The characters of a decision call's questions (their instructions, choices and levels). */
function questionCharacters(request: DecisionRequest): number {
  return JSON.stringify(request.questions).length;
}

/** The length of the first vector of an embedding response (at least 1, as `ModelUnits` asks). */
function dimensionsOf(response: EmbeddingResponse | undefined): number {
  return Math.max(1, response?.embeddings[0]?.embedding.length ?? 0);
}

/** Each modality's reader, typed by its aeye shapes: a modality without one does not compile. */
export const MODALITY_READERS: { readonly [M in Modality]: ModalityReader<M> } = {
  chat: {
    isResponse: (response): response is Response => 'content' in response && typeof response.content === 'string',
    units: (_request, _response, usage) => ({
      modality: 'chat', input: usage.text?.input ?? 0, output: usage.text?.output ?? 0,
      ...(usage.text?.cached === undefined ? {} : { cached: usage.text.cached }),
      ...(usage.reasoning?.output === undefined ? {} : { reasoning: usage.reasoning.output }),
    }),
    sizes: (request, response) => ({ sent: JSON.stringify(request.messages).length, received: response?.content.length ?? 0 }),
  },
  embed: {
    isResponse: (response): response is EmbeddingResponse => 'embeddings' in response && Array.isArray(response.embeddings),
    units: (request, response, usage) => {
      const { texts, images } = embedParts(request);
      return {
        modality: 'embed', texts: texts.length, characters: characters(texts), ...(images === 0 ? {} : { images }), dimensions: dimensionsOf(response),
        ...(usage.text?.input === undefined ? {} : { tokens: usage.text.input }),
      };
    },
    sizes: (request, response) => ({ sent: characters(embedParts(request).texts), received: (response?.embeddings.length ?? 0) * dimensionsOf(response) * 8 }),
  },
  image: {
    isResponse: (response): response is ImageGenerationResponse => 'images' in response && Array.isArray(response.images),
    units: (request, response) => ({ modality: 'image', images: response?.images.length ?? 0, ...(request.size === undefined ? {} : { size: request.size }) }),
    sizes: (request, response) => ({
      sent: request.prompt.length, received: (response?.images ?? []).reduce((sum, image) => sum + Math.floor((image.b64_json?.length ?? 0) * 0.75), 0),
    }),
  },
  transcribe: {
    isResponse: (response): response is TranscriptionResponse => 'text' in response && typeof response.text === 'string',
    units: (request, _response, usage) => ({ modality: 'transcribe', seconds: usage.audio?.seconds ?? 0, bytes: resourceBytes(request.audio) }),
    sizes: (request, response) => ({ sent: resourceBytes(request.audio), received: response?.text.length ?? 0 }),
  },
  speech: {
    isResponse: (response): response is SpeechResponse => 'audio' in response && response.audio instanceof ReadableStream,
    units: (request, _response, usage) => ({ modality: 'speech', characters: request.text.length, ...(usage.audio?.seconds === undefined ? {} : { seconds: usage.audio.seconds }) }),
    sizes: (request) => ({ sent: request.text.length, received: 0 }),
  },
  decide: {
    isResponse: (response): response is DecisionResponse => 'answers' in response && typeof response.answers === 'object' && response.answers !== null,
    units: (request, _response, usage) => ({
      modality: 'decide', questions: Object.keys(request.questions).length, characters: inputCharacters(request.input),
      ...(request.images === undefined || request.images.length === 0 ? {} : { images: request.images.length }),
      ...(usage.text?.input === undefined ? {} : { tokens: usage.text.input }),
    }),
    sizes: (request, response) => ({
      sent: inputCharacters(request.input) + questionCharacters(request) + (request.images ?? []).reduce((sum, image) => sum + resourceBytes(image), 0),
      received: response === undefined ? 0 : JSON.stringify(response.answers).length,
    }),
  },
};

/** The modality's response among what the hooks were handed, when it is one. */
function responseOf<M extends Modality>(call: ModalityRequest<M>, response: BaseResponse | undefined): ModalityShapes[M]['response'] | undefined {
  const reader: ModalityReader<M> = MODALITY_READERS[call.modality];
  return response !== undefined && reader.isResponse(response) ? response : undefined;
}

/** What a call used, in its modality's units. */
export function unitsOf<M extends Modality>(call: ModalityRequest<M>, response: BaseResponse | undefined, usage: Usage): UnitsOf<M> {
  const reader: ModalityReader<M> = MODALITY_READERS[call.modality];
  return reader.units(call.request, responseOf(call, response), usage);
}

/** Bytes sent and received, roughly (what matters for audio, images and embeddings). */
export function sizesOf<M extends Modality>(call: ModalityRequest<M>, response: BaseResponse | undefined): { sent: number; received: number } {
  const reader: ModalityReader<M> = MODALITY_READERS[call.modality];
  return reader.sizes(call.request, responseOf(call, response));
}

/** The file extension a transcription service reads an audio type by (`audio/mpeg` is `mp3`). */
export function audioExtension(mime: string): string {
  const subtype = mime.split(';', 1)[0]?.split('/')[1]?.trim() ?? '';
  switch (subtype) {
    case 'mpeg': case 'mp3': return 'mp3';
    case 'mp4': case 'x-m4a': case 'm4a': return 'm4a';
    case 'x-wav': case 'wave': return 'wav';
    case '': return 'webm';
    default: return subtype;
  }
}

/** Recorded audio as a named file, so the service can tell its format (raw bytes carry no name). */
export function audioFile(audio: Uint8Array, mime: string): File {
  return new File([new Uint8Array(audio)], `audio.${audioExtension(mime)}`, { type: mime });
}

/** The mime type of an audio format a speech model answers in. */
export function audioMime(format: string | undefined): string {
  switch (format) {
    case 'wav': return 'audio/wav';
    case 'ogg': case 'opus': return 'audio/ogg';
    case 'aac': return 'audio/aac';
    case undefined: return 'audio/mpeg';
    case 'flac': return 'audio/flac';
    default: return 'audio/mpeg';
  }
}
