/**
 * The runtime's side of `ctx.propose`, `ctx.decide`, `ctx.fleet`, `ctx.searchFns` and `ctx.notifyAdmins`: proposing a run that waits for approval (`propose` on the hub
 * link) and asking the decision model to choose (`decide`). One builder each, used by the run context and, for
 * proposals, the system context.
 */
import {
  AdminNotice, InstanceConnect, Json, LocalName, type DecideAnswer, type DecideCandidate, type FleetInstance, type FnExamplesPage, type FnSearchPage, type ProposedRun, type RunId,
} from '@harness/core';
import type { AdminNotices, DecideOptions, Decisions, Fleets, FnSearch, InstanceConnects, ProposeOptions, Proposals } from '../ctx.ts';
import { canonicalJson, sha256 } from '../manifest.ts';
import type { AnyFnRef } from '../refs.ts';
import type { HubAccess } from './link.ts';
import { encodeOrThrow } from './wire.ts';

/** Where proposals are made from: the system, and the run that proposes (absent outside a run). */
export interface ProposalSource {
  readonly system: string;
  readonly hub: HubAccess;
  readonly signal: AbortSignal;
  readonly parent?: RunId | undefined;
}

/** `propose` for a context. */
export function proposals(source: ProposalSource): Proposals {
  const propose = async (fn: AnyFnRef | string, args: unknown, options: ProposeOptions): Promise<ProposedRun> => {
    const { local, wire } = proposedCall(source.system, fn, args);
    const outside = source.parent === undefined;
    const approver = options.approver ?? (outside && options.for === undefined ? 'admins' : 'person');
    if (outside && approver === 'person' && options.for === undefined) {
      throw new Error(`${source.system}: a run proposed outside a run has no person to ask; name them in 'for' or use approver 'admins'.`);
    }
    if (outside && options.for !== undefined && options.key === undefined) {
      throw new Error(`${source.system}: a run proposed for a person outside a run needs a 'key' naming their session or run (proposalKeyFor).`);
    }
    const key = options.key ?? await sha256(canonicalJson([source.parent ?? null, local, wire]));
    const hub = await source.hub.ready(source.signal);
    return await hub.call('propose', {
      fn: local,
      args: wire,
      key,
      approver,
      preview: options.preview,
      ...(source.parent === undefined ? {} : { parent: source.parent }),
      ...(options.for === undefined ? {} : { for: options.for }),
      ...(options.chat === undefined ? {} : { chat: options.chat }),
      ...(options.ask === undefined ? {} : { ask: options.ask }),
    });
  };
  return { propose };
}

/** The proposed fn's local name and its args on the wire: typed through the ref, or JSON for a runtime fn. */
function proposedCall(system: string, fn: AnyFnRef | string, args: unknown): { local: string; wire: Json } {
  if (typeof fn === 'string') {
    if (!LocalName.safeParse(fn).success) { throw new Error(`${system}: '${fn}' is not a fn's local name.`); }
    return { local: fn, wire: Json.parse(args) };
  }
  const prefix = `${system}/`;
  if (!fn.name.startsWith(prefix)) { throw new Error(`${system} can only propose runs of its own fns, not ${fn.name}.`); }
  return { local: fn.name.slice(prefix.length), wire: encodeOrThrow(fn.args, args, `The args of ${fn.name}`) };
}

/** `fleet` for a context: the system's instances, from the hub. */
export function fleets(hub: HubAccess, signal: AbortSignal): Fleets {
  return {
    fleet: async (): Promise<FleetInstance[]> => {
      const link = await hub.ready(signal);
      return await link.call('fleet', {});
    },
  };
}

/** `notifyAdmins` for a context: a word to the hub's admins, as this system. */
export function adminNotices(hub: HubAccess, signal: AbortSignal): AdminNotices {
  return {
    notifyAdmins: async (notice): Promise<void> => {
      const link = await hub.ready(signal);
      await link.call('notifyAdmins', AdminNotice.parse(notice));
    },
  };
}

/** `instanceConnect` for a context: the value, checked, goes to `keep` (the host, which sends it now and on every reconnect). */
export function instanceConnects(keep: (connect: InstanceConnect) => Promise<void>): InstanceConnects {
  return { instanceConnect: (connect) => keep(InstanceConnect.parse(connect)) };
}

/** `searchFns` and `fnExamples` for a context: as the run's person in a run, as the system outside one. */
export function fnSearch(hub: HubAccess, run: RunId | undefined, signal: AbortSignal): FnSearch {
  return {
    searchFns: async (query): Promise<FnSearchPage> => {
      const link = await hub.ready(signal);
      return await link.call('searchFns', { ...query, ...(run === undefined ? {} : { run }) });
    },
    fnExamples: async (query): Promise<FnExamplesPage> => {
      const link = await hub.ready(signal);
      return await link.call('fnExamples', query);
    },
  };
}

/** `decide` for a run. */
export function decisions(hub: HubAccess, run: RunId, signal: AbortSignal): Decisions {
  return {
    decide: async (question: string, candidates: readonly DecideCandidate[], options?: DecideOptions): Promise<DecideAnswer> => {
      if (candidates.length === 0) { return { by: 'decision', picked: [], note: 'There was nothing to choose from.' }; }
      const link = await hub.ready(signal);
      return await link.call('decide', { run, question, candidates: [...candidates], max: options?.max ?? 1 });
    },
  };
}
