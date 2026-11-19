/**
 * The seams inside the execution module and what it needs from the rest of the hub. Each concrete piece (executors,
 * the LLM engine, the agent's conversation) is an interface here with classes beside it, so tests swap any of them.
 */
import type { DecisionResponse } from '@aeye/ai';
import type { Streamer } from '@aeye/core';
import type { Logger } from '@ayepi/log';
import type {
  ActorId, FnError, FnRecord, IdRandom, InvalidInput, Json, LlmMessage, OutcomeWire, Run, RunId, RunInfo, RunRequest, RunSettled, UndoOutcome, Usd,
  ModelInfo, HubModelInfo, RunControlAction,
} from '@harness/core';
import type { HubSettings } from '../boot/env.ts';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import type { ApproverDirectory, SessionService, TurnService } from '../chat/index.ts';
import type { ConfigService, InstanceRouter, LinkService } from '../link/index.ts';
import type { HubStore } from '../store/index.ts';
import type { AccessService } from '../access/index.ts';
import type { ConnectionService } from '../connections/index.ts';
import type { ExecutionEnv } from './env.ts';
import type { FnMetricsService, ModelCallLog } from '../metrics/index.ts';
import type { ModelRoles } from '../models/index.ts';
import type { DecideCall, EmbedCall, Heard, ImageCall, MadeImage, SpeechCall, Spoken, TranscribeCall } from './media.ts';
import type { HubCallContext, HubCallMetadata } from './scope.ts';

/** The settings execution reads: the shared queue slice, the default model, and its own. */
export interface ExecutionSettings {
  readonly queue: HubSettings['queueEnv'];
  readonly model: Pick<HubSettings['modelEnv'], 'HARNESS_DEFAULT_MODEL' | 'HARNESS_TRANSCRIBE_MODEL'>;
  readonly execution: ExecutionEnv;
}

/** What every execution class can use. */
export interface ExecutionBase {
  readonly settings: ExecutionSettings;
  readonly log: Logger;
  readonly clock: () => number;
  /** The random part of new ids (tests pass a counter). */
  readonly random?: IdRandom | undefined;
  readonly store: HubStore;
  readonly bus: EventBus;
}

/** What execution needs from the other modules, by the interface that provides it. */
export interface ExecutionDeps extends ExecutionBase {
  readonly catalog: Catalog;
  readonly link: Pick<LinkService, 'connection'>;
  /** Which instance of a fleet a system's run goes to, picked once as it is made. */
  readonly instances: Pick<InstanceRouter, 'route'>;
  readonly config: Pick<ConfigService, 'current'>;
  /** Whether a person is active in a session (the global tool timeout only unblocks the agent then). */
  readonly presence: Pick<SessionService, 'active'>;
  /** Where an agent's answer streams, and where a turn is settled. */
  readonly turns: Pick<TurnService, 'begin' | 'stream' | 'finish' | 'settle' | 'track' | 'followUp' | 'suggested'>;
  readonly approvers: ApproverDirectory;
  /** Every model call's record (the metrics module). */
  readonly calls: ModelCallLog;
  /** Fn metrics, fed each settled run. */
  readonly metrics: Pick<FnMetricsService, 'settled'>;
  /** The model roles, for the `chat` role's model when an agent names none. */
  readonly roles: Pick<ModelRoles, 'resolve'>;
  /** What the person a run is for may see and use (a fn they can't is refused as missing). */
  readonly access: Pick<AccessService, 'scope'>;
  /** The credentials a per-person fn's run acts with. */
  readonly connections: Pick<ConnectionService, 'forRun'>;
}

/** One run to execute: the stored run, its fn and the request its executor gets. */
export interface ExecutionJob {
  readonly run: Run;
  readonly fn: FnRecord;
  readonly request: RunRequest;
}

/** A finished run to undo, with the who-and-when it ran with and the undo payload it registered. */
export interface UndoJob {
  readonly run: Run;
  readonly fn: FnRecord;
  readonly info: RunInfo;
  readonly payload: Json;
}

