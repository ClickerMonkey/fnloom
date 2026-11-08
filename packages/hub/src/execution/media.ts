/**
 * Model calls other than chat, as the hub AI makes them: what each engine call takes and gives (`EmbedCall`, …),
 * and how the hub AI's hooks read any aeye request and response into a `ModelCall`: its modality, the units it used
 * (`unitsOf`) and how many bytes went each way (`sizesOf`). One place knows each request shape, so a new modality
 * fails to compile until it is read here.
 */
import type { BaseRequest, BaseResponse, Usage } from '@aeye/core';
import type { Modality, ModelUnits } from '@harness/core';
import type { HubCallMetadata } from './scope.ts';

/** Embeddings of some texts. */
export interface EmbedCall {
  readonly texts: readonly string[];
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
  readonly format?: 'mp3' | 'wav' | 'ogg' | undefined;
}

/** Audio a model spoke. */
export interface Spoken {
  readonly audio: Uint8Array;
  readonly mime: string;
}

/** Whether a field of a request or response is an array (the shapes are told apart by their fields). */
function arrayField(value: object, key: string): unknown[] | undefined {
  const field: unknown = Reflect.get(value, key);
  return Array.isArray(field) ? field : undefined;
}

/** A string field. */
function stringField(value: object, key: string): string | undefined {
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'string' ? field : undefined;
}

/** A field's byte size, when it is bytes. */
function bytesField(value: object, key: string): number {
  const field: unknown = Reflect.get(value, key);
  if (field instanceof Uint8Array) return field.byteLength;
  if (field instanceof ArrayBuffer) return field.byteLength;
  if (field instanceof Blob) return field.size;
  return typeof field === 'string' ? field.length : 0;
}

/** What an aeye request does, read from its fields. */
export function modalityOf(request: BaseRequest): Modality {
  if (arrayField(request, 'messages') !== undefined) return 'chat';
  if (arrayField(request, 'texts') !== undefined) return 'embed';
  if (Reflect.get(request, 'audio') !== undefined) return 'transcribe';
  if (stringField(request, 'text') !== undefined) return 'speech';
  return 'image';
}

/** The characters of all texts an embedding request sends. */
function textsOf(request: BaseRequest): string[] {
  return (arrayField(request, 'texts') ?? []).filter((text): text is string => typeof text === 'string');
}

/** The length of the first vector an embedding response holds (at least 1, as `ModelUnits` asks). */
function dimensionsOf(response: BaseResponse | undefined): number {
  const first: unknown = response === undefined ? undefined : arrayField(response, 'embeddings')?.[0];
  const vector: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'embedding') : undefined;
  return Array.isArray(vector) && vector.length > 0 ? vector.length : 1;
}

/** What a call used, in its modality's units. */
export function unitsOf(modality: Modality, request: BaseRequest, response: BaseResponse | undefined, usage: Usage): ModelUnits {
  switch (modality) {
    case 'chat': return {
      modality, input: usage.text?.input ?? 0, output: usage.text?.output ?? 0,
      ...(usage.text?.cached === undefined ? {} : { cached: usage.text.cached }),
      ...(usage.reasoning?.output === undefined ? {} : { reasoning: usage.reasoning.output }),
    };
    case 'embed': {
      const texts = textsOf(request);
      return {
        modality, texts: texts.length, characters: texts.reduce((sum, text) => sum + text.length, 0), dimensions: dimensionsOf(response),
        ...(usage.text?.input === undefined ? {} : { tokens: usage.text.input }),
      };
    }
    case 'image': {
      const size = stringField(request, 'size');
      return { modality, images: response === undefined ? 0 : (arrayField(response, 'images')?.length ?? 0), ...(size === undefined ? {} : { size }) };
    }
    case 'transcribe': return { modality, seconds: usage.audio?.seconds ?? 0, bytes: bytesField(request, 'audio') };
    case 'speech': return {
      modality, characters: stringField(request, 'text')?.length ?? 0, ...(usage.audio?.seconds === undefined ? {} : { seconds: usage.audio.seconds }),
    };
  }
}

/** Bytes sent and received, roughly: the text and media each way (what matters for audio, images and embeddings). */
export function sizesOf(modality: Modality, request: BaseRequest, response: BaseResponse | undefined): { sent: number; received: number } {
  switch (modality) {
    case 'chat': return { sent: JSON.stringify(arrayField(request, 'messages') ?? []).length, received: response === undefined ? 0 : (stringField(response, 'content')?.length ?? 0) };
    case 'embed': {
      const vectors = response === undefined ? 0 : (arrayField(response, 'embeddings')?.length ?? 0);
      return { sent: textsOf(request).reduce((sum, text) => sum + text.length, 0), received: vectors * dimensionsOf(response) * 8 };
    }
    case 'image': {
      const images = response === undefined ? [] : (arrayField(response, 'images') ?? []);
      const received = images.reduce<number>((sum, image) => sum + (typeof image === 'object' && image !== null ? Math.floor((stringField(image, 'b64_json')?.length ?? 0) * 0.75) : 0), 0);
      return { sent: stringField(request, 'prompt')?.length ?? 0, received };
    }
    case 'transcribe': return { sent: bytesField(request, 'audio'), received: response === undefined ? 0 : (stringField(response, 'text')?.length ?? 0) };
    case 'speech': return { sent: stringField(request, 'text')?.length ?? 0, received: 0 };
  }
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
