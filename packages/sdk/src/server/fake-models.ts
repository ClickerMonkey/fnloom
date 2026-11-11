/**
 * A model link in memory for tests: `ctx.ai()` and `hubAi()` give the same `HarnessAi` type over it, so a system's
 * aeye prompts, tools and agents run in a unit test with scripted answers and no hub.
 */
import { mintId, type HubModelInfo, type LlmForward, type LlmForwardChunk, type ModelForward, type ModelForwardResult } from '@harness/core';
import type { ContentTransfer } from './content.ts';
import { hubAiOf, type HarnessAi, type ModelLink } from './llm.ts';

/** What a fake answers one chat forward with: the text of the reply, or the chunks themselves. */
export type FakeReply = string | readonly LlmForwardChunk[];

/** How a `FakeModelLink` behaves. */
export interface FakeModelOptions {
  /** The models it lists (default none: calls go to `hub/auto`). */
  readonly models?: readonly HubModelInfo[];
  /** The reply to each chat forward (default the text `ok`). */
  readonly reply?: (forward: LlmForward) => FakeReply;
  /** The answer to each non-chat call (default: embeddings of each text's length; other modalities refused). */
  readonly model?: (forward: ModelForward) => ModelForwardResult;
}

/** Items as an async stream, one at a time (a scripted hub's answer). */
export async function* streamOf<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) { yield await Promise.resolve(item); }
}

/** The chunks of a plain text reply, with a free `done`. */
export function replyChunks(text: string): LlmForwardChunk[] {
  return [
    { type: 'chunk', chunk: { content: text } },
    { type: 'chunk', chunk: { finishReason: 'stop' } },
    { type: 'done', usage: { input: 1, output: 1 }, cost: 0, interaction: mintId('llmInteraction'), model: 'fake/model' },
  ];
}

/** Embeddings of each text's length. */
function embedLengths(forward: ModelForward): ModelForwardResult {
  if (forward.modality !== 'embed') { throw new Error(`The fake model link has no ${forward.modality} answer; give it one with \`model\`.`); }
  return { modality: 'embed', vectors: forward.texts.map((text) => [text.length]), call: mintId('modelCall'), cost: 0, model: 'fake/embed' };
}

/** A `ModelLink` answering from scripts, recording what it was sent. */
export class FakeModelLink implements ModelLink {
  /** Every chat forward, in order. */
  readonly forwards: LlmForward[] = [];
  /** Every non-chat call, in order. */
  readonly calls: ModelForward[] = [];
  readonly #options: FakeModelOptions;

  constructor(options: FakeModelOptions = {}) {
    this.#options = options;
  }

  llm(forward: LlmForward): AsyncIterable<LlmForwardChunk> {
    this.forwards.push(forward);
    const reply = this.#options.reply?.(forward) ?? 'ok';
    return streamOf(typeof reply === 'string' ? replyChunks(reply) : reply);
  }

  model(forward: ModelForward): Promise<ModelForwardResult> {
    this.calls.push(forward);
    return Promise.resolve((this.#options.model ?? embedLengths)(forward));
  }

  models(): Promise<HubModelInfo[]> {
    return Promise.resolve([...(this.#options.models ?? [])]);
  }

  connected(): boolean {
    return true;
  }
}

/**
 * A `HarnessAi` (the type `ctx.ai()` returns) over a `FakeModelLink`: pass the link to read what was forwarded, or
 * options to make one. `content` moves images and audio when a test needs them.
 */
export function fakeHubAi(link: FakeModelLink | FakeModelOptions = {}, content?: ContentTransfer): Promise<HarnessAi> {
  const fake = link instanceof FakeModelLink ? link : new FakeModelLink(link);
  return hubAiOf({ hub: fake, ...(content === undefined ? {} : { content }) });
}
