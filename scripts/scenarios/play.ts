/**
 * Playing one case on a repetition's stack, as its own freshly made person: open a chat, send each step as written
 * (with its files, uploaded as the composer does), wait for the agent's turn to settle, and let the simulated person
 * carry on: fill the forms the agent shows, answer its questions, decide its approval cards, until they're done, give
 * up, or run out of messages. Then the whole case is read back from the hub (messages, each turn's run tree, every
 * run's args and outcome, the model calls) into a `CaseRecord`.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isSettled, Json, type Approval, type ChatMessage, type HandlerCall, type OutgoingPart, type Run, type RunId, type SessionId, type TreeNode, type TurnId } from '@harness/core';
import { settle, waitFor, type SignedIn } from '../hub-client.ts';
import { clientInfo, SessionWatch, uploadBytes } from '../session.ts';
import { answerFor, askedOf, checkAnswers, controlOf } from '../../systems/input/client/form.ts';
import { fieldsOf } from '../../systems/input/shared/forms.ts';
import type { AskedValue } from '../../systems/input/shared/index.ts';
import type { Case, FixtureFile, Step } from './cases.ts';
import { hardChecks, toolReplyFailed } from './checks.ts';
import { FIXTURES } from './fixtures/make.ts';
import type { OpenRouter } from './openrouter.ts';
import { Person, type FieldAsk, type Seen } from './person.ts';
import type { CaseRecord, Ending, Entry, ToolRun } from './records.ts';
import { FIXTURES_DIR, viewBase, type Rep } from './rep.ts';
import { clip } from './transcript.ts';

/** The most messages a person sends after a case's scripted steps (form answers count). */
export const MAX_PERSON_TURNS = 6;

/** What playing a case needs. */
export interface PlayContext {
  readonly rep: Rep;
  readonly iteration: string;
  readonly repNumber: number;
  readonly router: OpenRouter;
  readonly personModel: string;
  readonly turnTimeout: number;
  readonly viewPort: number;
  readonly log: (line: string) => void;
}

/** The plain text of a message's text parts. */
function textOf(message: ChatMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('').trim();
}

/** Every node of a tree with its depth, depth first. */
function nodesOf(node: TreeNode, depth = 0): Array<{ node: TreeNode; depth: number }> {
  return [{ node, depth }, ...node.children.flatMap((child) => nodesOf(child, depth + 1))];
}

/** An approval card as the person reads it. */
function cardText(approval: Approval): string {
  const preview = approval.preview;
  const parts = preview?.parts.map((part) => clip(JSON.stringify(part), 600)).join('\n') ?? '';
  return [preview?.title ?? `Run ${approval.fn}?`, parts, preview?.irreversible === true ? '(This can\'t be undone.)' : ''].filter((line) => line !== '').join('\n');
}

/** A form's fields as the person is shown them. */
function fieldAsks(form: AskedValue['form']): FieldAsk[] {
  return fieldsOf(form.type).map((field) => {
    const control = controlOf(field.type);
    const kind = control.control === 'number' ? `number${control.min === undefined ? '' : ` from ${control.min}`}${control.max === undefined ? '' : ` up to ${control.max}`}` : control.control;
    return { key: field.key, label: field.label, kind, required: field.required, ...(control.control === 'choice' ? { options: control.options } : {}) };
  });
}

/** One chat the case opened, with its live recorder. */
interface Chat {
  readonly id: SessionId;
  readonly watch: SessionWatch;
}

