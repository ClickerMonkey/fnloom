/**
 * The contextor slice: each model's resolved limits and where each came from, an admin's limits for a model (the
 * admin operation the hub's `set_model_limits` fn runs too), and a dry run of what a session's contextor would put in
 * the prompt for a message, through `hub.contextor` (`contextor/index.ts`); and, for admins, the whole request a session's agent would
 * send for a message (`previewPrompt`), with no model called.
 */
import { plugin } from '@ayepi/plugin';
import { contextorSlice, mintId, type ChatMessage } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { limitsFor } from '../../contextor/limits.ts';
import type { AdminOperations } from '../admin-ops.ts';
import { userInfo, visibleSession, type FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The contextor plugin. Requires the systems plugin, which binds `adminOnly`. */
export function contextorPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, ops: AdminOperations) {
  return plugin({ name: 'web.contextor', spec: contextorSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof contextorSlice> => ({
      modelLimits: ({ data }) => limitsFor(hub.contextor.limits, data.model),
      previewSelection: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return hub.contextor.planner.preview(data.session, data.text, user.id);
      },
      setModelLimits: ({ data, user }) => ops.set_model_limits(data, user.id),
      // the message as a turn's first step reads it (the hub's and hooks' blocks added), then the request that step would send
      previewPrompt: async ({ data, user }) => {
        const session = await visibleSession(hub, data.session, user);
        const turn = mintId('turn');
        const enriched = await hub.chat.enrich.enrich({ session, turn, text: data.text, user: await userInfo(hub, user) });
        const message: ChatMessage = {
          id: mintId('message'), session: session.id, turn, author: user.id, role: 'user', parts: [{ type: 'text', text: data.text }, ...enriched.parts], runs: [], status: 'done',
          replyAll: false, answerers: [], createdAt: hub.clock(),
        };
        return hub.execution.agents.preview({ session, user: user.id, message: hub.chat.enrich.render(message), model: data.model, count: data.count });
      },
    }));
}
