import type { EmbeddingRequest, ImageGenerationRequest, ImageGenerationResponse, SpeechRequest, TranscriptionRequest } from '@aeye/ai';
import type { Request } from '@aeye/core';
import { describe, expect, it } from 'vitest';
import { audioExtension, audioFile, audioMime, modalityOf, sizesOf, unitsOf } from './media.ts';

const chat: Request = { messages: [{ role: 'user', content: 'hi' }] };
const embed: EmbeddingRequest = { texts: ['ab', 'cde'] };
const image: ImageGenerationRequest = { prompt: 'a cat', size: '512x512' };
const heard: TranscriptionRequest = { audio: new Uint8Array(40) };
const said: SpeechRequest = { text: 'hello' };

describe('reading model calls', () => {
  it('tells each modality by the request’s fields', () => {
    expect([chat, embed, image, heard, said].map(modalityOf)).toEqual(['chat', 'embed', 'image', 'transcribe', 'speech']);
  });

  it('measures each in its own units', () => {
    expect(unitsOf('chat', chat, undefined, { text: { input: 5, output: 2, cached: 1 }, reasoning: { output: 3 } })).toEqual({ modality: 'chat', input: 5, output: 2, cached: 1, reasoning: 3 });
    expect(unitsOf('embed', embed, undefined, {})).toEqual({ modality: 'embed', texts: 2, characters: 5, dimensions: 1 });
    const made: ImageGenerationResponse = { images: [{ b64_json: 'AAAA' }, { url: 'https://x' }], model: 'i' };
    expect(unitsOf('image', image, made, {})).toEqual({ modality: 'image', images: 2, size: '512x512' });
    expect(unitsOf('transcribe', heard, undefined, { audio: { seconds: 2.5 } })).toEqual({ modality: 'transcribe', seconds: 2.5, bytes: 40 });
    expect(unitsOf('speech', said, undefined, {})).toEqual({ modality: 'speech', characters: 5 });
  });

  it('counts the bytes each way that matter for its speed', () => {
    const made: ImageGenerationResponse = { images: [{ b64_json: 'AAAAAAAA' }], model: 'i' };
    expect(sizesOf('image', image, made)).toEqual({ sent: 5, received: 6 });
    const recorded: TranscriptionRequest = { audio: audioFile(new Uint8Array(12), 'audio/webm') };
    expect(sizesOf('transcribe', recorded, undefined)).toEqual({ sent: 12, received: 0 });
    expect(sizesOf('embed', embed, undefined)).toEqual({ sent: 5, received: 0 });
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
