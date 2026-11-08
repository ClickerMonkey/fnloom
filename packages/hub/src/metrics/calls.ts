/**
 * The record of every model call (`ModelCallLog`): one `ModelCall` row per call of any modality, opened when the call
 * starts (its queue wait measured from when it was asked for) and closed once, with what it used, cost and took.
 */
import {
  compact, mintId, type IdRandom, type ModelCall, type ModelCallId, type ModelCallQuery, type ModelUnits, type Page, type Usd,
} from '@harness/core';
import type { Logger } from '@ayepi/log';
import type { HubStore } from '../store/index.ts';
import type { CallSiteInfo, ModelCallLog, OpenModelCall } from './index.ts';

/** How many calls a page holds when the query doesn't say. */
const PAGE_SIZE = 50;

/** The units of a call that used nothing yet, by modality (what a failed call records). */
export function emptyUnits(modality: ModelCall['modality']): ModelUnits {
  switch (modality) {
    case 'chat': return { modality, input: 0, output: 0 };
    case 'embed': return { modality, texts: 0, characters: 0, dimensions: 1 };
    case 'image': return { modality, images: 0 };
    case 'transcribe': return { modality, seconds: 0, bytes: 0 };
    case 'speech': return { modality, characters: 0 };
  }
}

/** What the log uses. */
export interface ModelCallLogDeps {
  readonly store: HubStore;
  readonly clock: () => number;
  readonly log: Logger;
  readonly random?: IdRandom | undefined;
}

/** One call between `begin` and its end. */
class OpenCall implements OpenModelCall {
  readonly id: ModelCallId;
  readonly #deps: ModelCallLogDeps;
  readonly #startedAt: number;
  #firstByte: number | undefined;
  #closed = false;

  constructor(deps: ModelCallLogDeps, id: ModelCallId, startedAt: number) {
    this.#deps = deps;
    this.id = id;
    this.#startedAt = startedAt;
  }

  firstByte(at?: number): void {
    this.#firstByte ??= Math.max(this.#startedAt, at ?? this.#deps.clock());
  }

  async done(input: { units: ModelUnits; cost: Usd; sent: number; received: number; interaction?: ModelCall['interaction'] }): Promise<ModelCall> {
    return this.#close({ status: 'done', units: input.units, cost: input.cost, sent: input.sent, received: input.received, ...(input.interaction === undefined ? {} : { interaction: input.interaction }) });
  }

  async failed(error: string, aborted: boolean, interaction?: ModelCall['interaction']): Promise<ModelCall> {
    return this.#close({ status: aborted ? 'aborted' : 'failed', error, ...(interaction === undefined ? {} : { interaction }) });
  }

  async #close(patch: Partial<ModelCall> & Pick<ModelCall, 'status'>): Promise<ModelCall> {
    const table = this.#deps.store.table('modelCalls');
    if (this.#closed) {
      const row = await table.get(this.id);
      if (row === undefined) throw new Error(`model call ${this.id} is gone`);
      return row;
    }
    this.#closed = true;
    const now = this.#deps.clock();
    const row = await table.update(this.id, {
      ...patch,
      endedAt: now,
      total: Math.max(0, now - this.#startedAt),
      ...(this.#firstByte === undefined ? {} : { firstByte: this.#firstByte - this.#startedAt }),
    });
    this.#deps.log.info('model.call', { call: row.id, modality: row.modality, model: row.model, status: row.status, cost: row.cost, total: row.total ?? 0, run: row.run ?? null });
    return row;
  }
}

/** Model calls in the hub store (table `modelCalls`). */
export class StoreModelCallLog implements ModelCallLog {
  readonly #deps: ModelCallLogDeps;

  constructor(deps: ModelCallLogDeps) {
    this.#deps = deps;
  }

  async begin(site: CallSiteInfo, queuedAt: number): Promise<OpenModelCall> {
    const startedAt = this.#deps.clock();
    const row: ModelCall = {
      id: mintId('modelCall', this.#deps.random),
      ...compact({
        run: site.run, turn: site.turn, session: site.session, system: site.system, fn: site.fn, purpose: site.purpose, priority: site.priority,
      }),
      modality: site.modality,
      provider: site.provider,
      model: site.model,
      units: emptyUnits(site.modality),
      cost: 0,
      status: 'running',
      sent: 0,
      received: 0,
      queued: Math.max(0, startedAt - queuedAt),
      startedAt,
    };
    await this.#deps.store.table('modelCalls').insert(row);
    return new OpenCall(this.#deps, row.id, startedAt);
  }

  get(id: ModelCallId): Promise<ModelCall | undefined> {
    return this.#deps.store.table('modelCalls').get(id);
  }

  list(query: ModelCallQuery): Promise<Page<ModelCall>> {
    const { cursor, limit, ...filter } = query;
    return this.#deps.store.table('modelCalls').find({
      where: compact(filter), order: [['startedAt', 'desc']], limit: limit ?? PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }),
    });
  }
}