/** Play one case; never throws (what went wrong goes in the record). */
export async function playCase(ctx: PlayContext, played: Case): Promise<CaseRecord> {
  const started = Date.now();
  const errors: string[] = [];
  const { client, credentials } = await ctx.rep.person(played.id);
  const person = new Person(ctx.router, ctx.personModel, played);
  const seen: Seen[] = [];
  const chats: Chat[] = [];
  const turns: TurnId[] = [];
  /** Approvals answered, by run: what the person said. */
  const decisions = new Map<RunId, NonNullable<ToolRun['approval']>>();
  const questions: Array<Extract<Entry, { type: 'question' }>> = [];
  const answeredForms = new Set<RunId>();
  const handled = new Set<string>();
  let personTurns = 0;
  let ending: Ending | undefined;
  const state = { live: true };

  const decideApproval = async (approval: Approval): Promise<void> => {
    const card = cardText(approval);
    const stance = played.approvals ?? 'yes';
    const decided = stance === 'person' ? await person.decide(seen, card) : { approve: stance === 'yes', reason: stance === 'yes' ? 'says yes to every card' : 'says no to every card' };
    let answer: Json | undefined;
    if (decided.approve && approval.ask !== undefined) {
      const form = { title: approval.preview?.title ?? approval.fn, description: '', type: approval.ask.type };
      const values = await person.fill(seen, form.title, fieldAsks(form));
      const checked = checkAnswers(approval.ask.type, jsonValues(values));
      if ('value' in checked) { answer = checked.value; }
    }
    await client.hub.call('approve', { approval: approval.id, approve: decided.approve, remember: 'once', ...(decided.approve ? {} : { reason: decided.reason }), ...(answer === undefined ? {} : { answer }) });
    decisions.set(approval.run, { title: approval.preview?.title ?? approval.fn, decision: decided.approve ? 'approved' : 'denied', reason: decided.reason });
    seen.push({ who: 'card', text: `${card}\n→ You said ${decided.approve ? 'yes' : 'no'}.` });
  };

  const answerQuestion = async (call: HandlerCall): Promise<void> => {
    const question = call.decl.description === '' ? call.handler : call.decl.description;
    const stance = played.approvals ?? 'yes';
    let value: unknown;
    if (call.decl.returns.name === 'bool') {
      value = stance === 'person' ? (await person.decide(seen, question)).approve : stance === 'yes';
    } else {
      value = await person.answer(seen, `${question}\n${clip(JSON.stringify(call.args), 800)}`, clip(JSON.stringify(call.decl.returns), 1_500));
    }
    const parsed = Json.safeParse(value);
    await client.hub.call('answer', { call: call.id, value: parsed.success ? parsed.data : String(value) });
    questions.push({ type: 'question', run: call.run, question: clip(question, 400), answer: clip(JSON.stringify(value), 400) });
    seen.push({ who: 'card', text: `${question}\n→ You answered ${clip(JSON.stringify(value), 200)}.` });
  };

  /** Answer the approvals and direct questions of every chat while the case runs. */
  const responder = (async () => {
    while (state.live) {
      for (const chat of chats) {
        for (const { approval } of chat.watch.of('approval')) {
          if (approval.status !== 'pending' || handled.has(approval.id)) { continue; }
          handled.add(approval.id);
          try { await decideApproval(approval); } catch (error) { errors.push(`approval ${approval.fn}: ${message(error)}`); }
        }
        for (const { call } of chat.watch.of('handler')) {
          if (call.status !== 'pending' || !('user' in call.answerer) || handled.has(call.id)) { continue; }
          handled.add(call.id);
          try { await answerQuestion(call); } catch (error) { errors.push(`question from ${call.handler}: ${message(error)}`); }
        }
      }
      await new Promise((done) => setTimeout(done, 400));
    }
  })();

  const openChat = async (): Promise<Chat> => {
    const session = await client.hub.call('createSession', {});
    const chat = { id: session.id, watch: new SessionWatch(client, session.id) };
    chats.push(chat);
    return chat;
  };

  /** Upload the files and send a message; gives its turn. */
  const send = async (chat: Chat, text: string, files: readonly FixtureFile[]): Promise<TurnId> => {
    const parts: OutgoingPart[] = text === '' ? [] : [{ type: 'text', text }];
    for (const file of files) {
      const entry = FIXTURES[file];
      const name = basename(entry.path);
      const ref = await uploadBytes(client, ctx.rep.stack.url, { name, mime: entry.mime, bytes: readFileSync(join(FIXTURES_DIR, entry.path)) });
      parts.push({ type: 'file', ref, name });
    }
    const sent = await client.hub.call('send', { session: chat.id, parts, client: clientInfo() });
    turns.push(sent.turn);
    seen.push({ who: 'me', text: `${text}${files.length === 0 ? '' : ` [attached: ${files.map((f) => basename(FIXTURES[f].path)).join(', ')}]`}` });
    return sent.turn;
  };

  /** A turn's tree, once it exists. */
  const treeOf = (turn: TurnId): Promise<TreeNode> => waitFor(`turn ${turn}'s tree`, () => client.hub.call('tree', { turn }), { timeout: 30_000, every: 500 });

  /** Wait for a turn to settle, then for any turn that started by itself meanwhile (a background run reporting back). */
  const settleTurn = async (chat: Chat, turn: TurnId): Promise<void> => {
    const pending: TurnId[] = [turn];
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      const waited = next;
      await waitFor(`turn ${waited} to settle`, async () => (isSettled((await client.hub.call('tree', { turn: waited })).run.status) ? true : undefined), { timeout: ctx.turnTimeout, every: 1_000 });
      await new Promise((done) => setTimeout(done, 2_500));
      for (const m of (await client.hub.call('messages', { session: chat.id, limit: 5 })).items) {
        if (!turns.includes(m.turn)) { turns.push(m.turn); pending.push(m.turn); }
      }
    }
  };

  const shownMessages = new Set<string>();
  /** What appeared since last time: the agent's words, and the forms it showed and nobody answered yet. */
  const observe = async (chat: Chat): Promise<Array<{ run: RunId; asked: AskedValue }>> => {
    const page = await client.hub.call('messages', { session: chat.id, limit: 50 });
    for (const m of [...page.items].reverse()) {
      if (shownMessages.has(m.id)) { continue; }
      shownMessages.add(m.id);
      if (m.role !== 'user') {
        const text = textOf(m);
        if (text !== '') { seen.push({ who: 'assistant', text }); }
      }
      for (const part of m.parts) { if (part.type === 'input-answer') { answeredForms.add(part.run); } }
    }
    const forms: Array<{ run: RunId; asked: AskedValue }> = [];
    for (const turn of turns) {
      const tree = await client.hub.call('tree', { turn }).catch(() => undefined);
      for (const { node } of tree === undefined ? [] : nodesOf(tree)) {
        if (!node.run.fn.startsWith('input/') || node.run.status !== 'done' || answeredForms.has(node.run.id) || forms.some((f) => f.run === node.run.id)) { continue; }
        const run = await client.hub.call('run', { run: node.run.id });
        const asked = askedOf(run.outcome?.status === 'done' ? run.outcome.result : undefined);
        if (asked !== undefined) { forms.push({ run: node.run.id, asked }); }
      }
    }
    for (const form of forms) {
      const line = `${form.asked.form.title}${form.asked.form.description === '' ? '' : ` (${form.asked.form.description})`}: ${fieldAsks(form.asked.form).map((f) => f.label).join(' · ')}`;
      if (!seen.some((s) => s.who === 'form' && s.text === line)) { seen.push({ who: 'form', text: line }); }
    }
    return forms;
  };

  /** Fill and send the newest unanswered form; gives the turn its answer started. */
  const answerForm = async (chat: Chat, form: { run: RunId; asked: AskedValue }): Promise<TurnId> => {
    const fields = fieldAsks(form.asked.form);
    let values = await person.fill(seen, form.asked.form.title, fields);
    let checked = checkAnswers(form.asked.form.type, jsonValues(values));
    if ('problem' in checked) {
      values = await person.fill(seen, form.asked.form.title, fields, checked.problem);
      checked = checkAnswers(form.asked.form.type, jsonValues(values));
    }
    if ('problem' in checked) { throw new Error(`the person couldn't fill "${form.asked.form.title}": ${checked.problem}`); }
    const answer = answerFor(form.run, form.asked, checked.value);
    answeredForms.add(form.run);
    const sent = await client.hub.call('send', { session: chat.id, parts: [{ type: 'input-answer', ...answer }], client: clientInfo() });
    turns.push(sent.turn);
    seen.push({ who: 'me', text: `(filled in "${answer.title}")\n${answer.text}` });
    return sent.turn;
  };

  /** Play one step: send it, then let the person follow up within its allowance. */
  const playStep = async (chat: Chat, step: Step, last: boolean, previous: TurnId | undefined): Promise<TurnId | undefined> => {
    if (step.whileRunning === true && previous !== undefined) {
      // wait until the earlier turn has started a fn (or a while has passed), then interrupt it
      await waitFor('the earlier turn to start a fn', async () => ((await treeOf(previous)).children.length > 0 ? true : undefined), { timeout: 60_000, every: 500 }).catch(() => undefined);
    } else if (previous !== undefined) {
      await settleTurn(chat, previous);
      await observe(chat);
    }
    const turn = await send(chat, step.say, step.files ?? []);
    let allowance = Math.min(step.followUps ?? MAX_PERSON_TURNS, MAX_PERSON_TURNS - personTurns);
    // a step with no follow-ups hands its running turn to the next step (case 31 interrupts it)
    if (allowance === 0 && !last) { return turn; }
    let current = turn;
    if (step.whileRunning === true && previous !== undefined) { await settleTurn(chat, previous); }
    for (;;) {
      await settleTurn(chat, current);
      const forms = await observe(chat);
      if (allowance <= 0) {
        if (last) { ending = { by: 'turn-limit', reason: `the person had sent ${personTurns} follow-ups, the most allowed` }; }
        return undefined;
      }
      const form = forms.at(-1);
      if (form !== undefined) {
        current = await answerForm(chat, form);
      } else {
        const move = await person.next(seen, allowance);
        if (move.action !== 'reply') {
          if (last) { ending = { by: move.action === 'done' ? 'satisfied' : 'gave-up', reason: move.reason }; }
          return undefined;
        }
        current = await send(chat, move.message ?? '', move.attach);
      }
      personTurns++;
      allowance--;
    }
  };

  try {
    await settle(client);
    let chat = await openChat();
    let previous: TurnId | undefined;
    for (const [index, step] of played.steps.entries()) {
      if (step.newChat === true && index > 0) {
        if (previous !== undefined) { await settleTurn(chat, previous); previous = undefined; }
        chat = await openChat();
        seen.push({ who: 'me', text: '(later, in a new chat)' });
      }
      previous = await playStep(chat, step, index === played.steps.length - 1, previous);
    }
    if (previous !== undefined) { await settleTurn(chat, previous); }
  } catch (error) {
    errors.push(message(error));
    ending = { by: /timed out/.test(message(error)) ? 'timeout' : 'error', reason: clip(message(error), 400) };
  }
  // let a last approval or question be answered before stopping the responder
  await new Promise((done) => setTimeout(done, 1_000));
  state.live = false;
  await responder;

  const record = await readBack(ctx, client, played, {
    chats, turns, decisions, questions, errors, credentials, started, personTurns, personCost: person.cost,
    ending: ending ?? { by: 'satisfied', reason: 'the steps ran out' },
  });
  for (const chat of chats) { chat.watch.stop(); }
  client.close();
  return record;
}

