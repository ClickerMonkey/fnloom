/**
 * The admin operations: everything an admin configures (providers, model categories, budgets, priorities, policies,
 * actor settings, people and groups, removing a rule, pairing, a system's config, switches and process, model roles
 * and limits, hub MCPs, packages and instances). Each is
 * the operation behind one web admin endpoint, given its parsed body and who asks, keyed by the hub fn that offers
 * the same operation in chat (`ADMIN_ENDPOINTS`). The web handlers and the hub's admin fns both call these, so the
 * two can never do different things.
 */
import { reject } from '@ayepi/core';
import {
  compact, dataExportFileName, MAIN_INSTANCE, mintId, qualify, splitName, SystemName, type ActorId, type HostedBy, type InstanceName, type Json, type GroupActor, type ModelInfo, type ProviderConfig, type ProviderInput, type ProviderKind,
  type ProviderRecord, type SecretId, type SystemRecord, type UserActor,
} from '@harness/core';
import type { ADMIN_ENDPOINTS, AdminFnName } from '@harness/sdk';
import type { z } from 'zod';
import type { HubServices } from '../boot/index.ts';
import type { LimitResolver, RunService } from '../execution/index.ts';
import { findUserByEmail, normalEmail } from './auth.ts';
import { allRows, firstRow } from '../store/rows.ts';
import { userInfo } from './web/access.ts';
import { timeInfo } from '../execution/time.ts';

/** What an endpoint answers: its response schema's output, or nothing. */
type ResultOf<E> = E extends { readonly cfg: { readonly response: infer R extends z.ZodType } } ? z.output<R> : void;

/** One admin operation: an endpoint's parsed body and who asks in, the endpoint's response out. */
export type AdminOp<E extends { readonly cfg: { readonly body: z.ZodType } }> = (data: z.output<E['cfg']['body']>, by: ActorId) => Promise<ResultOf<E>>;

/** Every admin operation, by the name of the hub fn that offers it. */
export type AdminOperations = { readonly [N in AdminFnName]: AdminOp<(typeof ADMIN_ENDPOINTS)[N]> };

/** The secrets a provider config holds. */
export function secretsOf(config: ProviderConfig): SecretId[] {
  switch (config.provider) {
    case 'openai': case 'openrouter': return [config.apiKey];
    case 'ollama': return [];
    case 'aws': return config.auth.kind === 'apiKey' ? [config.auth.apiKey] : [config.auth.secretAccessKey, ...(config.auth.sessionToken === undefined ? [] : [config.auth.sessionToken])];
  }
}

/** How many of the hub AI's models a provider offers. */
export function modelsOf(models: readonly ModelInfo[], provider: ProviderKind): number {
  return models.filter((model) => model.provider === provider).length;
}

/** Every provider record. */
export function providerRecords(hub: Pick<HubServices, 'store'>): Promise<ProviderRecord[]> {
  return allRows(hub.store.table('providers'));
}

/** Store a provider's keys as secrets; the config keeps only their ids. */
async function sealProvider(hub: Pick<HubServices, 'api'>, input: ProviderInput, owner: ActorId): Promise<ProviderConfig> {
  const seal = (value: string): Promise<SecretId> => hub.api.secrets.store({ name: `provider:${input.provider}`, owner, value });
  switch (input.provider) {
    case 'openai': return { provider: 'openai', apiKey: await seal(input.apiKey), ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }) };
    case 'openrouter': return { provider: 'openrouter', apiKey: await seal(input.apiKey) };
    case 'ollama': return input;
    case 'aws': {
      const { auth } = input;
      const sealed: Extract<ProviderConfig, { provider: 'aws' }>['auth'] = auth.kind === 'apiKey'
        ? { kind: 'apiKey', apiKey: await seal(auth.apiKey) }
        : { kind: 'keys', accessKeyId: auth.accessKeyId, secretAccessKey: await seal(auth.secretAccessKey), ...(auth.sessionToken === undefined ? {} : { sessionToken: await seal(auth.sessionToken) }) };
      return { provider: 'aws', region: input.region, auth: sealed, ...(input.profilePrefix === undefined ? {} : { profilePrefix: input.profilePrefix }) };
    }
  }
}

/** Every actor id given must be an actor of this kind. */
async function requireActors(hub: Pick<HubServices, 'store'>, ids: readonly ActorId[], kind: 'user' | 'group'): Promise<void> {
  for (const id of ids) {
    const actor = await hub.store.table('actors').get(id);
    if (actor?.kind !== kind) { throw reject(422, 'NOT_AN_ACTOR', `${id} is not a ${kind}`); }
  }
}

