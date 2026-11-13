/**
 * Questions a server asks during a tool call (MCP `elicitation/create`). Each becomes a proposed run of
 * `answer_elicitation` under the call's run, with the requested form as its `ask`: the person fills it on the approval
 * card. Approving runs `answer_elicitation` with the answer (`answer`), which the call's waiting question gets as
 * `accept`; declining settles that run cancelled (`settled`), which is a `decline`; a call that ends first `cancel`s.
 * Waiting questions are this process's state: on a restart they are gone, and the call they belonged to failed.
 */
import { randomUUID } from 'node:crypto';
import { McpElicitResult, type McpElicitRequest } from '@ayepi/mcp';
import { Json, type RunId, type RunStatus } from '@harness/core';
import type { Proposals } from '@harness/sdk';
import { mcp, type ElicitationReply } from '../shared/index.ts';
import { ginOfJsonSchema } from './schema.ts';

/** What asking needs of the call's run: proposing under it, and its end. */
export interface AskingRun extends Proposals {
  readonly signal: AbortSignal;
}

interface Waiting {
  readonly resolve: (answer: McpElicitResult) => void;
  run?: RunId;
}

/** Run statuses that end a proposed answer without an answer. */
const UNANSWERED: ReadonlySet<RunStatus> = new Set(['cancelled', 'failed', 'invalid-input', 'undone']);

/** The questions waiting for a person, by id. */
export class Elicitations {
  readonly #waiting = new Map<string, Waiting>();
  readonly #label: string;

  constructor(label: string) {
    this.#label = label;
  }

  /** How many are waiting. */
  get size(): number { return this.#waiting.size; }

  /** Ask the call's person; resolves with their answer, a decline, or `cancel` when the call ends first. */
  async ask(request: McpElicitRequest, run: AskingRun): Promise<McpElicitResult> {
    if (run.signal.aborted) { return { action: 'cancel' }; }
    const id = randomUUID();
    const form = ginOfJsonSchema(Json.parse(request.requestedSchema), { object: true });
    let waiting: Waiting | undefined;
    const answered = new Promise<McpElicitResult>((resolve) => {
      waiting = { resolve };
      this.#waiting.set(id, waiting);
    });
    const done = (answer: McpElicitResult): void => { this.#finish(id, answer); };
    const onAbort = (): void => { done({ action: 'cancel' }); };
    run.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const proposed = await run.propose(mcp.fns.answer_elicitation, { request: id }, {
        key: `elicitation:${id}`,
        approver: 'person',
        preview: { title: `${this.#label} asks: ${request.message}`.slice(0, 200), parts: [{ type: 'text', text: request.message }], irreversible: false },
        ask: { type: form.def, into: 'content' },
      });
      if (waiting !== undefined) { waiting.run = proposed.run; }
    } catch (error) {
      done({ action: 'cancel' });
      throw error;
    }
    try {
      return await answered;
    } finally {
      run.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The approved `answer_elicitation` run: hand its answer to the waiting question. False when none waits, or when
   * `run` is not the run proposed for it (only the approved proposal answers; a direct call never does).
   */
  answer(reply: ElicitationReply, run: RunId): boolean {
    if (this.#waiting.get(reply.request)?.run !== run) { return false; }
    // the hub checked the answer against the form's type; a value MCP can't carry (a nested object) is a cancel
    const answer = McpElicitResult.safeParse({ action: 'accept', content: reply.content ?? {} });
    return this.#finish(reply.request, answer.success ? answer.data : { action: 'cancel' });
  }

  /** A proposed run settled: one that ended without running (declined) is a decline. */
  settled(run: RunId, status: RunStatus): void {
    if (!UNANSWERED.has(status)) { return; }
    for (const [id, waiting] of this.#waiting) {
      if (waiting.run === run) { this.#finish(id, { action: 'decline' }); }
    }
  }

  /** Cancel every waiting question (the instance is stopping). */
  cancelAll(): void {
    for (const id of [...this.#waiting.keys()]) { this.#finish(id, { action: 'cancel' }); }
  }

  #finish(id: string, answer: McpElicitResult): boolean {
    const waiting = this.#waiting.get(id);
    if (waiting === undefined) { return false; }
    this.#waiting.delete(id);
    waiting.resolve(answer);
    return true;
  }
}
