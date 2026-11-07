/**
 * The seams inside the execution module and what it needs from the rest of the hub. Each concrete piece (executors,
 * the LLM engine, the agent's conversation) is an interface here with classes beside it, so tests swap any of them.
 */
import type { Streamer } from '@aeye/core';
import type { Logger } from '@ayepi/log';
import type {
  FnRecord, IdRandom, Json, LlmMessage, OutcomeWire, Run, RunId, RunInfo, RunRequest, RunSettled, UndoOutcome, Usd,
} from '@harness/core';
import type { HubSettings } from '../boot/env.ts';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import type { ApproverDirectory, SessionService, TurnService } from '../chat/index.ts';
import type { ConfigService, LinkService } from '../link/index.ts';
import type { HubStore } from '../store/index.ts';
import type { ExecutionEnv } from './env.ts';
import type { HubCallContext, HubCallMetadata, LlmCallScope } from './scope.ts';

/** The settings execution reads: the shared queue slice, the default model, and its own. */
export interface ExecutionSettings {
  readonly queue: HubSettings['queueEnv'];
  readonly model: Pick<HubSettings['modelEnv'], 'HARNESS_DEFAULT_MODEL'>;
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
  readonly config: Pick<ConfigService, 'current'>;
  /** Whether a person is active in a session (the global tool timeout only unblocks the agent then). */
  readonly presence: Pick<SessionService, 'active'>;
  /** Where an agent's answer streams, and where a turn is settled. */
  readonly turns: Pick<TurnService, 'begin' | 'stream' | 'finish' | 'settle'>;
  readonly approvers: ApproverDirectory;
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
  control(run: Run, action: 'cancel' | 'pause'): Promise<ControlAnswer>;
  undo(job: UndoJob): Promise<UndoOutcome>;
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

/** Adding LLM spend to the run that made it (and its ancestors' totals). */
export interface RunCosts {
  addCost(run: RunId, cost: Usd): Promise<void>;
}

/** The LLM calls the hub makes: an aeye streamer bound to the hub AI (budgets, rate limits and records on it). */
export interface LlmEngine {
  readonly streamer: Streamer<HubCallContext, HubCallMetadata>;
  /** Embeddings through a provider model; `scope` pays for them. */
  embed(texts: readonly string[], scope?: LlmCallScope): Promise<{ vectors: number[][]; cost: Usd }>;
  models(): Array<{ id: string; name: string }>;
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
