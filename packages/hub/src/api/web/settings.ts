/**
 * The settings slice (admins only): model providers (keys stored encrypted as secrets), model categories, budgets,
 * priority rules, policies, actor settings (checked against the setting's declared gin type), users and groups.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import {
  mintId, splitName, SystemName, type ActorId, type GroupActor, type ProviderConfig, type ProviderInput, type ProviderRecord, type SecretId, type UserActor,
} from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { findUserByEmail, normalEmail } from '../auth.ts';
import { compact, type FullHandlers } from './access.ts';
import { collect, first, PAGE } from '../paging.ts';
import { settingsSlice } from './slices.ts';
import type { systemsPlugin } from './systems.ts';

/** The secrets a provider config holds. */
function secretsOf(config: ProviderConfig): SecretId[] {
  switch (config.provider) {
    case 'aws': return config.credentials === undefined ? [] : [config.credentials];
    case 'openai': case 'openrouter': case 'replicate': return [config.apiKey];
  }
}

/** Store a provider's keys as secrets; the config keeps only their ids. */
async function sealProvider(hub: Pick<HubServices, 'api'>, input: ProviderInput, owner: ActorId): Promise<ProviderConfig> {
  const seal = (value: string): Promise<SecretId> => hub.api.secrets.store({ name: `provider:${input.provider}`, owner, value });
  switch (input.provider) {
    case 'openai': return { provider: 'openai', apiKey: await seal(input.apiKey), ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }) };
    case 'openrouter': return { provider: 'openrouter', apiKey: await seal(input.apiKey) };
    case 'replicate': return { provider: 'replicate', apiKey: await seal(input.apiKey) };
    case 'aws': return { provider: 'aws', region: input.region, ...(input.credentials === undefined ? {} : { credentials: await seal(input.credentials) }) };
  }
}

/** Every actor id given must be an actor of this kind. */
async function requireActors(hub: Pick<HubServices, 'store'>, ids: readonly ActorId[], kind: 'user' | 'group'): Promise<void> {
  for (const id of ids) {
    const actor = await hub.store.table('actors').get(id);
    if (actor?.kind !== kind) { throw reject(422, 'NOT_AN_ACTOR', `${id} is not a ${kind}`); }
  }
}

/** The settings plugin. Requires the systems plugin, which binds `adminOnly`. */
export function settingsPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  const { store, catalog, execution, bus } = hub;
  const providers = (): Promise<ProviderRecord[]> => collect((cursor) => store.table('providers').find({ limit: PAGE, cursor }));
  const membership = (group: ActorId, user: ActorId, by: ActorId) => store.table('memberships').put({ group, user, addedBy: by, addedAt: hub.clock() });

  return plugin({ name: 'web.settings', spec: settingsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof settingsSlice> => ({
      configureProvider: async ({ data, user }) => {
        const config = await sealProvider(hub, data, user.id);
        const existing = (await providers()).find((p) => p.config.provider === data.provider);
        if (existing === undefined) {
          await store.table('providers').insert({ id: mintId('provider'), config, createdAt: hub.clock() });
        } else {
          await store.table('providers').update(existing.id, { config });
          for (const secret of secretsOf(existing.config)) { await hub.api.secrets.remove(secret); }
        }
        bus.publish('capabilities.changed', {});
        hub.log.info('provider.configured', { provider: data.provider, user: user.id });
        return { models: (await execution.llm.models()).length };
      },
      providers: async () => {
        const [records, models] = await Promise.all([providers(), execution.llm.models()]);
        return records.map((p) => ({ id: p.id, provider: p.config.provider, models: models.length }));
      },
      setModelCategory: async ({ data }) => {
        const existing = await first((cursor) => store.table('modelCategories').find({ limit: PAGE, cursor }), (c) => c.name === data.name);
        const id = data.id ?? existing?.id ?? mintId('modelCategory');
        await store.table('modelCategories').put({ ...data, id });
        return { id };
      },
      setBudget: async ({ data, user }) => {
        const id = data.id ?? mintId('budget');
        await store.table('budgets').put({ ...compact(data), id, setBy: user.id });
        hub.log.info('budget.set', { budget: id, scope: data.target.scope, maxCost: data.maxCost, user: user.id });
        return { id };
      },
      setPriority: async ({ data, user }) => {
        const id = data.id ?? mintId('priorityRule');
        await store.table('priorityRules').put({ ...compact(data), id, setBy: user.id });
        return { id };
      },
      setPolicy: async ({ data, user }) => {
        const id = data.id ?? mintId('policy');
        const previous = data.id === undefined ? undefined : await store.table('policies').get(data.id);
        await store.table('policies').put({ ...compact(data), id, createdBy: previous?.createdBy ?? user.id, createdAt: previous?.createdAt ?? hub.clock() });
        hub.log.info('policy.set', { policy: id, effect: data.decision.effect, user: user.id });
        return { id };
      },
      setActorSetting: async ({ data, user }) => {
        const system = SystemName.parse(splitName(data.setting).system);
        const decl = (await catalog.entries('settings')).find((s) => s.name === data.setting)?.decl;
        if (decl === undefined) { throw reject(404, 'SETTING_NOT_FOUND', `no setting ${data.setting}`); }
        const actor = await store.table('actors').get(data.actor);
        if (actor === undefined || !decl.appliesTo.includes(actor.kind)) { throw reject(422, 'SETTING_NOT_FOR_ACTOR', `${data.setting} doesn't apply to this actor`); }
        const problems = await catalog.check(system, decl.type, data.value);
        if (problems.length > 0) { throw reject(422, 'SETTING_INVALID', problems.join('; ')); }
        await store.table('actorSettings').put({ setting: data.setting, actor: data.actor, value: data.value, setBy: user.id, updatedAt: hub.clock() });
        return { ok: true };
      },
      addUser: async ({ data, user }) => {
        const email = normalEmail(data.email);
        if ((await findUserByEmail(store, email)) !== undefined) { throw reject(409, 'USER_EXISTS', 'someone already has that email'); }
        const groups = data.groups ?? [];
        await requireActors(hub, groups, 'group');
        const added: UserActor = { id: mintId('actor'), kind: 'user', name: data.name, about: '', email, role: data.role, createdAt: hub.clock(), disabled: false };
        await store.table('actors').insert(added);
        for (const group of groups) { await membership(group, added.id, user.id); }
        hub.log.info('user.added', { actor: added.id, role: data.role, by: user.id });
        return { id: added.id };
      },
      addGroup: async ({ data, user }) => {
        const members = data.members ?? [];
        await requireActors(hub, members, 'user');
        const group: GroupActor = { id: mintId('actor'), kind: 'group', name: data.name, about: data.about, createdAt: hub.clock(), disabled: false };
        await store.table('actors').insert(group);
        for (const member of members) { await membership(group.id, member, user.id); }
        hub.log.info('group.added', { actor: group.id, members: members.length, by: user.id });
        return { id: group.id };
      },
    }));
}
