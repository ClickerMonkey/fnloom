/**
 * The admin reads slice (admins only): what the settings endpoints set (budgets with their spend, priority rules,
 * policies, model categories, actor settings), the models providers offer, a system's fns and output, the limits any
 * person would get, browsing runs, LLM calls and resources, and removing a rule. While installed it relays each
 * system's new output lines as the `systemLog` event. `adminOnly` is bound by the systems plugin it requires.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import {
  adminSlice, UserView, type BudgetView, type LlmSummary, type ResourceRecord, type SettingView, type TableName,
} from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { collect, PAGE } from '../paging.ts';
import { userInfo, type FullHandlers } from './access.ts';
import type { AdminOperations } from '../admin-ops.ts';
import type { HubReads } from '../reads.ts';
import type { systemsPlugin } from './systems.ts';

/** How many rows a page holds when not asked. */
const PAGE_SIZE = 50;

/** Every row of a small table (rules, categories). */
function all<T extends TableName>(hub: Pick<HubServices, 'store'>, table: T) {
  return collect((cursor) => hub.store.table(table).find({ limit: PAGE, cursor }));
}

/** The admin reads plugin. */
export function adminPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, ops: AdminOperations, reads: HubReads) {
  const { store, catalog } = hub;
  return plugin({ name: 'web.admin', spec: adminSlice, requires: [systems] })
    .lifecycle((ctx) => {
      let stop: (() => void) | undefined;
      return {
        up: () => { stop = hub.bus.subscribe('system.output', ({ system, line }) => { ctx.emit('systemLog', { system }, line); }); },
        stop: () => { stop?.(); },
      };
    })
    .handlers((): FullHandlers<typeof adminSlice> => ({
      systemFns: ({ data, user }) => reads.system_fns(data, user),
      systemLogs: ({ data, user }) => reads.system_logs(data, user),
      models: async (io) => {
        const data = io.data;
        const models = await hub.execution.llm.models();
        if (data.provider === undefined) { return models; }
        const record = await store.table('providers').get(data.provider);
        return record === undefined ? [] : models.filter((model) => model.provider === record.config.provider);
      },
      modelCategories: () => all(hub, 'modelCategories'),
      budgets: async () => {
        const now = hub.clock();
        const rules = await all(hub, 'budgets');
        return Promise.all(rules.map(async (rule): Promise<BudgetView> => ({ ...rule, spent: await hub.execution.ledger.spent(rule, { now }) })));
      },
      priorityRules: () => all(hub, 'priorityRules'),
      resolveLimits: async ({ data }) => {
        const actor = await store.table('actors').get(data.user);
        if (actor?.kind !== 'user') { throw reject(404, 'USER_NOT_FOUND', `no user ${data.user}`); }
        return hub.execution.limits.resolve({ user: await userInfo(hub, UserView.parse(actor)), ...(data.session === undefined ? {} : { session: data.session }) });
      },
      policies: () => all(hub, 'policies'),
      actors: async (io) => {
        const { kind } = io.data;
        return (await all(hub, 'actors')).filter((actor) => kind === undefined || actor.kind === kind);
      },
      actorSettings: async () => {
        const declared = (await catalog.entries('settings')).map((entry): SettingView => ({
          setting: entry.name, system: entry.system, decl: entry.decl,
        }));
        return { declared, values: await all(hub, 'actorSettings') };
      },
      runs: ({ data, user }) => reads.runs_list(data, user),
      llmCalls: async (io) => {
        const data = io.data;
        const page = await store.table('llmInteractions').find({
          where: {
            ...(data.status === undefined ? {} : { status: data.status }), ...(data.model === undefined ? {} : { model: data.model }),
            ...(data.system === undefined ? {} : { system: data.system }), ...(data.session === undefined ? {} : { session: data.session }),
          },
          order: [['queuedAt', 'desc']], limit: data.limit ?? PAGE_SIZE, ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
        });
        return { ...page, items: page.items.map(({ request: _request, response: _response, ...summary }): LlmSummary => summary) };
      },
      resources: async (io) => {
        const data = io.data;
        const limit = data.limit ?? PAGE_SIZE;
        const search = data.search?.trim().toLowerCase() ?? '';
        const matches = (r: ResourceRecord): boolean => search === '' || r.uri.toLowerCase().includes(search);
        // the store can't match part of a uri, so a search reads whole pages until it has enough matches or runs out
        // (a page of matches can hold a few more than asked for; none are skipped)
        const items: ResourceRecord[] = [];
        let cursor = data.cursor;
        do {
          const page = await store.table('resources').find({
            ...(data.system === undefined ? {} : { where: { system: data.system } }), order: [['seenAt', 'desc']], limit: search === '' ? limit : PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          });
          items.push(...page.items.filter(matches));
          cursor = page.cursor;
        } while (items.length < limit && cursor !== undefined && search !== '');
        return { items, ...(cursor === undefined ? {} : { cursor }) };
      },
      removeRule: ({ data, user }) => ops.remove_rule(data, user.id),
    }));
}