/** Answer of a cancel or pause request. */
export interface ControlAnswer {
  accepted: boolean;
  reason?: string;
}

/**
 * Runs runs of one kind of target: a connected system, the hub's own native fns, or agents. `detached` means the
 * executor settles the run itself later (through `RunSettler`), as the agent loop does across many queued jobs.
 */
export interface RunExecutor {
  execute(job: ExecutionJob, signal: AbortSignal): Promise<OutcomeWire | 'detached'>;
  control(run: Run, action: RunControlAction): Promise<ControlAnswer>;
  /**
   * The hub stopped a run whose deadline passed: end the work it is doing (tell its system, stop its iteration and
   * tool calls). The run service settles the run as failed with `error` itself, so this never settles it.
   */
  stop(run: Run, error: FnError): Promise<void>;
  undo(job: UndoJob): Promise<UndoOutcome>;
  /**
   * What is wrong with a run's args beyond their gin type, before the policies decide it (the hub's fns that hold a
   * value of a type another arg names): the run then settles `invalid-input` and nobody is asked.
   */
  check?(run: Pick<Run, 'id' | 'fn' | 'args'>, actor: ActorId): Promise<InvalidInput | undefined>;
}

/** Settling a run from outside the run worker (the agent loop). */
export interface RunSettler {
  settle(run: RunId, outcome: OutcomeWire): Promise<void>;
}

/** Hearing when runs settle. */
export interface RunEvents {
  /** Called once per run, when it settles. Returns the unsubscribe. */
  onSettled(listener: (run: Run, settled: RunSettled) => void): () => void;
}

/** Adding model spend to the run that made it (and its ancestors' totals), and the tokens its model calls used. */
export interface RunCosts {
  addCost(run: RunId, cost: Usd): Promise<void>;
  addTokens(run: RunId, tokens: number): Promise<void>;
}

/**
 * The model calls the hub makes, every modality on the hub AI (budgets, rate limits and records on it): chat as an
 * aeye streamer, and embeddings, images, transcription and speech as calls. `ctx.call` is the run scope that pays
 * (absent for the hub's own work, named by `ctx.purpose`); `ctx.receipts` hears each call's record and cost.
 */
export interface LlmEngine {
  readonly streamer: Streamer<HubCallContext, HubCallMetadata>;
  embed(input: EmbedCall, ctx: HubCallContext, signal?: AbortSignal): Promise<number[][]>;
  image(input: ImageCall, ctx: HubCallContext, signal?: AbortSignal): Promise<MadeImage[]>;
  transcribe(input: TranscribeCall, ctx: HubCallContext, signal?: AbortSignal): Promise<Heard>;
  speech(input: SpeechCall, ctx: HubCallContext, signal?: AbortSignal): Promise<Spoken>;
  decide(input: DecideCall, ctx: HubCallContext, signal?: AbortSignal): Promise<DecisionResponse>;
  models(): EngineModel[];
}

/**
 * The conversation an agent run continues. A session's agent continues the session's transcript (chat appends each
 * user message to it before the agent runs); any other agent keeps its own on the run.
 */
export interface Conversation {
  messages(): Promise<LlmMessage[]>;
  /** Append messages; returns the index of the first one. */
  append(messages: readonly LlmMessage[]): Promise<number>;
  /** Put tool replies right after the assistant message at `anchor` (before any user message that came in since). */
  answer(anchor: number, replies: readonly LlmMessage[]): Promise<void>;
}

/**
 * A model as the hub's engine knows it: `ModelInfo` plus aeye's tier and output cap when the engine has them, so the
 * hub link's `models` can give systems' aeye what its selection needs (`HubModelInfo`).
 */
export type EngineModel = ModelInfo & Partial<Pick<HubModelInfo, 'tier' | 'maxOutputTokens'>>;
