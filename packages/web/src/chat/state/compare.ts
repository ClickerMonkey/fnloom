/**
 * One A/B compare as the web follows it: the compared turn's view (each variant's answer, spend, tokens, time and the
 * approvals it waits on), kept live while it is open. It listens to the chat (which hears when the compare changes)
 * and to each variant's fork (its streaming answer, its runs and approvals), asking for the view again once changes
 * pause; streamed text shows at once. Choosing a variant and answering a variant's approvals go through here.
 */
import type { ApprovalId, ClientInfo, CompareVariantInput, CompareView, Json, MessageId, Remember, SessionEvent, SessionId, TurnId, VariantIndex } from '@harness/core';
import { shallowRef } from 'vue';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import { problemText } from '../../state/problems.ts';
import { upsertMessage } from '../logic/thread.ts';
import type { ChatApi, SessionEvents } from '../api.ts';
import type { ComposerStore } from './composer.ts';
import type { ThreadStore } from './thread.ts';

/**
 * Send what the composer holds as an A/B compare: the box empties at once, and a failed send puts everything back,
 * as a plain send does (`sendDraft`). The compared turn, to open.
 */
export async function sendCompare(
  api: Pick<ChatApi, 'compare'>, thread: Pick<ThreadStore, 'id' | 'messages'>, composer: ComposerStore, variants: readonly CompareVariantInput[], client: ClientInfo,
): Promise<Outcome<TurnId>> {
  const outgoing = composer.outgoing();
  if (outgoing === undefined) { return { ok: false, problem: 'Write the message to compare first.' }; }
  const snapshot = composer.snapshot();
  composer.clear('keep');
  try {
    const sent = await api.compare.call({ session: thread.id, parts: [...outgoing.parts], variants: [...variants], client });
    thread.messages.value = upsertMessage(thread.messages.value, sent.message);
    composer.uploads.clear();
    return { ok: true, value: sent.turn };
  } catch (error) {
    composer.restore(snapshot);
    return { ok: false, problem: problemText(error, 'Couldn’t start the compare. Your message is back in the box.') };
  }
}

/** How long changes pause before the view is asked for again (ms). */
export const COMPARE_REFRESH = 300;

/** What streamed into a variant's answer since the view was last read, by message. */
export interface StreamedText {
  readonly text: string;
  readonly reasoning: string;
}

/** What a compare store uses. */
export interface CompareDeps {
  readonly api: Pick<ChatApi, 'compareView' | 'chooseVariant' | 'approve'>;
  readonly events: SessionEvents;
  /** Wait before asking again (tests pass one that runs at once). */
  readonly later?: (run: () => void, ms: number) => () => void;
}

/** Waits with the browser's timer. */
function timer(run: () => void, ms: number): () => void {
  const id = setTimeout(run, ms);
  return () => { clearTimeout(id); };
}

/** A compared turn, live while open. */
export class CompareStore {
  readonly view = new Loaded<CompareView>();
  /** What each variant's answer streamed since the view was read. */
  readonly streamed = shallowRef<ReadonlyMap<MessageId, StreamedText>>(new Map());
  readonly choosing = new Task();
  readonly deciding = new Task();
  readonly turn: TurnId;
  readonly #session: SessionId;
  readonly #deps: CompareDeps;
  readonly #stops = new Map<SessionId, () => void>();
  #pending: (() => void) | undefined;

  constructor(deps: CompareDeps, session: SessionId, turn: TurnId) {
    this.#deps = deps;
    this.#session = session;
    this.turn = turn;
  }

  /** Read the compare and follow it: the chat, and each variant's fork. */
  async open(): Promise<void> {
    this.#listen(this.#session);
    await this.view.load(() => this.#deps.api.compareView.call({ turn: this.turn }), 'Couldn’t load the compare.');
    for (const variant of this.view.value.value?.variants ?? []) { this.#listen(variant.session); }
  }

  /** Stop following it. */
  close(): void {
    for (const stop of this.#stops.values()) { stop(); }
    this.#stops.clear();
    this.#pending?.();
    this.#pending = undefined;
  }

  /** Choose a variant; `adopt` makes its settings the chat's own too. */
  async choose(variant: VariantIndex, adopt: boolean): Promise<Outcome<CompareView>> {
    const done = await this.choosing.run(() => this.#deps.api.chooseVariant.call({ turn: this.turn, variant, adopt }), 'Couldn’t use that answer.');
    if (done.ok) { this.view.set(done.value); }
    return done;
  }

  /** Answer one of a variant's approvals; the view shows it gone once the hub says so. */
  async decide(approval: ApprovalId, approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<boolean> {
    const done = await this.deciding.run(() => this.#deps.api.approve.call({ approval, approve, remember, ...(reason === '' ? {} : { reason }), ...(answer === undefined ? {} : { answer }) }), 'Couldn’t answer that.');
    if (done.ok) { this.#refresh(); }
    return done.ok;
  }

  #listen(session: SessionId): void {
    if (this.#stops.has(session)) { return; }
    this.#stops.set(session, this.#deps.events(session, (event) => { this.#on(session, event); }));
  }

  #on(session: SessionId, event: SessionEvent): void {
    switch (event.type) {
      case 'compare': if (event.turn === this.turn) { this.#refresh(); } return;
      case 'token': case 'reasoning': {
        if (session === this.#session) { return; }
        const streamed = new Map(this.streamed.value);
        const known = streamed.get(event.message) ?? { text: '', reasoning: '' };
        streamed.set(event.message, event.type === 'token' ? { ...known, text: known.text + event.text } : { ...known, reasoning: known.reasoning + event.text });
        this.streamed.value = streamed;
        return;
      }
      // a fork's answer, runs and approvals change what the view shows; the chat's own only matter through `compare`
      case 'message': case 'approval': case 'run': if (session !== this.#session) { this.#refresh(); } return;
      case 'controls': case 'state': case 'delivery': case 'handler': case 'budget': case 'presence': case 'session': return;
    }
  }

  /** Ask for the view again once changes pause; what streamed is then in it. */
  #refresh(): void {
    this.#pending?.();
    this.#pending = (this.#deps.later ?? timer)(() => {
      this.#pending = undefined;
      void this.view.load(() => this.#deps.api.compareView.call({ turn: this.turn }), 'Couldn’t load the compare.', true).then(() => { this.streamed.value = new Map(); });
    }, COMPARE_REFRESH);
  }
}
