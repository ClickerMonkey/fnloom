/**
 * What the web API handlers share: who the signed-in person is as systems see them (`UserInfo`), and the checks that
 * a person may see a session, a run or a turn. A record a person may not see answers 404, the same as one that
 * doesn't exist, so ids can't be probed.
 */
import { reject, type AnySpec, type AnyEndpoint, type HandlerFor } from '@ayepi/core';
import type { ClientInfo, RunId, Session, SessionId, TurnId, UserInfo, UserView, Run, Turn } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { collect, PAGE } from '../paging.ts';

/** A handler for every endpoint of a slice: `.handlers(() => …)` annotated with this can't leave one out. */
export type FullHandlers<S extends AnySpec> = { readonly [K in keyof S['endpoints'] & string]: HandlerFor<S, S['endpoints'][K] & AnyEndpoint> };

/** Used when neither the browser nor the profile gives a time zone or locale. */
const FALLBACK = { timeZone: 'UTC', locale: 'en' } as const;

/** A short description of the browser, kept with its sign-in session. */
export function deviceOf(req: Request): string {
  return (req.headers.get('user-agent') ?? 'unknown').slice(0, 200);
}

/** The person as runs and systems see them: their groups, and their time zone and locale (the browser's when given). */
export async function userInfo(hub: Pick<HubServices, 'store'>, user: UserView, client?: ClientInfo): Promise<UserInfo> {
  const memberships = await collect((cursor) => hub.store.table('memberships').find({ where: { user: user.id }, limit: PAGE, cursor }));
  const groups: UserInfo['groups'] = [];
  for (const membership of memberships) {
    const group = await hub.store.table('actors').get(membership.group);
    if (group?.kind === 'group' && !group.disabled) { groups.push({ id: group.id, name: group.name }); }
  }
  return {
    id: user.id, name: user.name, email: user.email, role: user.role, groups,
    timeZone: client?.timeZone ?? user.timeZone ?? FALLBACK.timeZone, locale: client?.locale ?? FALLBACK.locale,
  };
}

/** A session the person may see, or 404. */
export async function visibleSession(hub: Pick<HubServices, 'chat'>, session: SessionId, user: UserView): Promise<Session> {
  const found = await hub.chat.sessions.get(session, user.id);
  if (found === undefined) { throw reject(404, 'SESSION_NOT_FOUND', 'no such session'); }
  return found;
}

/** Whether the person may see what happened in a session (or, outside a session, what they started). */
async function mayView(hub: Pick<HubServices, 'chat'>, user: UserView, where: { session?: SessionId | undefined; actor: string }): Promise<boolean> {
  if (user.role === 'admin') { return true; }
  if (where.session !== undefined) { return (await hub.chat.sessions.get(where.session, user.id)) !== undefined; }
  return where.actor === user.id;
}

/** A run the person may see, or 404. */
export async function visibleRun(hub: Pick<HubServices, 'chat' | 'execution'>, run: RunId, user: UserView): Promise<Run> {
  const found = await hub.execution.runs.get(run);
  if (found === undefined || !(await mayView(hub, user, found))) { throw reject(404, 'RUN_NOT_FOUND', 'no such run'); }
  return found;
}

/** A turn the person may see, or 404. */
export async function visibleTurn(hub: Pick<HubServices, 'chat' | 'store'>, turn: TurnId, user: UserView): Promise<Turn> {
  const found = await hub.store.table('turns').get(turn);
  if (found === undefined || !(await mayView(hub, user, found))) { throw reject(404, 'TURN_NOT_FOUND', 'no such turn'); }
  return found;
}

/** An object without its `undefined` fields, typed so: `?: T | undefined` (as zod infers) becomes `?: T`. */
export type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

/**
 * Drop the `undefined` fields of a parsed request, so it can be handed to a service whose optional fields don't take
 * `undefined` (with `exactOptionalPropertyTypes`).
 */
export function compact<T extends object>(value: T): Compact<T> {
  const kept = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- exactly the fields of `value` that aren't undefined
  return kept as Compact<T>;
}
