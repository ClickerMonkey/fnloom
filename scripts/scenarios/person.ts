/**
 * The simulated person: a cheaper LLM than the chat's, from another family (HARNESS_SCENARIOS_PERSON_MODEL, called on OpenRouter, not through the hub) playing Alex Parker, a non-technical
 * parent (or, for steps sent as another person of the household, Sara or Emma from `MEMBERS`). It sees what a person sees in the chat (the agent's words, the forms it shows, the cards asking for a yes
 * or no), never the tool calls. It answers briefly and plainly, says what it knows only when asked, says when it is
 * done or would give up, fills forms, and decides approval cards when its case says to. It keeps its own cost.
 */
import { z } from 'zod';
import { FAMILY, FixtureFile, MEMBERS, type Case, type Member, type Step } from './cases.ts';
import type { ChatTurn, OpenRouter } from './openrouter.ts';

/** What the person sees of the chat, oldest first. */
export interface Seen {
  readonly who: 'me' | 'assistant' | 'form' | 'card';
  readonly text: string;
}

/** The person's next move after the agent's answer. */
export const NextMove = z.object({
  action: z.enum(['reply', 'done', 'give-up']),
  /** What they type, for `reply`. */
  message: z.string().optional(),
  /** Files they attach to the reply (only ones they have). */
  attach: z.array(z.string()).optional(),
  /** Why, in a sentence (for the report; the agent never sees it). */
  reason: z.string(),
});
export type NextMove = z.infer<typeof NextMove>;

const Decision = z.object({ approve: z.boolean(), reason: z.string() });

/** One field of a form, as the person is shown it. */
export interface FieldAsk {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly required: boolean;
  /** The choices it takes, exactly as the form shows them (a choice field). */
  readonly options?: readonly string[];
  /** Whether several of `options` may be picked (a list of choices: a JSON array). */
  readonly multiple?: boolean;
}

/** How everyone writes, after who they are. */
const MANNER = [
  'Answer what you are asked using what you know. Never volunteer facts you weren\'t asked for, and never use technical words.',
  'If you are asked something you don\'t know, say so or guess the way a normal person would.',
  'You can\'t see how the app works inside; you only see its answers, its forms and its yes/no cards.',
] as const;

/** Who the person is: Alex (the family lines and how a busy parent types), or a member of the household. */
function roleOf(member: Member | undefined): string {
  if (member === undefined) { return [...FAMILY, 'Write like a busy parent typing on a phone: short, plain, friendly, sometimes a bit vague. One to three sentences.', ...MANNER].join('\n'); }
  return [...MEMBERS[member].who, 'Keep each message short: one to three sentences.', ...MANNER].join('\n');
}

/** A step's person when it is sent as a member: who, and the step (their facts and wants). */
export interface MemberPart {
  readonly who: Member;
  readonly step: Step;
}

/** The person of one case (Alex), or of the case's steps sent as one member. */
export class Person {
  #cost = 0;
  readonly #router: OpenRouter;
  readonly #model: string;
  readonly #case: Case;
  readonly #member: MemberPart | undefined;

  constructor(router: OpenRouter, model: string, played: Case, member?: MemberPart) {
    this.#router = router;
    this.#model = model;
    this.#case = played;
    this.#member = member;
  }

