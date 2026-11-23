import { LlmInteractionId, ModelCallId, RunId, type LlmForward, type LlmForwardChunk, type ModelForward, type ModelRole } from '@harness/core';
import { describe, expect, it } from 'vitest';
import type { ModelSite } from '../models/index.ts';
import { HubFormModels, imageQuestion, NO_IMAGE_MODEL, VISION_PROMPTS } from './models.ts';
import { ALICE, bytes } from './testing.ts';

const png = { raw: { hash: 'a'.repeat(64), size: 4, mime: 'image/png' }, bytes: new Uint8Array([1, 2, 3, 4]), name: 'cat.png' };
const wav = { raw: { hash: 'b'.repeat(64), size: 4, mime: 'audio/wav' }, bytes: bytes('RIFF'), name: 'talk.wav' };
const who = { actor: ALICE, run: RunId.parse('run_1') };

function rig(roles: Partial<Record<ModelRole, string>>, chunks: LlmForwardChunk[] = []) {
  const forwarded: Array<LlmForward & { system: string }> = [];
  const heard: Array<{ request: ModelForward; site: ModelSite }> = [];
  const models = new HubFormModels({
    roles: () => ({ resolve: (role) => Promise.resolve(roles[role] === undefined ? undefined : { model: roles[role], provider: 'openrouter' }) }),
    llm: () => ({
      forward: async function* (input) {
        forwarded.push(input);
        await Promise.resolve();
        yield* chunks;
      },
    }),
    gateway: () => ({
      forward: (request, site) => {
        heard.push({ request, site });
        return Promise.resolve({ modality: 'transcribe', text: ' hello there ', call: ModelCallId.parse('mdl_1'), cost: 0.01, model: 'whisper' });
      },
    }),
  });
  return { models, forwarded, heard };
}

describe('forms made by models', () => {
  it('describes an image with the describe role\'s model, the image sent inline', async () => {
    const r = rig({ describe: 'vision-1' }, [
      { type: 'chunk', chunk: { content: 'A cat ' } }, { type: 'chunk', chunk: { content: 'on a mat.' } },
      { type: 'done', usage: { input: 10, output: 5 }, cost: 0.001, interaction: LlmInteractionId.parse('llm_1'), model: 'vision-1:served' },
    ]);
    expect(await r.models.model('description')).toBe('vision-1');
    const made = await r.models.make('description', png, who);
    expect(made).toEqual({ text: 'A cat on a mat.', model: 'vision-1:served' });
    const [sent] = r.forwarded;
    expect(sent).toMatchObject({ system: 'hub', model: { model: 'vision-1' }, run: 'run_1', stream: false });
    const content = sent?.request.messages[0]?.content;
    expect(Array.isArray(content) ? content.map((part) => part.type) : content).toEqual(['text', 'image']);
    expect(Array.isArray(content) ? content[0]?.content : '').toBe(VISION_PROMPTS.description);
    expect(Array.isArray(content) ? content[1]?.content.startsWith('data:image/png;base64,') : false).toBe(true);
  });

  it('transcribes a recording with the transcribe role, recording the call', async () => {
    const r = rig({ transcribe: 'whisper' });
    expect(await r.models.make('transcript', wav, who)).toEqual({ text: 'hello there', model: 'whisper', call: 'mdl_1' });
    expect(r.heard[0]?.request).toMatchObject({ modality: 'transcribe', audio: wav.raw, model: { model: 'whisper' }, run: 'run_1' });
    expect(r.heard[0]?.site).toEqual({ purpose: 'form:transcript', run: 'run_1' });
  });

  it('refuses when the role is off, the content is the wrong kind, or the model fails', async () => {
    const off = rig({});
    expect(await off.models.model('ocr')).toBeUndefined();
    await expect(off.models.make('ocr', png, who)).rejects.toMatchObject({ status: 409 });
    const on = rig({ ocr: 'vision-1', transcribe: 'whisper' }, [{ type: 'error', message: 'overloaded', kind: 'provider' }]);
    await expect(on.models.make('ocr', wav, who)).rejects.toMatchObject({ status: 422 });
    await expect(on.models.make('transcript', png, who)).rejects.toMatchObject({ status: 422 });
    await expect(on.models.make('ocr', png, who)).rejects.toMatchObject({ status: 502 });
    await expect(on.models.make('ocr', png, who)).rejects.toThrow('overloaded');
    await expect(on.models.make('thumbnail', png, who)).rejects.toMatchObject({ status: 422 });
    expect(await on.models.model('thumbnail')).toBeUndefined();
  });
});

describe('questions about an image for a model that can\'t see it', () => {
  it('sends the image and the question to the describe role\'s model, charged to the run', async () => {
    const r = rig({ describe: 'vision-1' }, [
      { type: 'chunk', chunk: { content: 'It says OPEN.' } },
      { type: 'done', usage: { input: 10, output: 4 }, cost: 0.001, interaction: LlmInteractionId.parse('llm_2'), model: 'vision-1' },
    ]);
    expect(await r.models.ask('What does the sign say?', png, who)).toEqual({ text: 'It says OPEN.', model: 'vision-1' });
    const [sent] = r.forwarded;
    expect(sent).toMatchObject({ system: 'hub', model: { model: 'vision-1' }, run: 'run_1' });
    const content = sent?.request.messages[0]?.content;
    expect(Array.isArray(content) ? content.map((part) => part.type) : content).toEqual(['text', 'image']);
    expect(Array.isArray(content) ? content[0]?.content : '').toBe(imageQuestion('What does the sign say?'));
    expect(imageQuestion('What does the sign say?')).toContain('Question: What does the sign say?');
  });

  it('is refused plainly when no image model is set up, and for what isn\'t an image', async () => {
    const off = rig({ ocr: 'vision-1' });
    await expect(off.models.ask('What is it?', png, who)).rejects.toMatchObject({ status: 409, code: NO_IMAGE_MODEL });
    await expect(off.models.ask('What is it?', png, who)).rejects.toThrow('no image model is set up');
    expect(off.forwarded).toHaveLength(0);
    await expect(rig({ describe: 'vision-1' }).models.ask('What is it?', wav, who)).rejects.toMatchObject({ status: 422 });
  });
});
