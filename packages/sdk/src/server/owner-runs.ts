/**
 * The runtime's side of `ctx.runs` (a system's context) and `ctx.notify` (a run's): listing the fns of the system's
 * own kinds with their payloads parsed (`kindFns` on the hub link), starting one as its owner (`startRun`), and
 * notices to one person (`notifyOwner`, `notify`). A `KindFn` is branded here and nowhere else, so only a listed fn can
 * be started or notified about; a notice's page link is written from a page ref of this system's own.
 */
import { SystemName, SystemNotice, type KindFnWire, type NotificationLink, type RunId } from '@harness/core';
import { KIND_FN, type KindFn, type KindRuns, type Notice, type NoticeLink, type RunNotices } from '../ctx.ts';
import type { AnyKindRef } from '../refs.ts';
import { decode } from './wire.ts';
import type { HubAccess } from './link.ts';
import type { ScopedLog } from './log.ts';

/** Where `ctx.runs` and `ctx.notify` reach the hub from: the system, its link and its log. */
export interface NoticeSource {
  readonly system: string;
  readonly hub: HubAccess;
  readonly signal: AbortSignal;
}

/** A notice link on the wire: a run as it is, a page ref as the system, segment, path and query it names. */
function linkWire(system: string, link: NoticeLink): NotificationLink {
  if ('run' in link) { return { run: link.run }; }
  const { page } = link;
  if (page.system !== system) { throw new Error(`${system} can only link a notice to its own pages, not ${page.name}.`); }
  return {
    page: {
      system: SystemName.parse(page.system), segment: page.segment,
      ...(link.path === undefined ? {} : { path: [...link.path] }),
      ...(link.query === undefined ? {} : { query: { ...link.query } }),
    },
  };
}

/** A notice on the wire, checked. */
export function noticeWire(system: string, notice: Notice): SystemNotice {
  return SystemNotice.parse({
    title: notice.title,
    body: notice.body,
    ...(notice.tone === undefined ? {} : { tone: notice.tone }),
    ...(notice.link === undefined ? {} : { link: linkWire(system, notice.link) }),
    ...(notice.also === undefined ? {} : { also: { label: notice.also.label, link: linkWire(system, notice.also.link) } }),
    ...(notice.key === undefined ? {} : { key: notice.key }),
  });
}

/** Whether a value is a fn `kindFns` listed (branded), not one built by hand. */
function isListed(fn: KindFn<AnyKindRef>): boolean {
  return Object.hasOwn(fn, KIND_FN);
}

/** The listed fn, or a refusal for one built by hand. */
function listed(system: string, fn: KindFn<AnyKindRef>): KindFn<AnyKindRef> {
  if (!isListed(fn)) { throw new Error(`${system}: only a fn ctx.runs.kindFns listed can be started or notified about, not ${fn.fn}.`); }
  return fn;
}

/** A listed fn: the wire item, its payload parsed by the kind's payload type, branded. */
function kindFnOf<K extends AnyKindRef>(item: KindFnWire, payload: unknown): KindFn<K> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the hub listed it for kind K and the payload was parsed by K's payload type just before
  return { [KIND_FN]: item.kind, fn: item.fn, kind: item.kind, owner: item.owner, title: item.title, version: item.version, payload, removed: item.removed, updatedAt: item.updatedAt } as KindFn<K>;
}

/** `ctx.runs` for a system's context. */
export function ownerRuns(source: NoticeSource, log: ScopedLog): KindRuns {
  const { system, hub, signal } = source;
  return {
    kindFns: async (kind, query) => {
      if (!kind.name.startsWith(`${system}/`)) { throw new Error(`${system} can only list fns of its own kinds, not ${kind.name}.`); }
      const link = await hub.ready(signal);
      const page = await link.call('kindFns', {
        kind: kind.name,
        ...(query?.changedSince === undefined ? {} : { changedSince: query.changedSince }),
        ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
      }, { signal });
      const items = page.items.flatMap((item) => {
        const parsed = decode(kind.payload, item.payload, `${item.fn}'s payload`);
        // a payload the kind no longer reads (its type changed since it was saved) is left out and logged
        if (!parsed.ok) { log.warn('runs.kind-fn.unreadable', { fn: item.fn, problem: parsed.error.message }); return []; }
        return [kindFnOf<typeof kind>(item, parsed.value)];
      });
      return { items, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
    },
    start: async (fn, options) => {
      const own = listed(system, fn);
      const link = await hub.ready(signal);
      return await link.call('startRun', {
        fn: own.fn, args: options.args, key: options.key,
        ...(options.priority === undefined ? {} : { priority: options.priority }),
        ...(options.maxSpend === undefined ? {} : { maxSpend: options.maxSpend }),
      }, { signal });
    },
    notify: async (fn, notice) => {
      const own = listed(system, fn);
      const link = await hub.ready(signal);
      await link.call('notifyOwner', { fn: own.fn, notice: noticeWire(system, notice) }, { signal });
    },
  };
}

/** `ctx.notify` for a run's context: the run's own person, and no one else. */
export function runNotices(source: NoticeSource, run: RunId): RunNotices {
  return {
    notify: async (notice) => {
      const link = await source.hub.ready(source.signal);
      await link.call('notify', { run, notice: noticeWire(source.system, notice) }, { signal: source.signal });
    },
  };
}