  /** Files this person has (a member has none). */
  #files(): readonly FixtureFile[] {
    return this.#member === undefined ? this.#case.canSend ?? [] : [];
  }

  /** What the person's model calls have cost so far (USD). */
  get cost(): number {
    return this.#cost;
  }

  #system(): string {
    const files = this.#files();
    const wants = this.#member === undefined ? this.#case.wants : this.#member.step.wants ?? this.#member.step.say;
    const facts = this.#member === undefined ? this.#case.facts : this.#member.step.facts ?? [];
    return [
      roleOf(this.#member?.who),
      `What you are after this time: ${wants}`,
      facts.length === 0 ? 'Nothing else in particular.' : `What you know (say it only when asked):\n${facts.map((fact) => `- ${fact}`).join('\n')}`,
      files.length === 0 ? 'You have no files to send.' : `Files you have and can attach if the assistant asks for them: ${files.join(', ')}.`,
    ].join('\n\n');
  }

  async #ask<S extends z.ZodType>(schema: S, task: string, seen: readonly Seen[]): Promise<z.infer<S>> {
    const messages: ChatTurn[] = [
      { role: 'system', content: this.#system() },
      { role: 'user', content: `The chat so far:\n\n${transcriptOf(seen)}\n\n${task}` },
    ];
    const { value, cost } = await this.#router.json(this.#model, schema, messages);
    this.#cost += cost;
    return value;
  }

  /** The next move after the agent answered; `left` is how many more messages the person will send. */
  async next(seen: readonly Seen[], left: number): Promise<NextMove & { attach: FixtureFile[] }> {
    const files = this.#files();
    const move = await this.#ask(NextMove, [
      'Decide your next move. Answer with a JSON object: {"action": "reply" | "done" | "give-up", "message": "what you type (for reply)", "attach": [file names, only if asked for a file]' + (files.length === 0 ? '' : ` from ${files.join(', ')}`) + ', "reason": "why, in a sentence"}.',
      '"done": you got what you were after, or it plainly can\'t be done and the assistant was honest about it. "give-up": it keeps missing the point or you\'ve lost patience. Otherwise "reply": answer its questions, or nudge it toward what you want.',
      `You will send at most ${left} more message${left === 1 ? '' : 's'}.`,
    ].join('\n'), seen);
    const attach = (move.attach ?? []).flatMap((name) => {
      const file = FixtureFile.safeParse(name);
      return file.success && files.includes(file.data) ? [file.data] : [];
    });
    return { ...move, attach };
  }

  /** Fill a form the agent showed: a value per field key. `problem` is what the form said was wrong last time. */
  async fill(seen: readonly Seen[], title: string, fields: readonly FieldAsk[], problem?: string): Promise<Record<string, unknown>> {
    const shape = fields.map((field) => `- "${field.key}" (${field.label}; ${field.kind}${field.options === undefined ? '' : `: ${field.multiple === true ? 'a JSON array of one or more of' : 'exactly one of'} ${field.options.map((o) => JSON.stringify(o)).join(', ')}`}${field.required ? '' : '; optional'})`).join('\n');
    const answer = await this.#ask(z.object({ values: z.record(z.string(), z.unknown()) }), [
      `The assistant shows you a form, "${title}", with these fields:\n${shape}`,
      problem === undefined ? '' : `Last time the form said: ${problem}`,
      'Fill it in as you would. Dates are YYYY-MM-DD, numbers plain numbers, yes/no true or false, lists JSON arrays, a choice one of its options written as shown. Leave out optional fields you have nothing for.',
      'Answer with a JSON object: {"values": {"<field key>": <value>, ...}}.',
    ].join('\n'), seen);
    return answer.values;
  }

  /** Decide an approval card (when the case leaves it to the person). */
  async decide(seen: readonly Seen[], card: string): Promise<{ approve: boolean; reason: string }> {
    return this.#ask(Decision, `The assistant now shows a card asking for your yes or no:\n${card}\n\nDecide as you would. Answer with a JSON object: {"approve": true | false, "reason": "why, in a sentence"}.`, seen);
  }

  /** Answer a question a run asks directly, as JSON of the asked shape. */
  async answer(seen: readonly Seen[], question: string, shape: string): Promise<unknown> {
    const answer = await this.#ask(z.object({ value: z.unknown() }), `The assistant asks you directly: ${question}\nThe answer's shape: ${shape}\nAnswer with a JSON object: {"value": <your answer>}.`, seen);
    return answer.value;
  }
}

/** What the person has seen, as plain lines. */
export function transcriptOf(seen: readonly Seen[]): string {
  const who = { me: 'You', assistant: 'Assistant', form: 'Form shown', card: 'Yes/no card' } as const;
  return seen.length === 0 ? '(nothing yet)' : seen.map((line) => `${who[line.who]}: ${line.text}`).join('\n\n');
}
