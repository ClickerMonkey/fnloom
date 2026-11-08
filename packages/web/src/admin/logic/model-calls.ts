/**
 * Model calls as the admin pages show them: each modality's words and icon, each status's look, what a call used in
 * its own units ("1,840 in, 212 out", "14.2s of audio", "12 texts"), what it was for (a run's fn, or the hub's own
 * purpose), and its sizes. Pure, so it is tested alone.
 */
import type { Modality, ModelCall, ModelCallStatus, ModelUnits } from '@harness/core';
import { formatBytes, formatDuration, formatTokens } from '../../chat/logic/format.ts';
import type { IconName } from '../../ui/index.ts';
import type { StatusLook } from './systems.ts';

/** Each modality's words and icon. */
export const MODALITY_WORDS = {
  chat: { label: 'Chat', icon: 'chat' },
  embed: { label: 'Embeddings', icon: 'braces' },
  image: { label: 'Images', icon: 'image' },
  transcribe: { label: 'Transcription', icon: 'mic' },
  speech: { label: 'Speech', icon: 'music' },
} as const satisfies Record<Modality, { label: string; icon: IconName }>;

/** Each model call status's look. */
export const MODEL_CALL_STATUS_LOOK = {
  running: { tone: 'accent', word: 'Running', live: true },
  done: { tone: 'ok', word: 'Done', live: false },
  failed: { tone: 'danger', word: 'Failed', live: false },
  aborted: { tone: 'neutral', word: 'Stopped', live: false },
} as const satisfies Record<ModelCallStatus, StatusLook>;

/** What a call used, in its modality's units. */
export function unitsText(units: ModelUnits): string {
  switch (units.modality) {
    case 'chat': return `${formatTokens(units.input)} in, ${formatTokens(units.output)} out${units.reasoning ? `, ${formatTokens(units.reasoning)} reasoning` : ''}`;
    case 'embed': return `${units.texts} ${units.texts === 1 ? 'text' : 'texts'}, ${formatTokens(units.tokens ?? Math.round(units.characters / 4))} tokens, ${units.dimensions} dims`;
    case 'image': return `${units.images} ${units.images === 1 ? 'image' : 'images'}${units.size === undefined ? '' : ` at ${units.size}`}`;
    case 'transcribe': return `${formatDuration(units.seconds * 1_000)} of audio`;
    case 'speech': return `${units.characters.toLocaleString()} characters${units.seconds === undefined ? '' : `, ${formatDuration(units.seconds * 1_000)} spoken`}`;
  }
}

/** What a call was for: the fn whose run made it, the system that asked, or the hub's own purpose. */
export function callPurpose(call: Pick<ModelCall, 'fn' | 'system' | 'purpose'>): string {
  if (call.fn !== undefined) { return call.system === undefined ? `for ${call.fn}` : `for ${call.fn} (${call.system})`; }
  if (call.system !== undefined) { return `for ${call.system}`; }
  return call.purpose === undefined ? 'for the hub' : `hub: ${call.purpose}`;
}

/** How much a call sent and received. */
export function sizeText(call: Pick<ModelCall, 'sent' | 'received'>): string {
  return `${formatBytes(call.sent)} sent, ${formatBytes(call.received)} received`;
}

/** How long a call took in all so far (ms): its total, or since it started while it runs. */
export function callTook(call: Pick<ModelCall, 'total' | 'startedAt' | 'status'>, now: number): number | undefined {
  if (call.total !== undefined) { return call.total; }
  return call.status === 'running' ? now - call.startedAt : undefined;
}