/** A model's form values as the JSON values a form checks. */
function jsonValues(values: Record<string, unknown>): Record<string, Json | undefined> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const parsed = Json.safeParse(value);
    return [key, parsed.success ? parsed.data : undefined];
  }));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A run's result or error, shortened. */
function outcomeOf(run: Run): string {
  const outcome = run.outcome;
  if (outcome === undefined) { return run.status; }
  switch (outcome.status) {
    case 'done': return clip(JSON.stringify(outcome.result), 400);
    case 'failed': return `failed: ${clip(outcome.error.message, 400)}`;
    case 'cancelled': return `cancelled${outcome.error === undefined ? '' : `: ${clip(outcome.error.message, 300)}`}`;
    case 'invalid-input': return `invalid input: ${clip(JSON.stringify(outcome.invalid), 300)}`;
    case 'paused': return 'paused';
  }
}

/**
 * The tool calls a turn's models made that became no hub run (an agent's own tools, such as an authoring agent's
 * `services` or `set`, and calls turned away before running: an unknown fn, arguments that didn't parse), each with
 * the tool reply the model got, read from the turn's saved LLM calls, and labelled by that reply.
 */
async function strayCalls(client: SignedIn, tree: TreeNode, ran: ReadonlySet<string>): Promise<ToolRun[]> {
  const calls: Array<{ id: string; name: string; args: string; depth: number }> = [];
  const replies = new Map<string, string>();
  for (const { node, depth } of nodesOf(tree)) {
    for (const summary of node.llmCalls) {
      const call = await client.hub.call('llmCall', { id: summary.id }).catch(() => undefined);
      if (call === undefined) { continue; }
      for (const tool of call.response?.toolCalls ?? []) { calls.push({ id: tool.id, name: tool.name, args: tool.arguments, depth: depth + 1 }); }
      for (const m of call.request.messages) {
        if (m.role === 'tool' && m.toolCallId !== undefined) { replies.set(m.toolCallId, typeof m.content === 'string' ? m.content : JSON.stringify(m.content)); }
      }
    }
  }
  return calls.filter((call) => !ran.has(call.id)).map((call) => {
    const reply = replies.get(call.id);
    // `tool`: answered (an agent's own tool, such as an authoring agent's `search`); `tool-error`: the reply is an
    // error or refusal; `no-reply`: the model never got one (the turn ended first)
    const status = reply === undefined ? 'no-reply' : toolReplyFailed(reply) ? 'tool-error' : 'tool';
    return { run: '(no run)', fn: call.name, depth: call.depth, status, args: clip(call.args, 400), outcome: clip(reply ?? '(no reply recorded)', 400), cost: 0 };
  });
}

