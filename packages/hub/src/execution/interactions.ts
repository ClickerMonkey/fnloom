/**
 * Saving LLM interactions: every call is stored whole (request, response, usage, cost, timing), opened when it starts
 * streaming and closed when it ends, so the fn tree shows calls live and an aborted call keeps what it streamed.
 */
import {
  mintId, type LlmInteraction, type LlmInteractionId, type LlmRequest, type LlmResponse, type LlmStatus, type LlmUsage, type ModelCallId, type Usd,
} from '@harness/core';
import type { ExecutionBase } from './ports.ts';
import type { LlmCallScope } from './scope.ts';

/** How a call ended. */
export interface InteractionEnd {
  status: Exclude<LlmStatus, 'queued' | 'streaming'>;
  response?: LlmResponse | undefined;
  usage: LlmUsage;
  cost: Usd;
  error?: string | undefined;
  /** Its `ModelCall`. */
  modelCall?: ModelCallId | undefined;
}

/** Opens and closes `LlmInteraction` rows. */
export class InteractionRecorder {
  readonly #deps: Pick<ExecutionBase, 'store' | 'clock' | 'random'>;

  constructor(deps: Pick<ExecutionBase, 'store' | 'clock' | 'random'>) {
    this.#deps = deps;
  }

  /** Save a call that is starting, as `streaming`. */
  async open(scope: LlmCallScope, request: LlmRequest, model: { provider: string; id: string }): Promise<LlmInteractionId> {
    const row: LlmInteraction = {
      id: mintId('llmInteraction', this.#deps.random),
      turn: scope.turn,
      run: scope.run,
      ...(scope.session === undefined ? {} : { session: scope.session }),
      ...(scope.system === undefined ? {} : { system: scope.system }),
      iteration: scope.iteration,
      provider: model.provider,
      model: model.id,
      request,
      cost: 0,
      status: 'streaming',
      priority: scope.priority,
      queuedAt: scope.queuedAt,
      startedAt: this.#deps.clock(),
    };
    await this.#deps.store.table('llmInteractions').insert(row);
    return row.id;
  }

  /** Close a call with how it ended. */
  async close(id: LlmInteractionId, end: InteractionEnd, firstTokenAt: number | undefined): Promise<LlmInteraction> {
    return this.#deps.store.table('llmInteractions').update(id, {
      status: end.status,
      usage: end.usage,
      cost: end.cost,
      endedAt: this.#deps.clock(),
      ...(end.response === undefined ? {} : { response: end.response }),
      ...(end.error === undefined ? {} : { error: end.error }),
      ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
      ...(end.modelCall === undefined ? {} : { modelCall: end.modelCall }),
    });
  }
}
