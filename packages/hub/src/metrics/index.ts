/**
 * The metrics module (hub-platform lane): the record of every model call of every modality, and fn metrics.
 *
 * - `ModelCallLog`: every call the hub makes to a model, for chat (the LLM gateway, with its `LlmInteraction`) and
 *   every other modality (`ModelGateway`: embeddings, images, transcription, speech), is one `ModelCall`: modality,
 *   provider, model, units, cost, queue wait, time to first byte, total time, bytes, attributed to its run (or, for
 *   the hub's own work, its purpose). Its ledger line points at it.
 * - `FnMetricsService`: when a run settles, its outcome (`done`, `invalid-input`, `failed`, `cancelled`), queue,
 *   approval and run times, cost, tokens, retries and model calls go into its fn's day (`FnMetricsDay`); rollups over
 *   days give percentiles from the histograms. `FnRecord.stats` is kept from the same numbers.
 */
import type { FnMetrics, FnMetricsDay, FnMetricsQuery, Modality, ModelCall, ModelCallId, ModelCallQuery, ModelUnits, Page, Priority, QualifiedName, Run, RunId, SessionId, SystemName, TurnId, Usd } from '@harness/core';

/** Who and what a model call is for. */
export interface CallSiteInfo {
  readonly modality: Modality;
  readonly provider: string;
  readonly model: string;
  readonly run?: RunId;
  readonly turn?: TurnId;
  readonly session?: SessionId;
  readonly system?: SystemName;
  readonly fn?: QualifiedName;
  readonly purpose?: string;
  readonly priority?: Priority;
}

/** A model call in progress: finish it once, with what it used. */
export interface OpenModelCall {
  readonly id: ModelCallId;
  /** The provider started answering (its first byte or chunk). */
  firstByte(): void;
  done(input: { units: ModelUnits; cost: Usd; sent: number; received: number; interaction?: ModelCall['interaction'] }): Promise<ModelCall>;
  failed(error: string, aborted: boolean): Promise<ModelCall>;
}

/** The record of every model call. */
export interface ModelCallLog {
  /** Open a record when a call starts (after its queue wait, which is measured from `queuedAt`). */
  begin(site: CallSiteInfo, queuedAt: number): Promise<OpenModelCall>;
  get(id: ModelCallId): Promise<ModelCall | undefined>;
  list(query: ModelCallQuery): Promise<Page<ModelCall>>;
}

/** Fn metrics. */
export interface FnMetricsService {
  /** Fold a settled run into its fn's day (idempotent by run id). */
  settled(run: Run): Promise<void>;
  metrics(query: FnMetricsQuery): Promise<FnMetrics[]>;
  days(fn: QualifiedName, days: number): Promise<FnMetricsDay[]>;
}

/** The metrics module's services (`HubServices.metrics`). */
export interface MetricsServices {
  readonly calls: ModelCallLog;
  readonly fns: FnMetricsService;
}
