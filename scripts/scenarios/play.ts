/**
 * Playing one case on a repetition's stack, as its own freshly made person: open a chat, send each step as written
 * (with its files, uploaded as the composer does), wait for the agent's turn to settle, and let the simulated person
 * carry on: fill the forms the agent shows, answer its questions, decide its approval cards, press Save on the widget
 * previews it offers (as the card's button does: `widgets/save_widget` run in the chat as the person, `invoke`), until
 * they're done, give up, or run out of messages. Then the whole case is read back from the hub (messages, each turn's run tree, every
 * run's args and outcome, the model calls) into a `CaseRecord`.
 *
 * A case may have limits of its own (`Case.limits`: a longer turn, more follow-ups, a time and a cost limit for the
 * whole case). A case that writes a system of its own (`Case.authoring`) is watched while it plays (`authoring.ts`
 * `SystemWatch`: the admin's review step done as its person, what each new system ran as), and its record gets the
 * systems it installed and the hard checks on them (`checks.ts` `authoringChecks`).
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isSettled, Json, QualifiedName, WidgetProposal, type Approval, type ChatMessage, type HandlerCall, type OutgoingPart, type Run, type RunId, type SessionId, type TreeNode, type TurnId } from '@harness/core';
import { settle, waitFor, type SignedIn } from '../hub-client.ts';
import { clientInfo, SessionWatch, uploadBytes } from '../session.ts';
import { answerFor, askedOf, checkAnswers, controlOf } from '../../systems/input/client/form.ts';
import { fieldsOf } from '../../systems/input/shared/forms.ts';
import { saveArgs, savedName } from '../../systems/widgets/client/proposal.ts';
import type { AskedValue } from '../../systems/input/shared/index.ts';
import { MEMBERS, type Case, type FixtureFile, type Member, type Step } from './cases.ts';
import { authoringChecks, hardChecks, toolReplyFailed } from './checks.ts';
import { SystemWatch, systemNames } from './authoring.ts';
import { FIXTURES } from './fixtures/make.ts';
import type { OpenRouter } from './openrouter.ts';
import { Person, type FieldAsk, type Seen } from './person.ts';
import type { CaseRecord, Ending, Entry, SystemsSeen, ToolRun } from './records.ts';
import { FIXTURES_DIR, viewBase, type Rep } from './rep.ts';
import { clip } from './transcript.ts';

/** The most messages a person sends after a case's scripted steps (form answers count). */
export const MAX_PERSON_TURNS = 6;

/** What playing a case needs. */
export interface PlayContext {
  readonly rep: Rep;
  readonly iteration: string;
  readonly repNumber: number;
  /** The variant folder the rep is in (absent: a run of one variant). */
  readonly variant?: string;
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
    // a choice's options are the words the form shows (its members); the answer is read back to the member it names (`checkAnswers`)
    return { key: field.key, label: field.label, kind, required: field.required, ...(control.control === 'choice' ? { options: control.options, multiple: control.multiple } : {}) };
  });
}

/** The fn whose result is a widget preview with a Save button, and the fn that button runs as the person. */
const MAKE_WIDGET = QualifiedName.parse('widgets/make_widget');
const SAVE_WIDGET = QualifiedName.parse('widgets/save_widget');

/** A widget preview card as the person reads it: its title, what it shows, the widget it changes, its buttons. */
function widgetCard(proposal: WidgetProposal): string {
  return [
    `A widget preview: "${proposal.spec.title}"${proposal.replaces === undefined ? '' : ` (changes ${proposal.replaces})`}`,
    proposal.description,
    `Preview: ${clip(JSON.stringify(proposal.preview), 600)}`,
    'Buttons: Save (keeps it as a widget you can open again) · Change (asks for changes). Nothing is kept until Save.',
  ].join('\n');
}

/** Who sends in a chat: Alex (the case's own person) or a member of the household (`Step.as`). */
interface Party {
  readonly who: Member | undefined;
  readonly client: SignedIn;
  readonly credentials: { email: string; password: string };
  readonly person: Person;
  /** What this person has seen, in all their chats, oldest first. */
  readonly seen: Seen[];
}

