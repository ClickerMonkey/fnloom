import type { EmbeddingRequest, EmbeddingResponse, ImageGenerationRequest, ImageGenerationResponse, SpeechRequest, TranscriptionRequest, TranscriptionResponse } from '@aeye/ai';
import type { Request, Response } from '@aeye/core';
import { MODALITIES } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { audioExtension, audioFile, audioMime, MODALITY_READERS, sizesOf, unitsOf } from './media.ts';

const chat: Request = { messages: [{ role: 'user', content: 'hi' }] };
const embed: EmbeddingRequest = { texts: ['ab', 'cde'] };
const image: ImageGenerationRequest = { prompt: 'a cat', size: '512x512' };
const heard: TranscriptionRequest = { audio: new Uint8Array(40) };
const said: SpeechRequest = { text: 'hello' };

describe('reading model calls', () => {
  it('has a reader for every modality, each telling only its own responses', () => {
    expect(Object.keys(MODALITY_READERS).sort()).toEqual([...MODALITIES].sort());
    const answered: Response = { content: 'hi', finishReason: 'stop', model: 'm' };
    const vectors: EmbeddingResponse = { embeddings: [{ embedding: [1, 2, 3], index: 0 }], model: 'e' };
    const text: TranscriptionResponse = { text: 'hello', model: 't' };
    expect(MODALITY_READERS.chat.isResponse(answered)).toBe(true);
    expect(MODALITY_READERS.embed.isResponse(answered)).toBe(false);
    expect(MODALITY_READERS.embed.isResponse(vectors)).toBe(true);
    expect(MODALITY_READERS.image.isResponse(vectors)).toBe(false);
    expect(MODALITY_READERS.transcribe.isResponse(text)).toBe(true);
    expect(MODALITY_READERS.speech.isResponse(text)).toBe(false);
  });

  it('measures each in its own units, from the typed request the engine made', () => {
    expect(unitsOf({ modality: 'chat', request: chat }, undefined, { text: { input: 5, output: 2, cached: 1 }, reasoning: { output: 3 } })).toEqual({ modality: 'chat', input: 5, output: 2, cached: 1, reasoning: 3 });
    expect(unitsOf({ modality: 'embed', request: embed }, undefined, {})).toEqual({ modality: 'embed', texts: 2, characters: 5, dimensions: 1 });
    const vectors: EmbeddingResponse = { embeddings: [{ embedding: [1, 2, 3], index: 0 }, { embedding: [4, 5, 6], index: 1 }], model: 'e' };
    expect(unitsOf({ modality: 'embed', request: embed }, vectors, { text: { input: 4 } })).toEqual({ modality: 'embed', texts: 2, characters: 5, dimensions: 3, tokens: 4 });
    const made: ImageGenerationResponse = { images: [{ b64_json: 'AAAA' }, { url: 'https://x' }], model: 'i' };
    expect(unitsOf({ modality: 'image', request: image }, made, {})).toEqual({ modality: 'image', images: 2, size: '512x512' });
    expect(unitsOf({ modality: 'transcribe', request: heard }, undefined, { audio: { seconds: 2.5 } })).toEqual({ modality: 'transcribe', seconds: 2.5, bytes: 40 });
    expect(unitsOf({ modality: 'speech', request: said }, undefined, {})).toEqual({ modality: 'speech', characters: 5 });
    // another modality's answer is not read as this one's
    expect(unitsOf({ modality: 'image', request: image }, vectors, {})).toEqual({ modality: 'image', images: 0, size: '512x512' });
  });

  it('counts the bytes each way that matter for its speed', () => {
    const made: ImageGenerationResponse = { images: [{ b64_json: 'AAAAAAAA' }], model: 'i' };
    expect(sizesOf({ modality: 'image', request: image }, made)).toEqual({ sent: 5, received: 6 });
    const recorded: TranscriptionRequest = { audio: audioFile(new Uint8Array(12), 'audio/webm') };
    const text: TranscriptionResponse = { text: 'abc', model: 't' };
    expect(sizesOf({ modality: 'transcribe', request: recorded }, text)).toEqual({ sent: 12, received: 3 });
    expect(sizesOf({ modality: 'embed', request: embed }, undefined)).toEqual({ sent: 5, received: 0 });
    const answered: Response = { content: 'hello', finishReason: 'stop', model: 'm' };
    expect(sizesOf({ modality: 'chat', request: chat }, answered)).toEqual({ sent: JSON.stringify(chat.messages).length, received: 5 });
    expect(sizesOf({ modality: 'speech', request: said }, undefined)).toEqual({ sent: 5, received: 0 });
  });
});

describe('audio', () => {
  it('names a recording by its type so the service can read it', () => {
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('audio/mpeg')).toBe('mp3');
    expect(audioExtension('audio/x-wav')).toBe('wav');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    const file = audioFile(new Uint8Array(3), 'audio/ogg');
    expect([file.name, file.type, file.size]).toEqual(['audio.ogg', 'audio/ogg', 3]);
  });

  it('types the speech a model answers by its format', () => {
    expect([audioMime('wav'), audioMime('opus'), audioMime(undefined), audioMime('mp3')]).toEqual(['audio/wav', 'audio/ogg', 'audio/mpeg', 'audio/mpeg']);
  });
});