/** What `readBack` gathers from the play itself. */
interface Played {
  readonly chats: readonly Chat[];
  readonly turns: readonly TurnId[];
  readonly decisions: ReadonlyMap<RunId, NonNullable<ToolRun['approval']>>;
  readonly questions: ReadonlyArray<Extract<Entry, { type: 'question' }>>;
  readonly errors: string[];
  readonly credentials: { email: string; password: string };
  readonly started: number;
  readonly personTurns: number;
  readonly personCost: number;
  readonly ending: Ending;
}

/** Every message of a chat, oldest first. */
async function allMessages(client: SignedIn, session: SessionId): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.hub.call('messages', { session, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out.reverse();
}

/** Read the case back from the hub: the transcript in order, the numbers, the checks. */
async function readBack(ctx: PlayContext, client: SignedIn, played: Case, data: Played): Promise<CaseRecord> {
  const entries: Entry[] = [];
  const allRuns: ToolRun[] = [];
  const turnsSeen = new Set<string>();
  const base = viewBase(ctx.viewPort);
  /** A turn's runs (the chat agent's own run left out) and the forms it showed. */
  const turnEntries = async (turn: TurnId): Promise<Entry[]> => {
    const tree = await client.hub.call('tree', { turn }).catch(() => undefined);
    if (tree === undefined) { return []; }
    const runs: ToolRun[] = [];
    const forms: Entry[] = [];
    const toolCalls = new Set<string>();
    for (const { node, depth } of nodesOf(tree).slice(1)) {
      const run = await client.hub.call('run', { run: node.run.id });
      if (run.toolCallId !== undefined) { toolCalls.add(run.toolCallId); }
      const approval = data.decisions.get(run.id);
      runs.push({ run: run.id, fn: run.fn, depth, status: run.status, args: clip(JSON.stringify(run.args), 400), outcome: outcomeOf(run), cost: run.cost, ...(approval === undefined ? {} : { approval }) });
      const asked = run.fn.startsWith('input/') ? askedOf(run.outcome?.status === 'done' ? run.outcome.result : undefined) : undefined;
      if (asked !== undefined) { forms.push({ type: 'form', run: run.id, title: asked.form.title, fields: fieldAsks(asked.form).map((f) => f.label) }); }
    }
    runs.push(...await strayCalls(client, tree, toolCalls));
    allRuns.push(...runs);
    const asked = data.questions.filter((q) => runs.some((r) => r.run === q.run));
    return [...(runs.length === 0 ? [] : [{ type: 'tools' as const, turn, runs }]), ...forms, ...asked];
  };
  const sessions: CaseRecord['sessions'] = [];
  for (const chat of data.chats) {
    const url = `${base}/chat/${chat.id}`;
    sessions.push({ id: chat.id, url });
    entries.push({ type: 'chat', session: chat.id, url });
    for (const m of await allMessages(client, chat.id)) {
      const fresh = !turnsSeen.has(m.turn);
      turnsSeen.add(m.turn);
      const runs = fresh ? await turnEntries(m.turn) : [];
      if (m.role !== 'user') { entries.push(...runs); }
      if (m.role === 'user') {
        const answer = m.parts.find((part) => part.type === 'input-answer');
        if (answer?.type === 'input-answer') {
          entries.push({ type: 'form-answer', title: answer.title, text: answer.text });
        } else {
          const text = textOf(m);
          entries.push({ type: 'person', text, files: m.parts.flatMap((part) => (part.type === 'file' ? [part.name] : [])), scripted: played.steps.some((step) => step.say === text) });
        }
        entries.push(...runs);
      } else if (m.role === 'assistant') {
        entries.push({ type: 'agent', text: textOf(m), status: m.status });
      } else {
        entries.push({ type: 'note', text: textOf(m) });
      }
    }
  }
  // the hub's model calls for the case's chats and turns (every model, every modality)
  const sessionIds = new Set<string>(data.chats.map((c) => c.id));
  const turnIds = new Set<string>(turnsSeen);
  let modelCalls = 0;
  let hubCost = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await ctx.rep.admin.hub.call('modelCalls', { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    for (const call of page.items) {
      if ((call.session !== undefined && sessionIds.has(call.session)) || (call.turn !== undefined && turnIds.has(call.turn))) { modelCalls++; hubCost += call.cost; }
    }
    const oldest = page.items.at(-1);
    cursor = page.cursor;
    if (cursor === undefined || oldest === undefined || oldest.startedAt < data.started) { break; }
  }
  const ended = Date.now();
  const stackErrors = ctx.rep.problems.filter((p) => p.at >= data.started && p.at <= ended).map((p) => p.line);
  const record: CaseRecord = {
    iteration: ctx.iteration, rep: ctx.repNumber, case: played.id, title: played.title, good: played.good,
    person: data.credentials, sessions, entries, ending: data.ending,
    stats: { personTurns: data.personTurns, turns: turnIds.size, toolRuns: allRuns.length, modelCalls, hubCost, personCost: data.personCost, wallMs: ended - data.started },
    errors: data.errors, stackErrors: stackErrors.slice(0, 60), checks: [],
    startedAt: new Date(data.started).toISOString(), endedAt: new Date(ended).toISOString(),
  };
  return { ...record, checks: hardChecks(record) };
}
