/**
 * Token estimates, the one place the hub turns text into tokens. An estimate is `ceil(chars / charsPerToken)`, plus
 * four tokens of framing per message, times the model's calibration ratio: measured input tokens over estimated, a
 * moving average (rate 0.2) clamped to 0.7–1.6 and starting at 1.1, so estimates err high until a model has been
 * measured. Selection never tokenizes: everything it weighs is a length over characters per token.
 */
import type { ModelTokenizer } from '@aeye/ai';
import type { ContextDecl, ContextTokens, LlmMessage, LlmToolSpec, ResolvedModelLimits } from '@harness/core';
import type { TokenEstimator } from './index.ts';

/** Tokens of role and framing each message costs on top of its text. */
export const MESSAGE_FRAMING = 4;

/** Characters per token when nothing better is known (GPT-like tokenizers). */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/** Characters per token by tokenizer family, for models whose limits don't say. */
export const TOKENIZER_CHARS: Readonly<Partial<Record<ModelTokenizer, number>>> = {
  GPT: 4, Claude: 3.8, Gemini: 4, Gemma: 3.8, Mistral: 3.6, Llama2: 3.6, Llama3: 3.5, Llama4: 3.5, Qwen: 3.5, Qwen3: 3.5, DeepSeek: 3.5, Cohere: 4,
};

/** What a non-text content part (an image, a file, audio) is assumed to cost. */
export const MEDIA_PART_TOKENS = 1_000;

/** How the calibration ratio moves: its start, the moving average's rate, and its clamp. */
export const CALIBRATION = { start: 1.1, rate: 0.2, min: 0.7, max: 1.6 } as const;

/** Tokens of a length of text, before calibration. */
export function rawTokens(chars: number, charsPerToken: number): number {
  return Math.ceil(chars / charsPerToken);
}

/** The characters a message carries: its text (or its parts), its tool calls' names and arguments. */
export function messageChars(message: LlmMessage): { chars: number; media: number } {
  let chars = 0;
  let media = 0;
  if (typeof message.content === 'string') chars += message.content.length;
  else for (const part of message.content) { if (part.type === 'text') chars += part.content.length; else media += 1; }
  for (const call of message.toolCalls ?? []) chars += call.name.length + call.arguments.length;
  return { chars, media };
}

/** The characters a native tool definition is sent as: its name, description and JSON schema. */
export function toolChars(tool: LlmToolSpec): number {
  return tool.name.length + (tool.description?.length ?? 0) + JSON.stringify(tool.parameters).length;
}

/**
 * The next calibration ratio after one call: the estimate was made with `ratio`, so the uncalibrated estimate was
 * `estimated / ratio`, and the ratio moves toward `actual` over that.
 */
export function nextRatio(ratio: number, estimated: number, actual: number): number {
  if (estimated <= 0 || actual <= 0) return ratio;
  const observed = (ratio * actual) / estimated;
  return Math.min(CALIBRATION.max, Math.max(CALIBRATION.min, ratio + CALIBRATION.rate * (observed - ratio)));
}

/** The sizes kept on a context record (`ContextRecord.tokens`), at the default characters per token. Dynamic context has no full size until loaded. */
export function contextTokens(decl: Pick<ContextDecl, 'content' | 'summary' | 'description'>): ContextTokens {
  return { full: rawTokens(decl.content?.length ?? 0, DEFAULT_CHARS_PER_TOKEN), summary: rawTokens((decl.summary ?? decl.description).length, DEFAULT_CHARS_PER_TOKEN) };
}

/** Estimates for one model, at its characters per token and calibration ratio. */
export class Estimator implements TokenEstimator {
  readonly model: string;
  readonly limits: ResolvedModelLimits;
  readonly ratio: number;

  constructor(model: string, limits: ResolvedModelLimits, ratio: number) {
    this.model = model;
    this.limits = limits;
    this.ratio = ratio;
  }

  text(text: string): number {
    return this.#calibrated(rawTokens(text.length, this.limits.charsPerToken));
  }

  message(message: LlmMessage): number {
    const { chars, media } = messageChars(message);
    return this.#calibrated(rawTokens(chars, this.limits.charsPerToken) + media * MEDIA_PART_TOKENS + MESSAGE_FRAMING);
  }

  tool(tool: LlmToolSpec): number {
    return this.#calibrated(rawTokens(toolChars(tool), this.limits.charsPerToken) + MESSAGE_FRAMING);
  }

  /** The sum of several messages. */
  messages(messages: readonly LlmMessage[]): number {
    return messages.reduce((sum, message) => sum + this.message(message), 0);
  }

  #calibrated(raw: number): number {
    return Math.ceil(raw * this.ratio);
  }
}
