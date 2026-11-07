/**
 * The system-link endpoints the execution module serves (`hubLinkSpec`): a run's child calls, its calls to its
 * caller's handlers, controlling its children, its progress, operations and undo payload, and the LLM forward. A system may only act on its own runs.
 * The link module installs these on the link server; `ChildRelay` tells a calling system about its child runs.
 */
import type { HandlerFor } from '@ayepi/core';
import type { HubLinkSpec, Run, RunId, RunSettled, RunUpdate, SystemName } from '@harness/core';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import { causeOf, fnError, messageOf, RunRefused } from './errors.ts';
import type { LlmGateway } from './index.ts';
import type { HandlerRelay } from './handlers.ts';
import type { ExecutionDeps } from './ports.ts';
import { isSettled, type HubRunService } from './runs.ts';

/** The handler of one hub link endpoint. */
export type LinkHandler<K extends keyof HubLinkSpec['endpoints']> = HandlerFor<HubLinkSpec, HubLinkSpec['endpoints'][K]>;

/** The endpoints execution serves (the link module serves the handshake, contract, resources, embeddings and logs). */
export type ExecutionLinkEndpoints = 'call' | 'handle' | 'control' | 'progress' | 'allow' | 'undoWith' | 'llm';

/** What the handlers use. */
export interface LinkHandlerDeps extends Pick<ExecutionDeps, 'store' | 'log'> {
  readonly runs: Pick<HubRunService, 'get' | 'start' | 'cancel' | 'pause' | 'progress' | 'allow' | 'undoWith'>;
  readonly gateway: Pick<LlmGateway, 'forward'>;
  readonly handlers: Pick<HandlerRelay, 'handle'>;
}

/** A system tried to act on a run that isn't its own (or doesn't exist). */
export class NotYourRun extends Error {
  override readonly name = 'NotYourRun';

  constructor(run: RunId, system: string) {
    super(`run ${run} is not ${system}'s`);
  }
}

/** The handlers, by endpoint. */
export function executionLinkHandlers(deps: LinkHandlerDeps): { [K in ExecutionLinkEndpoints]: LinkHandler<K> } {
  const { runs, gateway, store } = deps;

  /** The run, if it belongs to the system asking. */
  const own = async (id: RunId, system: SystemName): Promise<Run> => {
    const run = await runs.get(id);
    if (run?.system !== system) throw new NotYourRun(id, system);
    return run;
  };

  return {
    call: async ({ data, link }): Promise<RunSettled> => {
      const parent = await own(data.parent, link.system);
      if (isSettled(parent.status)) return { status: 'failed', error: fnError('fatal', `run ${parent.id} has already finished`, 'settled') };
      const system = await store.table('systems').get(link.system);
      try {
        const started = await runs.start({
          fn: data.fn, args: data.args, turn: parent.turn, parent: parent.id, key: data.key, actor: parent.actor, caller: system?.actor ?? parent.caller,
          priority: parent.priority, background: data.background, handlers: data.handlers,
          ...(parent.session === undefined ? {} : { session: parent.session }),
          ...(data.budget === undefined ? {} : { budget: { ...(data.budget.cost === undefined ? {} : { cost: data.budget.cost }), ...(data.budget.time === undefined ? {} : { time: data.budget.time }) } }),
        });
        return await started.settled;
      } catch (error) {
        const refused = causeOf(error, RunRefused);
        return { status: 'failed', error: refused?.error ?? fnError('fatal', messageOf(error)) };
      }
    },
    control: async ({ data, link }) => {
      const child = await runs.get(data.run);
      const parent = child?.parent === undefined ? undefined : await runs.get(child.parent);
      if (child === undefined || parent?.system !== link.system) return { accepted: false, reason: `run ${data.run} is not a call ${link.system} made` };
      const answer = data.action === 'cancel' ? await runs.cancel(child.id, parent.actor) : await runs.pause(child.id, parent.actor);
      return answer.reason === undefined ? { accepted: answer.accepted } : { accepted: answer.accepted, reason: answer.reason };
    },
    progress: async ({ data, link }) => {
      await own(data.run, link.system);
      await runs.progress(data.run, data.progress);
    },
    allow: async ({ data, link }) => {
      await own(data.run, link.system);
      await runs.allow(data.run, {
        ...(data.operations.cancel === undefined ? {} : { cancel: data.operations.cancel }),
        ...(data.operations.pause === undefined ? {} : { pause: data.operations.pause }),
        ...(data.operations.background === undefined ? {} : { background: data.operations.background }),
      });
    },
    undoWith: async ({ data, link }) => {
      await own(data.run, link.system);
      await runs.undoWith(data.run, data.undo);
    },
    handle: async ({ data, link, signal }) => {
      await own(data.run, link.system);
      return deps.handlers.handle(data, signal);
    },
    llm: ({ data, link, signal }) => gateway.forward({ ...data, system: link.system }, signal),
  };
}

/** Tells a system about the child runs its calls made: when each is created, and every change after. */
export class ChildRelay {
  readonly #deps: Pick<ExecutionDeps, 'store' | 'bus' | 'link' | 'log'>;

  constructor(deps: Pick<ExecutionDeps, 'store' | 'bus' | 'link' | 'log'>) {
    this.#deps = deps;
  }

  /** Start relaying; returns the stop. */
  start(): () => void {
    return this.#deps.bus.subscribe('run.update', ({ run, update }) => {
      void this.#relay(run, update.type === 'status' && update.status === 'queued' ? undefined : update).catch((error: unknown) => {
        this.#deps.log.warn('run.child-relay-failed', { run, error: messageOf(error) });
      });
    });
  }

  async #relay(id: RunId, update: RunUpdate | undefined): Promise<void> {
    const { store, link } = this.#deps;
    const run = await store.table('runs').get(id);
    if (run?.parent === undefined) return;
    const parent = await store.table('runs').get(run.parent);
    if (parent === undefined || parent.system === HUB_SYSTEM) return;
    const connection = link.connection(parent.system);
    if (connection === undefined) return;
    await connection.peer.call('child', { parent: parent.id, key: run.key, run: run.id, ...(update === undefined ? {} : { update }) });
  }
}
