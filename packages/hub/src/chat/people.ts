/** People: the who-and-when every system gets about the person a turn, mention or action is for. */
import type { ActorId, AgentActor, Asker, ClientInfo, QualifiedName, SessionId, UserActor, UserInfo } from '@harness/core';
import type { ChatDeps } from './deps.ts';
import { ChatError } from './errors.ts';
import { AGENT_KIND } from '../execution/index.ts';
import { agentActorId, agentName, readAll } from './support.ts';
import { timeInfo } from '../execution/time.ts';

/** Where a person is, when their browser didn't say (a mention search, a scheduled turn). */
const FALLBACK_PLACE = { timeZone: 'UTC', locale: 'en-US' } as const;

/** The most groups one person's `UserInfo` lists. */
const MAX_GROUPS = 200;

/** Builds `UserInfo` and `Asker` from the actors table and what the browser reports, and finds agents' actors. */
export class People {
  readonly #deps: Pick<ChatDeps, 'store' | 'clock' | 'catalog'>;

  constructor(deps: Pick<ChatDeps, 'store' | 'clock' | 'catalog'>) {
    this.#deps = deps;
  }

  /** A signed-in user's actor; refused for anything that isn't an enabled user. */
  async user(actor: ActorId): Promise<UserActor> {
    const row = await this.#deps.store.table('actors').get(actor);
    if (row?.kind !== 'user' || row.disabled) { throw new ChatError('forbidden', 'Only an enabled user can do that.'); }
    return row;
  }

  /** The person as systems see them: their zone and locale from the browser, else from their profile, else UTC. */
  async info(actor: ActorId, client?: Pick<ClientInfo, 'timeZone' | 'locale'>): Promise<UserInfo> {
    const user = await this.user(actor);
    const memberships = await readAll(this.#deps.store.table('memberships'), { where: { user: actor } }, MAX_GROUPS);
    const groups = await Promise.all(memberships.map(async (m) => this.#deps.store.table('actors').get(m.group)));
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      groups: groups.flatMap((g) => (g?.kind === 'group' ? [{ id: g.id, name: g.name }] : [])),
      timeZone: client?.timeZone ?? user.timeZone ?? FALLBACK_PLACE.timeZone,
      locale: client?.locale ?? FALLBACK_PLACE.locale,
    };
  }

  /**
   * The actor of an agent fn, made on first use. Refused unless the fn is an agent (kind `hub/llm`), so a session
   * can't be answered by something that isn't one.
   */
  async agent(fn: QualifiedName): Promise<AgentActor> {
    const record = await this.#deps.catalog.fn(fn);
    if (record?.decl.kind !== AGENT_KIND) { throw new ChatError('invalid', `${fn} is not an agent.`); }
    const id = agentActorId(fn);
    const existing = await this.#deps.store.table('actors').get(id);
    if (existing?.kind === 'agent') { return existing; }
    const agent: AgentActor = { id, kind: 'agent', fn, name: agentName(fn), about: record.decl.description, createdAt: this.#deps.clock(), disabled: false };
    await this.#deps.store.table('actors').put(agent);
    return agent;
  }

  /** Who is asking, and their current time, for a request in a session. */
  async asker(session: SessionId, actor: ActorId, client?: Pick<ClientInfo, 'timeZone' | 'locale'>): Promise<Asker> {
    const user = await this.info(actor, client);
    return { session, actor, user, time: timeInfo(this.#deps.clock(), user.timeZone) };
  }
}
