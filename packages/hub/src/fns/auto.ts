/**
 * The auto mode classifier: in a chat set to `auto`, each call its agent makes above `read` goes to a model the admin
 * chose (the `autoClassifier` hub option), with the fn, what it does, its args and the chat's last messages. The model
 * answers whether the call clearly follows from what the person asked (it goes ahead) or not (the person decides).
 * Without a model, on an error, or past the wait, the person decides: auto mode never lets a call through on a guess.
 * The call is recorded as a model call of the run, like every other.
 */
import { AutoClassifier, flagLine, type ActorId, type AutoClassifierView, type LlmMessage } from '@harness/core';
import type { Logger } from '@ayepi/log';
import { a } from '@aeye/schema';
import { structuredAnswer } from '../models/structured.ts';
import { plainText } from '../chat/turns.ts';
import { messageOf } from '../execution/errors.ts';
import type { LlmGateway } from '../execution/index.ts';
import { pinnedModel } from '../models/pinned.ts';
import type { HubStore } from '../store/index.ts';
import type { FnsTuning } from './env.ts';
import type { AutoModeClassifier, ClassifyInput } from './index.ts';

/** The purpose its model calls are recorded with. */
export const AUTO_CLASSIFIER_PURPOSE = 'auto-mode';

/** What the classifier answers. */
const Verdict = structuredAnswer(a.object({
  allow: a.boolean().describe('Whether it may go ahead without asking.'),
  reason: a.string().describe('One short sentence the person will read.'),
}));

/** What the classifier reads. */
export interface AutoClassifierDeps {
  readonly store: () => HubStore;
  readonly llm: () => Pick<LlmGateway, 'chat'>;
  readonly clock: () => number;
  readonly log: Logger;
  readonly tuning: Pick<FnsTuning, 'HARNESS_AUTO_CLASSIFIER_WAIT'>;
}

/** The instructions the classifier model gets. */
export const CLASSIFIER_INSTRUCTIONS = [
  'You decide whether an AI agent\'s action in a chat may go ahead without asking the person first.',
  'You get the person\'s last messages, then the action: the fn, what it does, whether it reads, writes or deletes, what it creates, updates or removes in the hub (fns, context, ...) when it does, and its args.',
  'Allow it when the action plainly follows from what the person asked and does nothing they would be surprised by.',
  'Ask when it is not clearly asked for, reaches beyond what was asked (other files, other people, other systems), deletes, spends money, sends something to other people, or cannot be undone, or when you are unsure.',
  'You only see actions that write or delete: reads go ahead on their own.',
  'An action may list sensitive files it touches (env files, keys, credentials, gitignored files). You only see these when an admin set their rules to let them through, so a listed file is allowed in general; still, allow touching one only when the person plainly asked for that file or for work that has to change it; otherwise ask.',
  '',
  'Examples:',
  'Person: "add a test for parseDate in src/date.test.ts". Action: fs/write to src/date.test.ts → {"allow": true, "reason": "It writes the test file you asked for."}',
  'Person: "what is in my calendar tomorrow?". Action: google-calendar/delete_event → {"allow": false, "reason": "You asked to look at your calendar, not to delete an event."}',
  'Person: "clean up the build folder". Action: fs/bash with "rm -rf ~" → {"allow": false, "reason": "The command deletes far more than the build folder."}',
  'Person: "rebuild it and keep the log". Action: fs/bash with "npm run build > dist/out.log", Sensitive files: Writes dist/out.log (gitignored: Git ignores it, so it may hold local output or secrets.) → {"allow": true, "reason": "It runs the build you asked for and keeps its log where you said."}',
  'Person: "fix the typo in the README". Action: fs/edit of .env, Sensitive files: Writes .env (env: Env files hold keys and passwords.) → {"allow": false, "reason": "Changing your env file is not part of fixing a typo."}',
].join('\n');

/** The classifier on the hub's options table and LLM gateway. */
export class LlmAutoClassifier implements AutoModeClassifier {
  readonly #deps: AutoClassifierDeps;

  constructor(deps: AutoClassifierDeps) {
    this.#deps = deps;
  }

  async setting(): Promise<AutoClassifierView> {
    const row = await this.#deps.store().table('hubOptions').get('autoClassifier');
    return row?.key !== 'autoClassifier' ? { value: AutoClassifier.parse({}) } : { value: row.value, setBy: row.setBy, updatedAt: row.updatedAt };
  }

  async set(value: AutoClassifier, by: ActorId): Promise<AutoClassifierView> {
    const row = { key: 'autoClassifier' as const, value, setBy: by, updatedAt: this.#deps.clock() };
    await this.#deps.store().table('hubOptions').put(row);
    this.#deps.log.info('fns.auto-classifier.set', { model: value.model === undefined ? null : JSON.stringify(value.model.model), by });
    return { value: row.value, setBy: row.setBy, updatedAt: row.updatedAt };
  }

  async classify(input: ClassifyInput): Promise<{ readonly allow: boolean; readonly reason: string }> {
    const setting = (await this.setting()).value;
    if (setting.model === undefined) return { allow: false, reason: 'No auto mode model is set, so you decide.' };
    try {
      const messages: LlmMessage[] = [
        { role: 'system', content: CLASSIFIER_INSTRUCTIONS },
        { role: 'user', content: await this.#ask(input, setting.messages) },
      ];
      const answer = await this.#deps.llm().chat(
        { request: { messages, temperature: 0, responseFormat: Verdict.responseFormat }, ...(await pinnedModel(this.#deps.store(), setting.model)), priority: 'interactive' },
        { purpose: AUTO_CLASSIFIER_PURPOSE, run: input.run }, AbortSignal.timeout(this.#deps.tuning.HARNESS_AUTO_CLASSIFIER_WAIT),
      );
      const verdict = Verdict.read(answer.value);
      if (verdict === undefined) return { allow: false, reason: 'The auto mode model gave no clear answer, so you decide.' };
      this.#deps.log.info('fns.auto-classifier.decided', { run: input.run, fn: input.fn.name, allow: verdict.allow, call: answer.call });
      return verdict;
    } catch (error) {
      this.#deps.log.warn('fns.auto-classifier.failed', { run: input.run, fn: input.fn.name, error: messageOf(error) });
      return { allow: false, reason: 'The auto mode model could not be asked, so you decide.' };
    }
  }

  /** The question: the chat's last messages, then the action. */
  async #ask(input: Omit<ClassifyInput, 'run'>, count: number): Promise<string> {
    const recent = count < 1 ? [] : (await this.#deps.store().table('messages').find({ where: { session: input.session.id }, order: [['createdAt', 'desc']], limit: count })).items.reverse();
    const lines = recent.map((message) => `${message.role === 'user' ? 'Person' : 'Agent'}: ${plainText(message.parts)}`).filter((line) => !line.endsWith(': '));
    return [
      'Last messages:', ...(lines.length === 0 ? ['(none)'] : lines), '',
      `Action: ${input.fn.name} (${input.mode}) — ${input.fn.decl.description}`,
      ...(input.changes === undefined ? [] : [`Changes in the hub: ${input.changes}`]),
      ...(input.flags === undefined ? [] : ['Sensitive files:', ...input.flags.map((flag) => `- ${flagLine(flag)}`)]),
      `Args: ${JSON.stringify(input.args)}`,
    ].join('\n');
  }
}
