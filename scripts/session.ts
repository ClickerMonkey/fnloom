/**
 * Driving one chat session from a script (the e2e tests and the UI test fixtures): a live recorder of its events that
 * waits for the one expected (`SessionWatch`), an approver that says yes to its approvals and confirmations while some
 * work runs, and `ask`, which sends a message and waits for the agent's finished answer.
 */
import { BoolType } from '@aeye/gin';
import type { Approval, ChatMessage, ClientInfo, HandlerCall, RunStatus, RunUpdate, SessionEvent, SessionId, TurnId } from '@harness/core';
import type { SignedIn } from './hub-client.ts';

/** The browser facts a message carries. */
export function clientInfo(): ClientInfo {
  return { timeZone: 'America/New_York', locale: 'en-US', now: Date.now() };
}

/** A run update's status, when it is a status update. */
export function statusOf(update: RunUpdate): RunStatus | undefined {
  return update.type === 'status' ? update.status : undefined;
}

/** Whether a run update says the run has finished (done or failed). */
export function finished(update: RunUpdate): boolean {
  const status = statusOf(update);
  return status === 'done' || status === 'failed';
}

/** A session event of one type. */
export type EventOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;

/** Records every event of one session from the moment it is made, and waits for the ones a caller expects. */
export class SessionWatch {
  readonly events: SessionEvent[] = [];
  readonly session: SessionId;
  readonly #stop: () => void;
  readonly #waiters = new Set<() => void>();

  constructor(client: SignedIn, session: SessionId) {
    this.session = session;
    this.#stop = client.hub.on('session', { session }, (event) => {
      this.events.push(event);
      for (const wake of this.#waiters) { wake(); }
    });
  }

  /** The events of one type so far. */
  of<T extends SessionEvent['type']>(type: T): Array<EventOf<T>> {
    return this.events.filter((event): event is EventOf<T> => event.type === type);
  }

  /** Wait for the first event of a type that matches, seen before or after the call. */
  next<T extends SessionEvent['type']>(type: T, match: (event: EventOf<T>) => boolean, timeout: number): Promise<EventOf<T>> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const found = this.of(type).find(match);
        if (found === undefined) { return false; }
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve(found);
        return true;
      };
      const wake = (): void => { check(); };
      const timer = setTimeout(() => {
        this.#waiters.delete(wake);
        reject(new Error(`no ${type} event matched within ${timeout}ms; saw ${this.events.map((e) => e.type).join(', ')}`));
      }, timeout);
      if (!check()) { this.#waiters.add(wake); }
    });
  }

  stop(): void {
    this.#stop();
  }
}

/**
 * Says yes for a person while some work runs: approves a session's approvals, and answers "yes" to the yes/no questions
 * its runs ask a person (such as the shell's confirmation of a command outside the safe list), each once.
 */
export class Approver {
  /** Every approval it has answered, oldest first. */
  readonly answered: Approval[] = [];
  /** Every yes/no question it has answered, oldest first. */
  readonly confirmed: HandlerCall[] = [];
  readonly #seen = new Set<string>();
  readonly #client: SignedIn;
  readonly #watch: SessionWatch;

  constructor(client: SignedIn, watch: SessionWatch) {
    this.#client = client;
    this.#watch = watch;
  }

  /** Answer approvals while `work` runs; returns its result and the approvals answered meanwhile. */
  async during<T>(work: Promise<T>): Promise<{ result: T; approvals: Approval[] }> {
    const from = this.answered.length;
    const state = { done: false };
    const loop = (async () => {
      while (!state.done) {
        for (const { approval } of this.#watch.of('approval')) {
          if (approval.status !== 'pending' || this.#seen.has(approval.id)) { continue; }
          this.#seen.add(approval.id);
          this.answered.push(approval);
          await this.#client.hub.call('approve', { approval: approval.id, approve: true, remember: 'once' });
        }
        for (const { call } of this.#watch.of('handler')) {
          if (call.status !== 'pending' || !('user' in call.answerer) || call.decl.returns.name !== BoolType.NAME || this.#seen.has(call.id)) { continue; }
          this.#seen.add(call.id);
          this.confirmed.push(call);
          await this.#client.hub.call('answer', { call: call.id, value: true });
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();
    try {
      return { result: await work, approvals: this.answered.slice(from) };
    } finally {
      state.done = true;
      await loop;
    }
  }
}

/** Send a message and wait for the agent's finished answer to it. */
export async function ask(client: SignedIn, watch: SessionWatch, text: string, timeout: number): Promise<{ turn: TurnId; answer: ChatMessage }> {
  const sent = await client.hub.call('send', { session: watch.session, parts: [{ type: 'text', text }], client: clientInfo() });
  const answered = await watch.next('message', (e) => e.message.turn === sent.turn && e.message.role === 'assistant' && e.message.status !== 'streaming', timeout);
  return { turn: sent.turn, answer: answered.message };
}

/** The plain text of a message. */
export function textOf(message: ChatMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}