/** A system the hub knows, or 404. */
export async function knownSystem(hub: Pick<HubServices, 'store'>, name: SystemName): Promise<SystemRecord> {
  const record = await hub.store.table('systems').get(name);
  if (record === undefined) { throw reject(404, 'SYSTEM_NOT_FOUND', `no system ${name}`); }
  return record;
}

/** Who hosts an instance another system builds and runs (`InstanceRecord.host`), if one does. */
export async function hostOf(hub: Pick<HubServices, 'store'>, system: SystemName, instance: InstanceName | undefined): Promise<HostedBy | undefined> {
  return (await hub.store.table('instances').get({ system, instance: instance ?? MAIN_INSTANCE }))?.host;
}

/**
 * Run one of a host's fns (`fs/restart_system`, `fs/stop_system`) for an admin, in a turn of their own, and wait for
 * it: the host restarts the approved bundle as it is, so no new code runs and no approval card is needed.
 */
/** What `hostCall` uses of the hub. */
export interface HostCallDeps extends Pick<HubServices, 'store' | 'clock'> {
  readonly execution: { readonly limits: Pick<LimitResolver, 'resolve'>; readonly runs: Pick<RunService, 'start'> };
}

export async function hostCall(hub: HostCallDeps, hosted: HostedBy, fn: string, args: Json, by: ActorId): Promise<{ ok: boolean }> {
  const actor = await hub.store.table('actors').get(by);
  if (actor?.kind !== 'user') throw reject(403, 'NOT_A_PERSON', 'only a person can restart or stop a hosted system');
  const user = await userInfo(hub, actor);
  const now = hub.clock();
  const turn = mintId('turn');
  const limits = await hub.execution.limits.resolve({ user, turn });
  await hub.store.table('turns').insert({ id: turn, actor: by, user, time: timeInfo(now, user.timeZone), status: 'running', limits, cost: 0, errors: { max: 1 }, createdAt: now });
  const { run, settled } = await hub.execution.runs.start({
    fn: qualify(hosted.host.system, fn), args, turn, key: `host:${fn}`, actor: by, caller: by, priority: limits.priority, background: false, handlers: [],
    // the host instance that builds and runs it, not whichever instance of the host the hub would pick
    on: hosted.host.instance,
  });
  await hub.store.table('turns').update(turn, { root: run });
  const outcome = await settled;
  await hub.store.table('turns').update(turn, { status: outcome.status === 'done' ? 'done' : 'failed', endedAt: hub.clock() });
  if (outcome.status === 'failed') throw reject(502, 'HOST_REFUSED', `${hosted.host.system} could not ${fn.replace('_system', '')} it: ${outcome.error.message}`);
  return { ok: outcome.status === 'done' };
}

/**
 * Start, stop or restart an instance another system hosts, through its host's fn, naming the instance (left out for
 * `main`, which the host assumes). `undefined` when no system hosts it, so the hub's supervisor handles it.
 */
export async function viaHost(
  hub: HostCallDeps, target: { system: SystemName; instance?: InstanceName | undefined }, fn: 'restart_system' | 'stop_system', by: ActorId, reason?: string,
): Promise<{ ok: boolean } | undefined> {
  const hosted = await hostOf(hub, target.system, target.instance);
  if (hosted === undefined) return undefined;
  const args = { system: target.system, ...(target.instance === undefined ? {} : { instance: target.instance }), ...(reason === undefined ? {} : { reason }) };
  return hostCall(hub, hosted, fn, args, by);
}

