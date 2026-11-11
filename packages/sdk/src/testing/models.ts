/**
 * Models for a system's tests: scripted replies (`mockModel([...])`), replies recorded once from a real model and
 * replayed after (`mockModel({ recording })`), and a real free model for a few marked tests (`realModel`), skipped
 * without a key. Each is a `ModelLink`, so it drives `ctx.ai()` in a `testHub` and `hubAiOf` alike.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LlmForwardChunk, mintId, type HubModelInfo, type LlmForward, type ModelForward, type ModelForwardResult } from '@harness/core';
import { it, type TestContext } from 'vitest';
import { z } from 'zod';
import { FakeModelLink, replyChunks, streamOf, type FakeReply } from '../server/fake-models.ts';
import { liveEnv, liveModels } from '../server/live.ts';
import type { ModelLink } from '../server/llm.ts';
import { OpenRouterModelLink } from './openrouter.ts';

declare module 'vitest' {
  interface TaskMeta {
    /** The test calls a real model (`realModel.it`); `harness test` reports it as `real`. */
    real?: boolean;
  }
}

/** A reply that calls one tool with `args`. */
export function toolCall(name: string, args: object): LlmForwardChunk[] {
  return [
    { type: 'chunk', chunk: { toolCall: { id: mintId('llmInteraction'), name, arguments: JSON.stringify(args) } } },
    { type: 'chunk', chunk: { finishReason: 'tool_calls' } },
    { type: 'done', usage: { input: 1, output: 1 }, cost: 0, interaction: mintId('llmInteraction'), model: 'fake/model' },
  ];
}

/** A scripted reply: the text, the chunks (`toolCall(...)`), or worked out from what was sent. */
export type ScriptStep = FakeReply | ((forward: LlmForward) => FakeReply);

/** A recording of a real model's replies, one per chat forward, in order. */
export const ModelRecording = z.object({ replies: z.array(z.array(LlmForwardChunk)) });
export type ModelRecording = z.infer<typeof ModelRecording>;

/** How `mockModel` answers when given a recording. */
export interface RecordingOptions {
  /** The JSON file of the recording. */
  readonly recording: string;
  /** The real model to record from when the file is missing or short (default `realModel.link()`). */
  readonly live?: ModelLink | undefined;
  /** The models it lists. */
  readonly models?: readonly HubModelInfo[];
}

/** A model link that replays a recording, recording from a real model what the file doesn't have yet. */
export class RecordedModelLink implements ModelLink {
  /** Every chat forward, in order. */
  readonly forwards: LlmForward[] = [];
  readonly #options: RecordingOptions;
  #replies: LlmForwardChunk[][] | undefined;

  constructor(options: RecordingOptions) {
    this.#options = options;
  }

  async *llm(forward: LlmForward, signal?: AbortSignal): AsyncGenerator<LlmForwardChunk> {
    const index = this.forwards.push(forward) - 1;
    const replies = this.#replies ??= await this.#load();
    const kept = replies[index];
    if (kept !== undefined) {
      yield* streamOf(kept);
      return;
    }
    const live = this.#options.live;
    if (live === undefined) {
      throw new Error(`${this.#options.recording} has ${replies.length} replies and no real model to record reply ${index + 1} from (set OPENROUTER_API_KEY).`);
    }
    const chunks: LlmForwardChunk[] = [];
    for await (const chunk of live.llm(forward, signal)) {
      chunks.push(chunk);
      yield chunk;
    }
    replies[index] = chunks;
    await mkdir(dirname(this.#options.recording), { recursive: true });
    await writeFile(this.#options.recording, `${JSON.stringify({ replies } satisfies ModelRecording, null, 2)}\n`);
  }

  model(forward: ModelForward, signal?: AbortSignal): Promise<ModelForwardResult> {
    return this.#options.live?.model(forward, signal) ?? Promise.reject(new Error(`A recording replays chat only, not ${forward.modality}.`));
  }

  models(): Promise<HubModelInfo[]> {
    return Promise.resolve([...(this.#options.models ?? [])]);
  }

  connected(): boolean {
    return true;
  }

  async #load(): Promise<LlmForwardChunk[][]> {
    const text = await readFile(this.#options.recording, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return undefined; }
      throw error;
    });
    return text === undefined ? [] : ModelRecording.parse(JSON.parse(text)).replies;
  }
}

/**
 * A model for fast unit tests. Given steps, it answers each chat forward with the next step (then `done` once they
 * run out); given a recording, it replays it, recording first from a real model when the file is missing.
 *
 * ```ts
 * const model = mockModel([toolCall('search', { text: 'notes' }), 'Saved notes/by_tag.']);
 * const kit = await testHub(notes, impl, { model });
 * ```
 */
export function mockModel(steps: readonly ScriptStep[], options?: { models?: readonly HubModelInfo[] }): FakeModelLink;
export function mockModel(recording: RecordingOptions): RecordedModelLink;
export function mockModel(input: readonly ScriptStep[] | RecordingOptions, options: { models?: readonly HubModelInfo[] } = {}): FakeModelLink | RecordedModelLink {
  if (!isSteps(input)) { return new RecordedModelLink({ ...input, live: 'live' in input ? input.live : realModel.link() }); }
  const queue = [...input];
  return new FakeModelLink({
    ...(options.models === undefined ? {} : { models: options.models }),
    reply: (forward) => {
      const step = queue.shift();
      if (step === undefined) { return replyChunks('done'); }
      return typeof step === 'function' ? step(forward) : step;
    },
  });
}

function isSteps(input: readonly ScriptStep[] | RecordingOptions): input is readonly ScriptStep[] {
  return Array.isArray(input);
}

/** A test body that gets the real model. */
export type RealModelTest = (model: OpenRouterModelLink, context: TestContext) => Promise<void> | void;

/**
 * A real free model (OpenRouter, `OPENROUTER_API_KEY`; the models of `HARNESS_LIVE_MODEL` and
 * `HARNESS_LIVE_FALLBACKS`). `realModel.it` declares a test that calls it: marked `real`, skipped without a key.
 */
export const realModel = {
  /** The real model link, or undefined without a key. */
  link(): OpenRouterModelLink | undefined {
    const key = liveEnv.get('OPENROUTER_API_KEY');
    return key === undefined || key === '' ? undefined : new OpenRouterModelLink({ key, models: liveModels() });
  },
  /** Whether real-model tests run here (a key is set). */
  available(): boolean {
    const key = liveEnv.get('OPENROUTER_API_KEY');
    return key !== undefined && key !== '';
  },
  /** A test that calls a real model: skipped without a key, marked `real`, two minutes long by default. */
  it(name: string, body: RealModelTest, timeout = 120_000): void {
    const link = realModel.link();
    it(name, { meta: { real: true }, skip: link === undefined, timeout }, async (context) => {
      if (link === undefined) { context.skip('No OPENROUTER_API_KEY.'); return; }
      await body(link, context);
    });
  },
};