/** One chat the case opened, with its live recorder, and whose it is. */
interface Chat {
  readonly id: SessionId;
  readonly watch: SessionWatch;
  readonly party: Party;
  /** The turns of this chat, in order. */
  readonly turns: TurnId[];
}

/** The model calls of a case's chats and turns since it started: how many, and what they cost. */
async function hubCost(admin: SignedIn, sessions: ReadonlySet<string>, turns: ReadonlySet<string>, started: number): Promise<{ calls: number; cost: number }> {
  let calls = 0;
  let cost = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await admin.hub.call('modelCalls', { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    for (const call of page.items) {
      if ((call.session !== undefined && sessions.has(call.session)) || (call.turn !== undefined && turns.has(call.turn))) { calls++; cost += call.cost; }
    }
    const oldest = page.items.at(-1);
    cursor = page.cursor;
    if (cursor === undefined || oldest === undefined || oldest.startedAt < started) { break; }
  }
  return { calls, cost };
}

/** Play one case; never throws (what went wrong goes in the record). */
export async function playCase(ctx: PlayContext, played: Case): Promise<CaseRecord> {
  const started = Date.now();
  const errors: string[] = [];
  const maxPersonTurns = played.limits?.personTurns ?? MAX_PERSON_TURNS;
  const turnTimeout = played.limits?.turnTimeout ?? ctx.turnTimeout;
  /** Why the case must stop before its next message (its time or cost limit), once it must. */
  const stop: { why?: string } = {};
  const caseTimeout = played.limits?.caseTimeout;
  const checkStop = (): void => {
    if (stop.why === undefined && caseTimeout !== undefined && Date.now() - started > caseTimeout) { stop.why = `the case timed out: it passed its limit of ${Math.round(caseTimeout / 60_000)} minutes`; }
    if (stop.why !== undefined) { throw new Error(stop.why); }
  };
  const { client, credentials, shed } = await ctx.rep.person(played.id);
  let memberShed = 0;
  const alex: Party = { who: undefined, client, credentials, person: new Person(ctx.router, ctx.personModel, played), seen: [] };
  const members = new Map<Member, Party>();
  /** The party a step is sent by, signing in as a member the first time one sends. */
  const partyOf = async (step: Step): Promise<Party> => {
    if (step.as === undefined) { return alex; }
    const known = members.get(step.as);
    if (known !== undefined) { return known; }
    const signed = await ctx.rep.member(played.id, step.as, () => { memberShed++; });
    const party: Party = { who: step.as, client: signed.client, credentials: signed.credentials, person: new Person(ctx.router, ctx.personModel, played, { who: step.as, step }), seen: [] };
    members.set(step.as, party);
    return party;
  };
  const chats: Chat[] = [];
  const turns: TurnId[] = [];
  /** Approvals answered, by run: what the person said. */
  const decisions = new Map<RunId, NonNullable<ToolRun['approval']>>();
  const questions: Array<Extract<Entry, { type: 'question' }>> = [];
  const answeredForms = new Set<RunId>();
  const handled = new Set<string>();
  /** Widget previews seen (the make_widget runs), what the person did with each, and the turns their Save started. */
  const offered = new Set<RunId>();
  const widgets: Array<Extract<Entry, { type: 'widget' }>> = [];
  const saveTurns = new Map<TurnId, string>();
  let personTurns = 0;
  let ending: Ending | undefined;
  const state = { live: true };

  const decideApproval = async (chat: Chat, approval: Approval): Promise<void> => {
    const { person, seen } = chat.party;
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
    await chat.party.client.hub.call('approve', { approval: approval.id, approve: decided.approve, remember: 'once', ...(decided.approve ? {} : { reason: decided.reason }), ...(answer === undefined ? {} : { answer }) });
    decisions.set(approval.run, { title: approval.preview?.title ?? approval.fn, decision: decided.approve ? 'approved' : 'denied', reason: decided.reason });
    seen.push({ who: 'card', text: `${card}\n→ You said ${decided.approve ? 'yes' : 'no'}.` });
  };

  const answerQuestion = async (chat: Chat, call: HandlerCall): Promise<void> => {
    const { person, seen } = chat.party;
    const question = call.decl.description === '' ? call.handler : call.decl.description;
    const stance = played.approvals ?? 'yes';
    let value: unknown;
    if (call.decl.returns.name === 'bool') {
      value = stance === 'person' ? (await person.decide(seen, question)).approve : stance === 'yes';
    } else if (call.decl.returns.name === 'obj') {
      // an object answer (hub/ask_user's { answer }) is a small form: filled, checked, and filled again once on a problem
      const form = { title: question, description: '', type: call.decl.returns };
      const fields = fieldAsks(form);
      let checked = checkAnswers(form.type, jsonValues(await person.fill(seen, question, fields)));
      if ('problem' in checked) { checked = checkAnswers(form.type, jsonValues(await person.fill(seen, question, fields, checked.problem))); }
      if ('problem' in checked) { throw new Error(`the person couldn't answer "${clip(question, 120)}": ${checked.problem}`); }
      value = checked.value;
    } else {
      value = await person.answer(seen, `${question}\n${clip(JSON.stringify(call.args), 800)}`, clip(JSON.stringify(call.decl.returns), 1_500));
    }
    const parsed = Json.safeParse(value);
    await chat.party.client.hub.call('answer', { call: call.id, value: parsed.success ? parsed.data : String(value) });
    questions.push({ type: 'question', run: call.run, question: clip(question, 400), answer: clip(JSON.stringify(value), 400) });
    seen.push({ who: 'card', text: `${question}\n→ You answered ${clip(JSON.stringify(value), 200)}.` });
  };

  /** Answer the approvals and direct questions of every chat while the case runs, as the chat's own person. */
  const responder = (async () => {
    while (state.live) {
      for (const chat of chats) {
        for (const { approval } of chat.watch.of('approval')) {
          if (approval.status !== 'pending' || handled.has(approval.id)) { continue; }
          handled.add(approval.id);
          try { await decideApproval(chat, approval); } catch (error) { errors.push(`approval ${approval.fn}: ${message(error)}`); }
        }
        for (const { call } of chat.watch.of('handler')) {
          if (call.status !== 'pending' || !('user' in call.answerer) || handled.has(call.id)) { continue; }
          handled.add(call.id);
          try { await answerQuestion(chat, call); } catch (error) { errors.push(`question from ${call.handler}: ${message(error)}`); }
        }
      }
      await new Promise((done) => setTimeout(done, 400));
    }
  })();

  const openChat = async (party: Party): Promise<Chat> => {
    const session = await party.client.hub.call('createSession', {});
    const chat: Chat = { id: session.id, watch: new SessionWatch(party.client, session.id), party, turns: [] };
    chats.push(chat);
    return chat;
  };

  /** A turn that started in a chat, kept for the chat and the case. */
  const keepTurn = (chat: Chat, turn: TurnId): void => { turns.push(turn); chat.turns.push(turn); };

  /** Upload the files and send a message; gives its turn. */
  const send = async (chat: Chat, text: string, files: readonly FixtureFile[]): Promise<TurnId> => {
    const parts: OutgoingPart[] = text === '' ? [] : [{ type: 'text', text }];
    for (const file of files) {
      const entry = FIXTURES[file];
      const name = basename(entry.path);
      // the presigned PUT is plain fetch, so a shed upload (HTTP 503) is tried again here
      const ref = await ctx.rep.patient(`upload ${name}`, () => uploadBytes(chat.party.client, ctx.rep.stack.url, { name, mime: entry.mime, bytes: readFileSync(join(FIXTURES_DIR, entry.path)) }));
      parts.push({ type: 'file', ref, name });
    }
    const sent = await chat.party.client.hub.call('send', { session: chat.id, parts, client: clientInfo() });
    keepTurn(chat, sent.turn);
    chat.party.seen.push({ who: 'me', text: `${text}${files.length === 0 ? '' : ` [attached: ${files.map((f) => basename(FIXTURES[f].path)).join(', ')}]`}` });
    return sent.turn;
  };

  /** A turn's tree, once it exists. */
  const treeOf = (chat: Chat, turn: TurnId): Promise<TreeNode> => waitFor(`turn ${turn}'s tree`, () => chat.party.client.hub.call('tree', { turn }), { timeout: 30_000, every: 500 });

  /** Wait for a turn to settle, then for any turn that started by itself meanwhile (a background run reporting back). */
  const settleTurn = async (chat: Chat, turn: TurnId): Promise<void> => {
    const hub = chat.party.client.hub;
    const pending: TurnId[] = [turn];
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      const waited = next;
      await waitFor(`turn ${waited} to settle`, async () => (isSettled((await hub.call('tree', { turn: waited })).run.status) ? true : undefined), { timeout: turnTimeout, every: 1_000 });
      await new Promise((done) => setTimeout(done, 2_500));
      for (const m of (await hub.call('messages', { session: chat.id, limit: 5 })).items) {
        if (!turns.includes(m.turn)) { keepTurn(chat, m.turn); pending.push(m.turn); }
      }
    }
  };

  const shownMessages = new Set<string>();
  /** What appeared in a chat since last time: the agent's words, and the forms it showed and nobody answered yet. */
  const observe = async (chat: Chat): Promise<Array<{ run: RunId; asked: AskedValue }>> => {
    const hub = chat.party.client.hub;
    const seen = chat.party.seen;
    const page = await hub.call('messages', { session: chat.id, limit: 50 });
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
    for (const turn of chat.turns) {
      const tree = await hub.call('tree', { turn }).catch(() => undefined);
      for (const { node } of tree === undefined ? [] : nodesOf(tree)) {
        if (!node.run.fn.startsWith('input/') || node.run.status !== 'done' || answeredForms.has(node.run.id) || forms.some((f) => f.run === node.run.id)) { continue; }
        const run = await hub.call('run', { run: node.run.id });
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
    const { person, seen } = chat.party;
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
    const sent = await chat.party.client.hub.call('send', { session: chat.id, parts: [{ type: 'input-answer', ...answer }], client: clientInfo() });
    keepTurn(chat, sent.turn);
    seen.push({ who: 'me', text: `(filled in "${answer.title}")\n${answer.text}` });
    return sent.turn;
  };

  /**
   * The widget previews shown in a chat since last time, offered to its person as their card's Save: the newest one is
   * decided as an approval card is (the case's stance; `person` asks the person), and a yes runs `widgets/save_widget`
   * with the card's own args (`saveArgs`) in the chat as the person (`invoke`, as the card's button does), then waits
   * for that turn. Older previews shown with it are passed over. Saving is a press, not a message: no follow-up used.
   */
  const offerWidgets = async (chat: Chat): Promise<void> => {
    const hub = chat.party.client.hub;
    const found: Array<{ run: RunId; proposal: WidgetProposal }> = [];
    for (const turn of chat.turns) {
      const tree = await hub.call('tree', { turn }).catch(() => undefined);
      for (const { node } of tree === undefined ? [] : nodesOf(tree)) {
        if (node.run.fn !== MAKE_WIDGET || node.run.status !== 'done' || offered.has(node.run.id)) { continue; }
        offered.add(node.run.id);
        const run = await hub.call('run', { run: node.run.id });
        const parsed = WidgetProposal.safeParse(run.outcome?.status === 'done' ? run.outcome.result : undefined);
        if (parsed.success) { found.push({ run: node.run.id, proposal: parsed.data }); } else { errors.push(`widget preview ${node.run.id}: its result isn't a proposal: ${parsed.error.issues[0]?.message ?? ''}`); }
      }
    }
    const newest = found.at(-1);
    for (const older of found.slice(0, -1)) { widgets.push({ type: 'widget', run: older.run, title: older.proposal.spec.title, decision: 'passed-over', detail: '' }); }
    if (newest === undefined) { return; }
    const { person, seen } = chat.party;
    const card = widgetCard(newest.proposal);
    const stance = played.approvals ?? 'yes';
    const decided = stance === 'person'
      ? await person.decide(seen, `${card}\n(Yes: press Save. No: leave it unsaved.)`)
      : { approve: stance === 'yes', reason: stance === 'yes' ? 'says yes to every card' : 'says no to every card' };
    const title = newest.proposal.spec.title;
    if (!decided.approve) {
      widgets.push({ type: 'widget', run: newest.run, title, decision: 'declined', detail: decided.reason });
      seen.push({ who: 'card', text: `${card}\n→ You left it unsaved.` });
      return;
    }
    const started = await hub.call('invoke', { session: chat.id, fn: SAVE_WIDGET, args: Json.parse(saveArgs(newest.proposal)), client: clientInfo() });
    keepTurn(chat, started.turn);
    saveTurns.set(started.turn, title);
    await settleTurn(chat, started.turn);
    const run = await hub.call('run', { run: started.run });
    const name = savedName(newest.proposal);
    const ok = run.status === 'done';
    widgets.push({ type: 'widget', run: newest.run, title, decision: ok ? 'saved' : 'save-failed', detail: ok ? `kept as ${name}` : outcomeOf(run) });
    seen.push({ who: 'card', text: `${card}\n→ You pressed Save. ${ok ? `It was saved as ${name}.` : `Saving failed: ${outcomeOf(run)}`}` });
  };

  /** Play one step: send it, then let the person follow up within its allowance. */
  const playStep = async (chat: Chat, step: Step, last: boolean, previous: TurnId | undefined): Promise<TurnId | undefined> => {
    if (step.whileRunning === true && previous !== undefined) {
      // wait until the earlier turn has started a fn (or a while has passed), then interrupt it
      await waitFor('the earlier turn to start a fn', async () => ((await treeOf(chat, previous)).children.length > 0 ? true : undefined), { timeout: 60_000, every: 500 }).catch(() => undefined);
    } else if (previous !== undefined) {
      await settleTurn(chat, previous);
      await observe(chat);
      await offerWidgets(chat);
    }
    checkStop();
    const turn = await send(chat, step.say, step.files ?? []);
    let allowance = Math.min(step.followUps ?? maxPersonTurns, maxPersonTurns - personTurns);
    // a step with no follow-ups hands its running turn to the next step (case 31 interrupts it)
    if (allowance === 0 && !last) { return turn; }
    let current = turn;
    if (step.whileRunning === true && previous !== undefined) { await settleTurn(chat, previous); }
    for (;;) {
      await settleTurn(chat, current);
      const forms = await observe(chat);
      // a widget preview's Save is pressed before anything else (a press, not a message)
      await offerWidgets(chat);
      if (allowance <= 0) {
        if (last) { ending = { by: 'turn-limit', reason: `the person had sent ${personTurns} follow-ups, the most allowed` }; }
        return undefined;
      }
      checkStop();
      const form = forms.at(-1);
      if (form !== undefined) {
        current = await answerForm(chat, form);
      } else {
        const move = await chat.party.person.next(chat.party.seen, allowance);
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

  /** A case that writes a system: watched while it plays, the admin's review step done as its person (`authoring.ts`). */
  const watch = played.authoring === undefined ? undefined : new SystemWatch({
    client, baseline: await systemNames(ctx.rep.admin).catch(() => new Set(ctx.rep.baseline)), expect: played.authoring, repFolder: ctx.rep.folder, url: ctx.rep.stack.url,
    cost: async () => (await hubCost(ctx.rep.admin, new Set(chats.map((c) => c.id)), new Set(turns), started)).cost,
    ...(played.limits?.costCap === undefined ? {} : { costCap: played.limits.costCap }),
    onCap: (cost) => {
      stop.why = `the case stopped: its model cost reached $${cost.toFixed(2)}, past its cap of $${(played.limits?.costCap ?? 0).toFixed(2)}`;
      for (const chat of chats) { void chat.party.client.hub.call('control', { session: chat.id, action: 'cancel' }).catch(() => undefined); }
    },
    log: (line) => { ctx.log(`rep ${ctx.repNumber}: case ${played.id}: ${line}`); },
  });
  watch?.start();
  try {
    await settle(client);
    let chat = await openChat(alex);
    let previous: TurnId | undefined;
    for (const [index, step] of played.steps.entries()) {
      const party = await partyOf(step);
      // another person sends in their own chat (their last one, if they had one); the same person's newChat opens another
      const another = party !== chat.party;
      if (index > 0 && (another || step.newChat === true)) {
        if (previous !== undefined) { await settleTurn(chat, previous); await observe(chat); await offerWidgets(chat); previous = undefined; }
        const theirs = another && step.newChat !== true ? chats.findLast((c) => c.party === party) : undefined;
        chat = theirs ?? await openChat(party);
        if (theirs !== undefined || !another) { party.seen.push({ who: 'me', text: theirs === undefined ? '(later, in a new chat)' : '(later, back in this chat)' }); }
      }
      previous = await playStep(chat, step, index === played.steps.length - 1, previous);
    }
    if (previous !== undefined) { await settleTurn(chat, previous); await offerWidgets(chat); }
  } catch (error) {
    errors.push(message(error));
    ending = { by: /timed out/.test(message(error)) ? 'timeout' : 'error', reason: clip(message(error), 400) };
  }
  // let a last approval or question be answered before stopping the responder
  await new Promise((done) => setTimeout(done, 1_000));
  state.live = false;
  await responder;
  const systems = watch === undefined ? undefined : await watch.finish().catch((error: unknown): SystemsSeen | undefined => { errors.push(`watching the systems: ${message(error)}`); return undefined; });

  const parties = [alex, ...members.values()];
  try {
    return await readBack(ctx, played, {
      chats, turns, decisions, questions, widgets, saveTurns, errors, credentials, started, personTurns, personCost: parties.reduce((sum, p) => sum + p.person.cost, 0), shed: shed() + memberShed, systems,
      ending: ending ?? { by: 'satisfied', reason: 'the steps ran out' },
    });
  } finally {
    // whatever happened, the case's watches and its signed-in clients end with it
    for (const chat of chats) { chat.watch.stop(); }
    for (const party of parties) { party.client.close(); }
  }
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
  /** The widget previews offered and what the person did with each; the turns their Save started, with the preview's title. */
  readonly widgets: ReadonlyArray<Extract<Entry, { type: 'widget' }>>;
  readonly saveTurns: ReadonlyMap<TurnId, string>;
  readonly errors: string[];
  readonly credentials: { email: string; password: string };
  readonly started: number;
  readonly personTurns: number;
  readonly personCost: number;
  /** Calls of the case's client the hub shed before taking them. */
  readonly shed: number;
  readonly ending: Ending;
  /** The systems the case installed (a case that writes one). */
  readonly systems: SystemsSeen | undefined;
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
async function readBack(ctx: PlayContext, played: Case, data: Played): Promise<CaseRecord> {
  const entries: Entry[] = [];
  const allRuns: ToolRun[] = [];
  const turnsSeen = new Set<string>();
  const base = viewBase(ctx.viewPort);
  /** A turn's runs (the chat agent's own run left out) and the forms it showed. */
  const turnEntries = async (client: SignedIn, turn: TurnId): Promise<Entry[]> => {
    const tree = await client.hub.call('tree', { turn }).catch(() => undefined);
    if (tree === undefined) { return []; }
    const runs: ToolRun[] = [];
    const forms: Entry[] = [];
    const toolCalls = new Set<string>();
    for (const { node, depth } of nodesOf(tree).slice(1)) {
      const run = await client.hub.call('run', { run: node.run.id });
      if (run.toolCallId !== undefined) { toolCalls.add(run.toolCallId); }
      const approval = data.decisions.get(run.id);
      runs.push({ run: run.id, fn: run.fn, depth, status: run.status, args: clip(JSON.stringify(run.args), 400), outcome: outcomeOf(run), cost: run.cost, ...((run.repairs?.length ?? 0) === 0 ? {} : { repairs: run.repairs?.length ?? 0 }), ...(approval === undefined ? {} : { approval }) });
      const asked = run.fn.startsWith('input/') ? askedOf(run.outcome?.status === 'done' ? run.outcome.result : undefined) : undefined;
      if (asked !== undefined) { forms.push({ type: 'form', run: run.id, title: asked.form.title, fields: fieldAsks(asked.form).map((f) => f.label) }); }
    }
    runs.push(...await strayCalls(client, tree, toolCalls));
    allRuns.push(...runs);
    const asked = data.questions.filter((q) => runs.some((r) => r.run === q.run));
    const offers = data.widgets.filter((w) => runs.some((r) => r.run === w.run));
    return [...(runs.length === 0 ? [] : [{ type: 'tools' as const, turn, runs }]), ...forms, ...asked, ...offers];
  };
  const sessions: CaseRecord['sessions'] = [];
  const others: NonNullable<CaseRecord['others']> = [];
  for (const chat of data.chats) {
    const url = `${base}/chat/${chat.id}`;
    const who = chat.party.who;
    const as = who === undefined ? {} : { as: MEMBERS[who].name };
    if (who !== undefined && !others.some((o) => o.email === chat.party.credentials.email)) { others.push({ name: MEMBERS[who].name, ...chat.party.credentials }); }
    sessions.push({ id: chat.id, url, ...as });
    entries.push({ type: 'chat', session: chat.id, url, ...as });
    const client = chat.party.client;
    for (const m of await allMessages(client, chat.id)) {
      const fresh = !turnsSeen.has(m.turn);
      turnsSeen.add(m.turn);
      const runs = fresh ? await turnEntries(client, m.turn) : [];
      if (m.role !== 'user') { entries.push(...runs); }
      if (m.role === 'user') {
        const answer = m.parts.find((part) => part.type === 'input-answer');
        const pressed = data.saveTurns.get(m.turn);
        if (pressed !== undefined) {
          entries.push({ type: 'note', text: `The person pressed Save on the widget preview "${pressed}" (widgets/save_widget, run as them from the card).` });
        } else if (answer?.type === 'input-answer') {
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
  const { calls: modelCalls, cost: caseHubCost } = await hubCost(ctx.rep.admin, sessionIds, turnIds, data.started);
  const ended = Date.now();
  const stackErrors = ctx.rep.problems.filter((p) => p.at >= data.started && p.at <= ended).map((p) => p.line);
  const record: CaseRecord = {
    iteration: ctx.iteration, rep: ctx.repNumber, ...(ctx.variant === undefined ? {} : { variant: ctx.variant }), case: played.id, title: played.title, good: played.good,
    person: data.credentials, ...(others.length === 0 ? {} : { others }), sessions, entries, ending: data.ending,
    stats: { personTurns: data.personTurns, turns: turnIds.size, toolRuns: allRuns.length, modelCalls, hubCost: caseHubCost, personCost: data.personCost, wallMs: ended - data.started, shed: data.shed },
    errors: data.errors, stackErrors: stackErrors.slice(0, 60), checks: [], ...(data.systems === undefined ? {} : { systems: data.systems }),
    startedAt: new Date(data.started).toISOString(), endedAt: new Date(ended).toISOString(),
  };
  return { ...record, checks: [...hardChecks(record), ...(data.systems === undefined ? [] : authoringChecks(data.systems, allRuns))] };
}
