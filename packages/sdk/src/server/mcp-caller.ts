/** Who an MCP client is to a system: the actor its tool calls run as and its prompts are filled for. */
import { ActorId } from '@harness/core';
import type { AskerWire } from './runtime.ts';

/** The actor MCP calls run as. */
export const MCP_ACTOR = ActorId.parse('act_mcp');

/** The MCP client as the person asking, at `now`. MCP says nothing of time zones or locales, so it is UTC and English. */
export function mcpAsker(now: number): AskerWire {
  return {
    actor: MCP_ACTOR,
    user: { id: MCP_ACTOR, name: 'MCP client', email: '', role: 'member', groups: [], timeZone: 'UTC', locale: 'en' },
    time: { now, timeZone: 'UTC', local: new Date(now).toISOString() },
  };
}
