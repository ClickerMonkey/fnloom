/**
 * The hub's side of the LLM wire. The mapping between aeye's in-memory LLM shapes and their JSON projections in core
 * is `@harness/sdk/server`'s, shared with systems; this module adds what only the hub needs: tool names for fns, the
 * text of a tool reply, token totals, and the lenient mapping it saves transcripts and interactions with.
 */
import type { Message, Request } from '@aeye/core';
import type { Json, LlmMessage, LlmRequest, LlmUsage, QualifiedName } from '@harness/core';
import { LlmWire } from '@harness/sdk/server';

export {
  chunkFromWire, chunkToWire, descriptorsOf, isObjectSchema, messageFromWire, requestFromWire, responseToWire, usageToWire,
} from '@harness/sdk/server';

/**
 * A fn's name as an LLM tool name. Providers allow only letters, digits, `_` and `-` (at most 64), so `/` becomes
 * `__` and `.` (methods) becomes `--`. The prompt keeps a map back to the fn, so the encoding never needs reversing.
 */
export function toolName(fn: QualifiedName): string {
  return fn.replaceAll('/', '__').replaceAll('.', '--').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/**
 * What the hub saves: a record never fails over something the wire can't carry; the part is kept as a placeholder
 * (a schema part JSON schema can't express as `{}`, a streamed part as `[binary content]`).
 */
const recorded = new LlmWire({ unrepresentable: 'placeholder' });

/** An aeye message as it is saved. Provider caches and reasoning details stay behind. */
export function messageToWire(message: Message): LlmMessage {
  return recorded.message(message);
}

/** An aeye request as it is saved with its interaction. */
export function requestToWire(request: Request): LlmRequest {
  return recorded.request(request);
}

/** The text of a tool reply the model reads: strings as they are, anything else as JSON (as aeye writes them). */
export function replyText(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The tokens a call used, for the ledger. */
export function tokensOf(usage: LlmUsage): number {
  return usage.input + usage.output + (usage.reasoning ?? 0);
}
