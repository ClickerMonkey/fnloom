/**
 * What a chat's fn mode lets its agent run. `none` runs nothing; `read`, `write` and `delete` run fns up to that mode
 * (a fn's mode is worked out deeply, `FnFacts`); `auto` runs reads and asks the classifier about the rest. A session
 * with no fn mode set leaves it all to the policies, as before.
 */
import type { FnRecord, Json, RunId, Session } from '@harness/core';
import { MODE_RANK, type AutoModeClassifier, type FnFactsService, type FnModeGate, type ModeVerdict } from './index.ts';

/** The words for what each mode allows. */
const ALLOWS = { read: 'only reads', write: 'reads and writes, but not deletes', delete: 'everything' } as const;

/** The gate over the facts and the classifier. */
export class SessionModeGate implements FnModeGate {
  readonly #facts: () => Pick<FnFactsService, 'modes'>;
  readonly #classifier: () => Pick<AutoModeClassifier, 'classify'>;

  constructor(facts: () => Pick<FnFactsService, 'modes'>, classifier: () => Pick<AutoModeClassifier, 'classify'>) {
    this.#facts = facts;
    this.#classifier = classifier;
  }

  async check(input: { readonly session: Session; readonly fn: FnRecord; readonly args: Json; readonly run: RunId }): Promise<ModeVerdict> {
    const chat = input.session.fnMode;
    if (chat === undefined) return { effect: 'pass' };
    if (chat === 'none') return { effect: 'refuse', reason: 'This chat is set to use no fns. Answer without them, or ask the person to change the chat\'s mode.' };
    const mode = (await this.#facts().modes([input.fn.name])).get(input.fn.name) ?? 'write';
    if (chat === 'auto') {
      // a fn that always asks (an install, a schema change) is never decided by the classifier: its approver answers
      if (mode === 'read' || input.fn.decl.approval !== undefined) return { effect: 'pass' };
      const verdict = await this.#classifier().classify({ session: input.session, fn: input.fn, mode, args: input.args, run: input.run });
      return verdict.allow ? { effect: 'allow', reason: verdict.reason } : { effect: 'ask', reason: verdict.reason };
    }
    if (MODE_RANK[mode] <= MODE_RANK[chat]) return { effect: 'pass' };
    return { effect: 'refuse', reason: `This chat is set to ${chat} mode, which allows ${ALLOWS[chat]}; ${input.fn.name} ${mode === 'delete' ? 'deletes' : 'writes'}. Tell the person what you would do, or ask them to change the chat's mode.` };
  }
}
