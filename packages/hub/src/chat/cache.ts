/**
 * Cache misses (build 4): in full-history chat (a contextor that sends the whole transcript), a reply whose model call
 * read no prompt cache although an earlier call of the session did means the provider read the whole chat again. The
 * chat draws a wavy rule above that reply with the call's time. Only models known to cache count, so a model that never
 * caches, or one nothing is known of, never shows the rule.
 */
import type { ChatMessage, ModelCall, Session } from '@harness/core';
import { LlmPayloadType, parseValue, type LlmPayload } from '@harness/sdk';
import { modeChoice } from '../contextor/planner.ts';
import type { ChatDeps } from './deps.ts';

/** A call made by a session's agent itself (not a system's own call, nor the hub's work such as the decision model). */
function agentChat(call: ModelCall): boolean {
  return call.modality === 'chat' && call.system === undefined && call.purpose === undefined && call.run !== undefined;
}

/** The cached input tokens a chat call read (0 for any other call). */
function cachedOf(call: ModelCall): number {
  return call.units.modality === 'chat' ? call.units.cached ?? 0 : 0;
}

/** Whether a session's prompts carry the whole transcript (`plain` or `suggest`, not the graph contextor's cycles). */
async function fullHistory(deps: Pick<ChatDeps, 'catalog'>, session: Session): Promise<boolean> {
  if (session.contextor !== undefined) return session.contextor.type !== 'graph';
  const agent = await deps.catalog.fn(session.agent);
  return modeChoice(session, agent === undefined ? {} : payloadOf(agent.decl.payload)).contextor.type !== 'graph';
}

/** An agent's mode and contextor choice, or none when its payload doesn't read. */
function payloadOf(payload: unknown): Pick<LlmPayload, 'mode' | 'contextor'> {
  try {
    return parseValue(LlmPayloadType, payload);
  } catch {
    return {};
  }
}

/** The cache miss of an assistant message's first model call, if it was one. */
export async function cacheMissOf(deps: Pick<ChatDeps, 'store' | 'catalog' | 'settings'>, message: Pick<ChatMessage, 'session' | 'turn' | 'createdAt'>): Promise<ChatMessage['cacheMiss']> {
  const calls = deps.store.table('modelCalls');
  const lookback = deps.settings.chat.HARNESS_CACHE_LOOKBACK;
  const mine = await calls.find({ where: { session: message.session, turn: message.turn, modality: 'chat', startedAt: { gte: message.createdAt } }, order: [['startedAt', 'asc']], limit: lookback });
  const first = mine.items.find(agentChat);
  if (first?.units.modality !== 'chat' || first.units.caching !== 'yes' || cachedOf(first) > 0) return undefined;
  const earlier = await calls.find({ where: { session: message.session, modality: 'chat', startedAt: { lt: first.startedAt } }, order: [['startedAt', 'desc']], limit: lookback });
  if (!earlier.items.some((call) => agentChat(call) && cachedOf(call) > 0)) return undefined;
  const session = await deps.store.table('sessions').get(message.session);
  if (session === undefined || !(await fullHistory(deps, session))) return undefined;
  return { call: first.id, at: first.startedAt };
}