/** The admin operations on the hub's services. */
export function adminOperations(hub: HubServices): AdminOperations {
  const { store, catalog, execution, bus, link } = hub;
  const membership = (group: ActorId, user: ActorId, by: ActorId) => store.table('memberships').put({ group, user, addedBy: by, addedAt: hub.clock() });

  return {
    configure_provider: async (data, by) => {
      const config = await sealProvider(hub, data, by);
      const existing = (await providerRecords(hub)).find((p) => p.config.provider === data.provider);
      if (existing === undefined) {
        await store.table('providers').insert({ id: mintId('provider'), config, createdAt: hub.clock() });
      } else {
        await store.table('providers').update(existing.id, { config });
        for (const secret of secretsOf(existing.config)) { await hub.api.secrets.remove(secret); }
      }
      await execution.providers.reload();
      bus.publish('capabilities.changed', {});
      hub.log.info('provider.configured', { provider: data.provider, user: by });
      return { models: modelsOf(await execution.llm.models(), data.provider) };
    },
    set_model_category: async (data) => {
      const existing = await firstRow(store.table('modelCategories'), { where: { name: data.name } }, () => true);
      const id = data.id ?? existing?.id ?? mintId('modelCategory');
      await store.table('modelCategories').put({ ...data, id });
      return { id };
    },
    set_budget: async (data, by) => {
      const id = data.id ?? mintId('budget');
      await store.table('budgets').put({ ...compact(data), id, setBy: by });
      hub.log.info('budget.set', { budget: id, scope: data.target.scope, maxCost: data.maxCost, user: by });
      return { id };
    },
    set_priority: async (data, by) => {
      const id = data.id ?? mintId('priorityRule');
      await store.table('priorityRules').put({ ...compact(data), id, setBy: by });
      return { id };
    },
    set_policy: async (data, by) => {
      const id = data.id ?? mintId('policy');
      const previous = data.id === undefined ? undefined : await store.table('policies').get(data.id);
      await store.table('policies').put({ ...compact(data), id, createdBy: previous?.createdBy ?? by, createdAt: previous?.createdAt ?? hub.clock() });
      hub.log.info('policy.set', { policy: id, effect: data.decision.effect, user: by });
      return { id };
    },
    set_actor_setting: async (data, by) => {
      const system = SystemName.parse(splitName(data.setting).system);
      const decl = (await catalog.entries('settings')).find((s) => s.name === data.setting)?.decl;
      if (decl === undefined) { throw reject(404, 'SETTING_NOT_FOUND', `no setting ${data.setting}`); }
      const actor = await store.table('actors').get(data.actor);
      if (actor === undefined || !decl.appliesTo.includes(actor.kind)) { throw reject(422, 'SETTING_NOT_FOR_ACTOR', `${data.setting} doesn't apply to this actor`); }
      const problems = await catalog.check(system, decl.type, data.value);
      if (problems.length > 0) { throw reject(422, 'SETTING_INVALID', problems.join('; ')); }
      await store.table('actorSettings').put({ setting: data.setting, actor: data.actor, value: data.value, setBy: by, updatedAt: hub.clock() });
      return { ok: true };
    },
    add_user: async (data, by) => {
      const email = normalEmail(data.email);
      if ((await findUserByEmail(store, email)) !== undefined) { throw reject(409, 'USER_EXISTS', 'someone already has that email'); }
      const groups = data.groups ?? [];
      await requireActors(hub, groups, 'group');
      const added: UserActor = { id: mintId('actor'), kind: 'user', name: data.name, about: '', email, role: data.role, createdAt: hub.clock(), disabled: false };
      await store.table('actors').insert(added);
      for (const group of groups) { await membership(group, added.id, by); }
      hub.log.info('user.added', { actor: added.id, role: data.role, by });
      return { id: added.id };
    },
    add_group: async (data, by) => {
      const members = data.members ?? [];
      await requireActors(hub, members, 'user');
      const group: GroupActor = { id: mintId('actor'), kind: 'group', name: data.name, about: data.about, createdAt: hub.clock(), disabled: false };
      await store.table('actors').insert(group);
      for (const member of members) { await membership(group.id, member, by); }
      hub.log.info('group.added', { actor: group.id, members: members.length, by });
      return { id: group.id };
    },
    remove_rule: async (data, by) => {
      const removed = await (() => {
        switch (data.kind) {
          case 'budget': return store.table('budgets').remove(data.id);
          case 'priority': return store.table('priorityRules').remove(data.id);
          case 'policy': return store.table('policies').remove(data.id);
          case 'category': return store.table('modelCategories').remove(data.id);
          case 'provider': return store.table('providers').remove(data.id);
        }
      })();
      if (removed) { bus.publish('capabilities.changed', {}); }
      hub.log.info('rule.removed', { kind: data.kind, id: data.id, removed, user: by });
      return { ok: removed };
    },
    approve_pairing: async (data, by) => {
      if (!data.approve) {
        await link.pairing.reject(data.pairing, by);
        hub.log.info('pairing.rejected', { pairing: data.pairing, user: by });
        return {};
      }
      const record = await link.pairing.approve(data.pairing, by, compact({ instance: data.instance, config: data.config, autoPair: data.autoPair }));
      hub.log.info('pairing.approved', { pairing: data.pairing, system: record.system, instance: record.instance, user: by });
      return { system: record.system };
    },
    create_pairing_token: (data, by) => link.pairing.createToken({ ...compact(data), by }),
    configure_system: async (data, by) => {
      await knownSystem(hub, data.system);
      const result = await link.config.set(data.system, data.config, by, data.instance);
      hub.log.info('system.configured', { system: data.system, instance: data.instance, user: by, ok: 'version' in result });
      return result;
    },
    enable_system: async ({ system: name, ...change }, by) => {
      await knownSystem(hub, name);
      const enabled = await link.admin.setEnabled(name, compact(change), by);
      bus.publish('capabilities.changed', {});
      hub.log.info('system.enabled', { system: name, ...enabled, user: by });
      return { enabled };
    },
    switch_item: async (data, by) => {
      await knownSystem(hub, SystemName.parse(splitName(data.name).system));
      const switched = await link.admin.switchItem(data, by);
      bus.publish('capabilities.changed', {});
      return switched;
    },
    remove_system: async (data, by) => {
      await knownSystem(hub, data.system);
      const removed = await link.admin.remove(data.system, by);
      hub.log.info('system.removed', { system: data.system, fns: removed.fnsUnavailable, user: by });
      return removed;
    },
    install_system: async (data, by) => {
      const installed = await link.supervisor.install({ ...compact(data), by });
      hub.log.info('system.installed', { system: installed.name, version: installed.version, user: by });
      return { name: installed.name };
    },
    // a hosted instance (installed from the chat) is started, stopped and restarted by its host's fns, as the admin
    start_system: async (data, by) => {
      const hosted = await viaHost(hub, data, 'restart_system', by, 'started from the Systems page');
      if (hosted !== undefined) return hosted;
      await link.supervisor.start(data.system, data.instance);
      return { ok: true };
    },
    stop_system: async (data, by) => {
      const hosted = await viaHost(hub, data, 'stop_system', by);
      if (hosted !== undefined) return hosted;
      await link.supervisor.stop(data.system, 'shutdown', data.instance);
      return { ok: true };
    },
    restart_system: async (data, by) => {
      const hosted = await viaHost(hub, data, 'restart_system', by, data.reason);
      if (hosted !== undefined) return hosted;
      await link.supervisor.stop(data.system, 'restart', data.instance);
      await link.supervisor.start(data.system, data.instance);
      hub.log.info('system.restarted', { system: data.system, instance: data.instance ?? null, by, reason: data.reason });
      return { ok: true };
    },
    upgrade_system: (data) => link.supervisor.upgrade(data.system, data.version),
    set_model_role: async (data, by) => {
      const view = await hub.models.roles.set(data, by);
      hub.log.info('model.role.chosen', { role: data.role, user: by, usable: view.resolved !== undefined && 'model' in view.resolved });
      return view;
    },
    clear_model_role: (data, by) => hub.models.roles.clear(data.role, by),
    set_model_limits: (data, by) => hub.contextor.limits.set(data.model, data.limits, by),
    create_mcp: (data, by) => hub.mcp.registry.create(data, by),
    update_mcp: async ({ mcp, ...change }, by) => hub.mcp.registry.update(mcp, compact(change), by),
    rotate_mcp_secret: (data, by) => hub.mcp.registry.rotate(data.mcp, by),
    delete_mcp: async (data, by) => ({ ok: await hub.mcp.registry.remove(data.mcp, by) }),
    preview_mcp: (data) => hub.mcp.scopes.preview(data.rules),
    install_package: async (data, by) => {
      const ref = await link.packages.installZip({ ...compact({ instance: data.instance, config: data.config, data: data.data, autoStart: data.autoStart }), zip: data.zip, by });
      hub.log.info('package.installed', { system: ref.system, instance: ref.instance, user: by });
      return ref;
    },
    remove_instance: async (data, by) => {
      await link.packages.removeInstance(data, by);
      return { ok: true };
    },
    suggest_decision_set: (data, by) => hub.chat.suggestions.set(data, by),
    auto_pair_revoke: async (data, by) => ({ ok: await link.autoPairs.revoke(data.id, by) }),
    system_reimport: async (data) => {
      await knownSystem(hub, data.system);
      return link.admin.reimport(data.system);
    },
    export_system_data: async (data, by) => {
      const ref = await link.packages.exportData({ ref: { system: data.system, instance: data.instance }, withSecrets: data.withSecrets ?? false, by });
      return { ...ref, url: await hub.api.content.presignDownload(ref, dataExportFileName(data)) };
    },

  };
}
