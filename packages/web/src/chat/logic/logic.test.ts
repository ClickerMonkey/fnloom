import { ActorId, HookBlock, ResolvedLimits, QualifiedName, RUN_STATUSES, RunId, SystemName, type ChatCapabilities, type ModelInfo } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { capabilities, llmCall, message, run, session, T0, tree } from '../test/fakes.ts';
import {
  commandArgs, commandHint, detectTrigger, draftParts, enterSends, insertText, leadingCommand, methodArgs, methodsOf, missingArgs, ownArgs, placeholderFor, pruneMentions, textParts,
  type DraftMention,
} from './composer.ts';
import { clamp, formatBytes, formatCost, formatDuration, formatTokens } from './format.ts';
import { messageContent, taggedBlocks, toolCallSlip, treeCalls, treeRuns, treeSize, turnUsage } from './inspect.ts';
import { isTyping, shortcutFor } from './keys.ts';
import { agentName, confirmVerb, fnLabel, humanize, localName, lowerFirst, systemOf } from './labels.ts';
import {
  applyRunUpdate, argSummary, ASKING_TEXT, drawerRun, INVALID_TEXT, emptyRun, isActive, isBusy, mergeRecord, PHASES, phaseOf, recordIsBehind, runMessage, runShows, progressFraction, repeatsArgs, resultBrief, runElapsed, runDeclined, runError, runResult, runText, shownStatus, statusLine, THINKING, THINKING_HARDER_LEAD, lineHasNews, repairedNote, invalidWhat,
} from './runs.ts';
import { abilities, contextText, findModels, isFree, priceText, type ModelQuery } from './models.ts';
import { agentOptions, budgetMeter, messageSuggestions, modelChoiceOf, modelLabel, modelPick, scopeLabel, scoreText, skipText, whoAnswers } from './session.ts';
import { choosableRuns, controlPlan, toggleRun, turnVerbs } from './controls.ts';
import {
  addSegment, answerPieces, appendToken, dayLabel, invocationCarriers, messageText, prependPage, resendParts, settleSegments, splitParts, storedSegments, threadItems, undoneTurns, upsertMessage,
} from './thread.ts';

const caps: ChatCapabilities = capabilities();
const mention: DraftMention = { type: 'mention', provider: 'fs/files', label: 'harness.md', target: { path: 'docs/harness.md' } };

describe('labels', () => {
  it('names things for people', () => {
    expect(humanize('read_file')).toBe('Read file');
    expect(humanize('readFile')).toBe('Read file');
    expect(humanize('Entry.reveal')).toBe('Entry reveal');
    expect(fnLabel('fs/read_file')).toBe('Read file');
    expect(localName('fs/Entry.reveal')).toBe('Entry.reveal');
    expect(systemOf('fs/read_file')).toBe('fs');
    expect(lowerFirst('Read file')).toBe('read file');
    expect(lowerFirst('URL fetch')).toBe('URL fetch');
    expect(agentName('hub/chat')).toBe('Chat agent');
    expect(agentName('fs/coder_agent')).toBe('Coder agent');
  });
});

describe('format', () => {
  it('formats money, time, sizes and tokens', () => {
    expect([formatCost(0), formatCost(0.004), formatCost(0.000423), formatCost(0.0000012), formatCost(0.031), formatCost(240)]).toEqual(['$0', '$0.004', '$0.00042', '$0.0000012', '$0.03', '$240']);
    expect([formatDuration(850), formatDuration(4_200), formatDuration(65_000), formatDuration(7_380_000)]).toEqual(['850ms', '4.2s', '1m 05s', '2h 03m']);
    expect([formatBytes(512), formatBytes(4_300), formatBytes(12 * 1_048_576)]).toEqual(['512 B', '4.2 KB', '12 MB']);
    expect([formatTokens(820), formatTokens(12_400), formatTokens(1_200_000)]).toEqual(['820', '12k', '1.2M']);
    expect(clamp('one two three four five', 14)).toBe('one two three…');
  });
});

describe('runs', () => {
  it('follows live updates: started, cost, progress, settled', () => {
    let view = emptyRun(RunId.parse('run_a'), 'fs/read_file');
    view = applyRunUpdate(view, { type: 'status', status: 'running' }, T0);
    expect(view.startedAt).toBe(T0);
    view = applyRunUpdate(view, { type: 'progress', progress: { fraction: 0.4 } }, T0 + 10);
    expect(progressFraction(view)).toBe(0.4);
    view = applyRunUpdate(view, { type: 'cost', cost: 0.01, total: 0.03 }, T0 + 20);
    expect([view.cost, view.totalCost]).toEqual([0.01, 0.03]);
    expect(runElapsed(view, T0 + 1_500)).toBe(1_500);
    view = applyRunUpdate(view, { type: 'status', status: 'done' }, T0 + 2_000);
    expect(view.endedAt).toBe(T0 + 2_000);
    expect(runElapsed(view, T0 + 9_000)).toBe(2_000);
    view = applyRunUpdate(view, { type: 'status', status: 'running' }, T0 + 3_000);
    expect(view.attempt).toBe(2);
    expect(view.endedAt).toBeUndefined();
  });

  it('says what a run is doing in plain words', () => {
    const base = { fn: 'fs/read_file' as const, attempt: 1 };
    expect(runText({ ...base, status: 'running' })).toBe('Read file…');
    expect(runText({ ...base, status: 'running', attempt: 2 })).toBe('Retrying read file…');
    // refused input, once over, is said as settled, never as a retry still going
    expect(runText({ ...base, status: 'invalid-input', attempt: 1 })).toBe(INVALID_TEXT);
    expect(runText({ ...base, status: 'done' })).toBe('Read file done');
    expect(runText({ ...base, status: 'failed' })).toBe('Read file failed');
    expect(runText({ ...base, status: 'awaiting-approval' })).toBe('Waiting for approval to read file');
    // a declined run is a decision, said with its reason, not a failure
    const declined = { ...base, status: 'cancelled' as const, errors: [{ attempt: 1, at: T0, cost: 0, error: { class: 'caller' as const, message: 'declined by Ana: not this folder', code: 'denied' } }] };
    expect(runText(declined)).toBe('Read file declined');
    expect(runDeclined(declined)).toBe('declined by Ana: not this folder');
    expect(runDeclined({ status: 'cancelled' })).toBeUndefined();
  });

  it('says the words the hub sent for the run phase, and falls back to the defaults for another phase', () => {
    const text = { phase: 'active', one: 'Reading harness.md…', many: 'Reading {n} files…' } as const;
    const reading = run({ fn: 'fs/read', status: 'running', text });
    expect(runText(reading)).toBe('Reading harness.md…');
    const done = applyRunUpdate(reading, { type: 'status', status: 'done', text: { phase: 'done', one: 'Read harness.md', many: 'Read {n} files' } }, T0);
    expect(runText(done)).toBe('Read harness.md');
    // a status update without words (an older hub) keeps the record's, which are for another phase
    expect(runText(applyRunUpdate(reading, { type: 'status', status: 'failed' }, T0))).toBe('Read failed');
    expect(mergeRecord(done, run({ fn: 'fs/read', status: 'running', text })).text?.one).toBe('Read harness.md');
  });

  it('sums up its args by their most telling value', () => {
    expect(argSummary({ path: 'docs/harness.md', limit: 3 })).toBe('docs/harness.md');
    expect(argSummary({ limit: 3 })).toBe('limit: 3');
    expect(argSummary(['a', 'b'])).toBe('2 items');
    expect(argSummary(undefined)).toBe('');
  });

  it('reads errors and results from the outcome', () => {
    const failed = run({ status: 'failed', outcome: { status: 'failed', error: { class: 'caller', message: 'No such file' } } });
    expect(runError(failed)?.message).toBe('No such file');
    expect(runResult(run({ status: 'done', outcome: { status: 'done', result: 'ok' } }))).toBe('ok');
    expect(progressFraction({ progress: { steps: { a: { status: 'done' }, b: { status: 'active' } } } })).toBe(0.5);
  });

  it('keeps a settled live status over an older record', () => {
    const record = run({ id: 'run_m', status: 'running' });
    const live = applyRunUpdate(record, { type: 'status', status: 'done' }, T0 + 5);
    expect(mergeRecord(live, record).status).toBe('done');
    expect(mergeRecord(undefined, record).status).toBe('running');
  });

  it('groups the status line, most active first, and lets finished groups go', () => {
    const reads = [1, 2, 3].map((n) => run({ id: `run_r${n}`, fn: 'fs/read_file', status: 'running' }));
    const write = run({ id: 'run_w', fn: 'fs/write_file', status: 'done', endedAt: T0 });
    const line = statusLine([...reads, write], T0 + 1_000);
    expect(line.groups.map((g) => g.text)).toEqual(['Read file ×3…', 'Write file done']);
    expect(line.lead).toBe('');
    expect(statusLine([write], T0 + 10_000).groups).toEqual([]);
    expect(statusLine([], T0).lead).toBe('Thinking…');
    expect(statusLine([run({ status: 'awaiting-approval' })], T0).lead).toBe('Waiting for your approval');
    const many = ['a', 'b', 'c', 'd', 'e'].map((name) => run({ id: `run_${name}`, fn: `fs/${name}`, status: 'running' }));
    expect(statusLine(many, T0).more).toBe(2);
    expect(phaseOf({ status: 'running', attempt: 2 })).toBe('retry');
  });

  it('groups in the fn words, never repeats a waiting card, and lets the lead speak for the turn agent', () => {
    const text = { phase: 'active', one: 'Reading a.md…', many: 'Reading {n} files…' } as const;
    const reads = [1, 2].map((n) => run({ id: `run_r${n}`, fn: 'fs/read', status: 'running', text }));
    const agent = run({ id: 'run_agent', fn: 'hub/chat', kind: 'hub/llm', status: 'waiting' });
    const bash = run({ id: 'run_b', fn: 'fs/bash', status: 'awaiting-approval', parent: RunId.parse('run_agent') });
    const line = statusLine([agent, ...reads, bash], T0);
    expect(line.groups.map((g) => g.text)).toEqual(['Reading 2 files…']);
    expect(line.lead).toBe('Waiting for your approval');
    expect(statusLine([agent], T0)).toEqual({ groups: [], more: 0, lead: 'Thinking…' });
    expect(statusLine([agent, reads[0] ?? agent], T0).groups.map((g) => g.text)).toEqual(['Reading a.md…']);
    expect(statusLine([run({ status: 'paused' })], T0).lead).toBe('Paused');
  });

  it('says "Thinking harder…" while the model fixes a call that went back to it, never a retry or an error', () => {
    const agent = run({ id: 'run_agent', fn: 'hub/chat', kind: 'hub/llm', status: 'waiting' });
    const slip = run({ id: 'run_slip', fn: 'fs/read', status: 'invalid-input', parent: RunId.parse('run_agent'), startedAt: T0, endedAt: T0 });
    const line = statusLine([agent, slip], T0 + 100);
    expect(line).toEqual({ groups: [], more: 0, lead: THINKING_HARDER_LEAD });
    expect(line.lead).toBe('Thinking harder…');
    expect(lineHasNews(line)).toBe(true);
    // once the model's next call runs, that speaks; once something else happened last, the lead is plain thinking again
    const next = run({ id: 'run_next', fn: 'fs/read', status: 'running', parent: RunId.parse('run_agent'), startedAt: T0 + 50 });
    expect(statusLine([agent, slip, next], T0 + 100).groups.map((g) => g.text)).toEqual(['Read…']);
    const done = { ...next, status: 'done' as const, endedAt: T0 + 60 };
    expect(statusLine([agent, slip, done], T0 + 100_000).lead).toBe(THINKING);
    expect(INVALID_TEXT).toBe('Thinking harder');
  });

  it('says the model’s other slips calmly: a repaired field, a call the hub stopped mid-stream, a tool it wasn’t offered', () => {
    expect(repairedNote({ repairs: [{ path: 'rows', repair: 'json-string' }] })).toBe('The model sent rows as text holding JSON; the hub read it as JSON. No bearing on the result.');
    expect(repairedNote({})).toBe('');
    expect(invalidWhat({ source: 'json', problems: [{ path: '', message: 'x' }], raw: 'Stopped by the hub: these arguments ran into 2000 blank characters' })).toBe('The hub stopped a call the model was still writing (it ran too long)');
    expect(invalidWhat({ source: 'json', problems: [{ path: '', message: 'x' }], raw: '{"a":' })).toBe('The model’s call wasn’t valid JSON');
    expect(toolCallSlip({ name: 'fs__read', arguments: 'Stopped by the hub: the arguments reached the output limit' })).toMatch(/^The hub stopped this call .* No bearing on the result\.$/);
    expect(toolCallSlip({ name: 'fs__reed', arguments: '{}' }, ['fs__read', 'run'])).toMatch(/^Not one of the tools offered .* No bearing on the result\.$/);
    expect(toolCallSlip({ name: 'fs__read', arguments: '{}' }, ['fs__read'])).toBe('');
    expect(toolCallSlip({ name: 'fs__reed', arguments: '{}' })).toBe('');
  });
});

describe('thread', () => {
  it('groups one turn of one agent into one answer, with day separators and notes', () => {
    const user = message({ turn: 'trn_1', createdAt: T0 - 86_400_000 });
    const a1 = message({ turn: 'trn_1', role: 'assistant', author: 'act_agent', createdAt: T0 - 86_399_000 });
    const a2 = message({ turn: 'trn_1', role: 'assistant', author: 'act_agent', status: 'streaming', createdAt: T0 - 86_398_000 });
    const note = message({ turn: 'trn_2', role: 'note', author: 'act_hub', createdAt: T0 });
    const items = threadItems([user, a1, a2, note], user.author, T0);
    expect(items.map((i) => i.kind)).toEqual(['day', 'user', 'answer', 'day', 'note']);
    const answer = items[2];
    expect(answer?.kind === 'answer' && answer.messages.length).toBe(2);
    expect(answer?.kind === 'answer' && answer.streaming).toBe(true);
    expect(items[1]?.kind === 'user' && items[1].mine).toBe(true);
  });

  it('takes an undone turn out of the thread and keeps it on its note, so a retry reads as one question', () => {
    const asked = message({ turn: 'trn_u', createdAt: T0 + 1 });
    const answered = message({ turn: 'trn_u', role: 'assistant', author: 'act_agent', createdAt: T0 + 2 });
    const note = message({ turn: 'trn_u', role: 'note', author: 'act_hub', createdAt: T0 + 3 });
    const again = message({ turn: 'trn_r', parts: asked.parts, createdAt: T0 + 4 });
    expect([...undoneTurns([asked, answered, note, again])]).toEqual(['trn_u']);
    const items = threadItems([asked, answered, note, again], asked.author, T0);
    expect(items.map((i) => i.kind)).toEqual(['day', 'note', 'user']);
    expect(items[1]?.kind === 'note' && items[1].undone.map((m) => m.id)).toEqual([asked.id, answered.id]);
  });

  it('orders an answer as it happened: stored parts in their order, runs the parts do not place before the words', () => {
    const attachment = { type: 'attachment', attachment: 'fs/diff', data: {}, title: 'Diff' } as const;
    const done = message({ role: 'assistant', runs: ['run_1', 'run_2'], parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'All done.' }, attachment] });
    expect(answerPieces(done).map((p) => p.kind)).toEqual(['reasoning', 'runs', 'attachment', 'text']);
    // parts that place their runs keep the exact order
    const ordered = message({
      role: 'assistant', runs: ['run_1', 'run_2'],
      parts: [{ type: 'reasoning', text: 'a' }, { type: 'text', text: 'Looking. ' }, { type: 'call', run: 'run_1', fn: 'fs/bash' }, { type: 'reasoning', text: 'b' }, { type: 'text', text: 'Again.' }, { type: 'call', run: 'run_2', fn: 'fs/bash' }],
    });
    expect(storedSegments(ordered).map((s) => s.kind)).toEqual(['reasoning', 'text', 'runs', 'reasoning', 'text', 'runs']);
  });

  it('keeps live segments in arrival order and settles the stored reply into them', () => {
    let live = addSegment([], { kind: 'reasoning', text: 'Think' });
    live = addSegment(live, { kind: 'reasoning', text: 'ing' });
    live = addSegment(live, { kind: 'text', text: 'Let me look. ' });
    live = addSegment(live, { kind: 'runs', runs: [RunId.parse('run_1')] });
    live = addSegment(live, { kind: 'runs', runs: [RunId.parse('run_1'), RunId.parse('run_2')] });
    live = addSegment(live, { kind: 'text', text: 'Found it.' });
    expect(live).toEqual([{ kind: 'reasoning', text: 'Thinking' }, { kind: 'text', text: 'Let me look. ' }, { kind: 'runs', runs: ['run_1', 'run_2'] }, { kind: 'text', text: 'Found it.' }]);
    const pieces = answerPieces(message({ role: 'assistant', runs: ['run_1', 'run_2', 'run_3'], parts: [] }), live);
    expect(pieces.map((p) => (p.kind === 'runs' ? p.runs.join(',') : p.kind))).toEqual(['reasoning', 'run_3', 'text', 'run_1,run_2', 'text']);
    expect(settleSegments(live, { parts: [{ type: 'text', text: 'Found it.' }] })).toEqual(live);
    expect(settleSegments(live, { parts: [{ type: 'text', text: 'Cancelled.' }] }).at(-1)).toEqual({ kind: 'text', text: 'Found it.Cancelled.' });
  });

  it('names days', () => {
    expect(dayLabel(T0, T0)).toBe('Today');
    expect(dayLabel(T0 - 86_400_000, T0)).toBe('Yesterday');
    expect(dayLabel(T0 - 3 * 86_400_000, T0)).not.toMatch(/Today|Yesterday/);
  });

  it('reads a message as text, and as parts to send again', () => {
    const parts = message({ parts: [
      { type: 'text', text: 'Read' }, { ...mention, text: 'the file' }, { type: 'command', context: 'fs/tree', args: { root: 'src' } },
      { type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'local-time', text: '9:30' }] },
      // what changed in the systems goes to the model only: hidden, not read as words, never sent again
      { type: 'systems-changed', on: [], off: [{ name: SystemName.parse('fs'), reason: 'disconnected' }] },
    ] }).parts;
    expect(messageText(parts)).toBe('Read @harness.md /fs/tree src');
    expect(resendParts(parts).map((p) => p.type)).toEqual(['text', 'mention', 'command']);
    expect(splitParts(parts).added.map((p) => p.type)).toEqual(['extra', 'systems-changed']);
  });

  it('streams tokens into the last text part, and merges pages and updates in order', () => {
    const streaming = message({ role: 'assistant', parts: [] });
    const once = appendToken(streaming, 'Hel');
    expect(appendToken(once, 'lo').parts).toEqual([{ type: 'text', text: 'Hello' }]);
    const a = message({ createdAt: T0 + 1 });
    const b = message({ createdAt: T0 + 2 });
    const c = message({ createdAt: T0 + 3 });
    expect(upsertMessage([a, c], b).map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(upsertMessage([a, b], { ...a, status: 'failed' })[0]?.status).toBe('failed');
    expect(prependPage([c], [c, b, a]).map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });
});

describe('composer rules', () => {
  it('opens the right picker at the caret', () => {
    expect(detectTrigger('look at @har', 12)).toEqual({ kind: 'mention', query: 'har', start: 8, end: 12 });
    expect(detectTrigger('/tre', 4)).toEqual({ kind: 'command', query: 'tre', start: 0, end: 4 });
    expect(detectTrigger('!edit', 5)).toEqual({ kind: 'invoke', query: 'edit', start: 0, end: 5 });
    expect(detectTrigger('mail me@home', 12)).toBeUndefined();
    expect(detectTrigger('say /tre', 8)).toBeUndefined();
    expect(insertText('a @x b', 2, 4, '@File ')).toEqual({ text: 'a @File  b', caret: 8 });
  });

  it('hints the command argument being typed', () => {
    expect(commandHint('/tree ', caps.commands)?.current).toBe(0);
    expect(commandHint('/tree', caps.commands)).toBeUndefined();
    const command = leadingCommand('/tree src', caps.commands);
    expect(command?.name).toBe('tree');
    expect(command === undefined ? {} : commandArgs(command, 'src extra words')).toEqual({ root: 'src extra words' });
    expect(command === undefined ? [] : missingArgs({ ...command, args: [{ name: 'root', hint: '', required: true }] }, {})).toEqual(['root']);
  });

  it('hints why a command typed by hand can’t be used now, even one with no args', () => {
    const on = { name: 'gollum', context: QualifiedName.parse('memory/gollum'), args: [], description: 'Talk like Gollum' };
    expect(commandHint('/gollum what can you do', [{ ...on, unavailable: 'memory has never connected' }])?.command.unavailable).toBe('memory has never connected');
    expect(commandHint('/gollum hi', [on])).toBeUndefined();
  });

  it('sends text, chips and a leading command as parts; a deleted chip is dropped', () => {
    expect(textParts('see @harness.md now', [mention])).toEqual([{ type: 'text', text: 'see ' }, mention, { type: 'text', text: ' now' }]);
    expect(pruneMentions('nothing here', [mention])).toEqual([]);
    expect(draftParts('/tree src\nand explain @harness.md', [mention], caps.commands)).toEqual([
      { type: 'command', context: 'fs/tree', args: { root: 'src' } }, { type: 'text', text: 'and explain ' }, mention,
    ]);
    expect(draftParts('  just words  ', [], caps.commands)).toEqual([{ type: 'text', text: 'just words' }]);
  });

  it('names only the powers on offer, and sends on Enter only with a keyboard', () => {
    expect(placeholderFor(caps, false)).toBe('Message · @ to mention, / for commands, ! to run a fn');
    expect(placeholderFor(capabilities({ mentions: [], commands: [], invocations: [] }), false)).toBe('Message');
    const key = (over: Partial<KeyboardEvent>) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...over });
    expect(enterSends(key({}), false)).toBe(true);
    expect(enterSends(key({ shiftKey: true }), false)).toBe(false);
    expect(enterSends(key({}), true)).toBe(false);
    expect(enterSends(key({ ctrlKey: true }), true)).toBe(true);
    expect(enterSends(key({ isComposing: true }), false)).toBe(false);
  });
});

describe('session facts', () => {
  it('applies the reply rule', () => {
    const solo = session();
    expect(whoAnswers(solo, undefined, false)).toMatchObject({ text: 'Chat agent will answer', usual: true });
    const group = session({ participants: [...solo.participants, { actor: 'act_bea', role: 'member', notify: 'all', joinedAt: T0 }] });
    expect(whoAnswers(group, undefined, false)).toMatchObject({ agents: [], usual: false });
    expect(whoAnswers(group, message({ author: 'act_agent' }), false).agents).toEqual(['act_agent']);
    expect(whoAnswers(group, undefined, true).agents).toEqual(['act_agent']);
  });

  it('shows the tightest budget, amber near it and red at it', () => {
    const limits = ResolvedLimits.parse({
      priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1 }, limitedBy: 'bgt_s',
      budgets: [{ rule: 'bgt_s', scope: { scope: 'session', session: 'ses_1' }, remaining: 0.1 }, { rule: 'bgt_h', scope: { scope: 'hub' }, remaining: 50 }],
    });
    const meter = budgetMeter(limits, 0.9, 0);
    expect(meter?.label).toBe('This session');
    expect(meter?.tone).toBe('warn');
    expect(meter?.rows.find((r) => r.tightest)?.key).toBe('bgt_s');
    expect(budgetMeter(limits, 1, 0.2)?.tone).toBe('danger');
    expect(budgetMeter(undefined, 0, 0)).toBeUndefined();
    const capOnly = budgetMeter(ResolvedLimits.parse({ ...limits, budgets: [], limitedBy: undefined, turn: { cost: 0.5, time: 600_000 } }), 2, 0, 0.45);
    expect(capOnly?.label).toBe('Each turn');
    expect(capOnly?.text).toBe('$0.05 left · Each turn');
    expect(capOnly?.tone).toBe('warn');
    expect(budgetMeter(ResolvedLimits.parse({ ...limits, budgets: [], limitedBy: undefined, turn: { cost: 0, time: 1 } }), 0, 0)).toBeUndefined();
    expect(scopeLabel({ scope: 'user', user: ActorId.parse('act_ada') })).toBe('Your budget');
  });

  it('lists what the index suggested for a message, marking what the agent loaded', () => {
    const blocks = [
      HookBlock.parse({ type: 'suggest-context', items: [{ context: 'fs/readme', why: 'mentions the docs' }] }),
      HookBlock.parse({ type: 'suggest-fns', items: [{ fn: 'fs/read_file' }, { fn: 'fs/write_file' }] }),
      HookBlock.parse({ type: 'load', fns: ['fs/tree'] }),
    ];
    const m = message({ parts: [{ type: 'text', text: 'hi' }, { type: 'extra', extra: 'suggested-fns', blocks }] });
    const found = messageSuggestions(m, session({ tools: ['fs/read_file'] }));
    expect(found.context.map((c) => [c.label, c.why])).toEqual([['Readme', 'mentions the docs']]);
    expect(found.fns.map((f) => [f.name, f.state])).toEqual([['fs/read_file', 'loaded'], ['fs/write_file', 'offered'], ['fs/tree', 'auto']]);
  });

  it('sorts suggestions by score, best first, unscored ones last', () => {
    const blocks = [
      HookBlock.parse({ type: 'suggest-fns', items: [{ fn: 'fs/glob', score: 0.41 }, { fn: 'fs/read_file', score: 0.873 }] }),
      HookBlock.parse({ type: 'load', fns: ['fs/tree'] }),
    ];
    const found = messageSuggestions(message({ parts: [{ type: 'extra', extra: 'suggested-fns', blocks }] }), undefined);
    expect(found.fns.map((f) => [f.name, f.score])).toEqual([['fs/read_file', 0.873], ['fs/glob', 0.41], ['fs/tree', undefined]]);
    expect(scoreText(0.873)).toBe('87%');
    expect(scoreText(1.2)).toBe('100%');
  });

  it('merges the hub’s suggestion record: used items join the parts, left-out ones keep their reason', () => {
    const blocks = [HookBlock.parse({ type: 'suggest-fns', items: [{ fn: 'fs/read_file', score: 0.9, why: 'reads' }] })];
    const found = messageSuggestions(message({
      parts: [{ type: 'extra', extra: 'suggested-fns', blocks }],
      suggestions: { by: 'score', threshold: 0.5, items: [
        { used: true, kind: 'fn', name: 'fs/read_file', score: 0.9, note: 'ignored, the part says why' },
        { used: true, kind: 'context', name: 'fs/readme', note: 'the docs' },
        { used: false, kind: 'fn', name: 'fs/glob', score: 0.2, reason: 'below-threshold' },
        { used: false, kind: 'fn', name: 'fs/tree', score: 0.4, reason: 'declined', note: 'off topic' },
      ] },
    }), undefined);
    expect(found.fns.map((f) => [f.name, f.why])).toEqual([['fs/read_file', 'reads']]);
    expect(found.context.map((c) => [c.name, c.why])).toEqual([['fs/readme', 'the docs']]);
    expect(found.skippedFns?.map((s) => [s.name, skipText(s)])).toEqual([['fs/tree', 'The decision model declined it: off topic'], ['fs/glob', 'Score under the threshold']]);
    expect([found.by, found.threshold]).toEqual(['score', 0.5]);
  });
});

describe('inspect', () => {
  it('walks a tree and adds up its LLM calls', () => {
    const root = tree({ children: [tree({ run: { id: RunId.parse('run_c'), fn: 'fs/edit', status: 'done', cost: 0, totalCost: 0 }, llmCalls: [{ id: llmCall().id, model: 'm', cost: 0, status: 'done' }] })] });
    expect(treeRuns(root)).toEqual(['run_1', 'run_c']);
    expect(treeSize(root)).toBe(2);
    expect(treeCalls(root)).toHaveLength(2);
    const usage = turnUsage([llmCall({ cost: 0.01 }), llmCall({ cost: 0.02, usage: { input: 10, output: 5, cached: 2 } })]);
    expect(usage.cost).toBeCloseTo(0.03);
    expect(usage.input).toBe(1_210);
    expect(usage.firstToken).toBe(400);
    expect(usage.duration).toBe(1_300);
  });

  it('picks the hub’s tagged additions out of what the model saw', () => {
    expect(taggedBlocks('Hi <local-time zone="UTC">9:30</local-time> <suggested-fns>fs/read</suggested-fns>')).toEqual([
      { tag: 'local-time', text: '9:30' }, { tag: 'suggested-fns', text: 'fs/read' },
    ]);
    expect(messageContent({ content: [{ type: 'text', content: 'a' }, { type: 'image', content: 'x', name: 'shot.png' }] })).toBe('a\n[image: shot.png]');
  });
});

describe('keys', () => {
  const press = (over: Partial<KeyboardEvent>) => ({ key: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });
  it('maps key presses to shortcuts, keeping plain keys quiet while typing', () => {
    expect(shortcutFor(press({ key: 'k', ctrlKey: true }), true)).toBe('search');
    expect(shortcutFor(press({ key: 'O', metaKey: true, shiftKey: true }), false)).toBe('new-chat');
    expect(shortcutFor(press({ key: 'ArrowDown', altKey: true }), true)).toBe('next-chat');
    expect(shortcutFor(press({ key: '/' }), false)).toBe('focus-composer');
    expect(shortcutFor(press({ key: '/' }), true)).toBeUndefined();
    expect(shortcutFor(press({ key: '?' }), false)).toBe('help');
  });

  it('knows which elements take typing', () => {
    const text = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect([isTyping(text), isTyping(box), isTyping(document.createElement('textarea')), isTyping(document.createElement('div')), isTyping(null)]).toEqual([true, false, true, false, false]);
  });
});

describe('a result in brief', () => {
  it('shows text as text, a text-carrying object as its text, and anything else as JSON', () => {
    expect(resultBrief(undefined)).toBe('');
    expect(resultBrief(null)).toBe('');
    expect(resultBrief('done')).toBe('done');
    expect(resultBrief(3)).toBe('3');
    expect(resultBrief({ text: '# README\nhello', lines: 2 })).toBe('# README\nhello');
    expect(resultBrief({ cwd: '/repo' })).toBe('/repo');
    expect(resultBrief({ exitCode: 0, stdout: 'x' })).toBe('{\n  "exitCode": 0,\n  "stdout": "x"\n}');
    expect(resultBrief(['a'])).toBe('[\n  "a"\n]');
  });
});

describe('yes-or-no questions', () => {
  it("name the yes button with the question's own verb", () => {
    expect(confirmVerb('Run this command? Your shell setting asks first.')).toBe('Run');
    expect(confirmVerb('overwrite a.md?')).toBe('Overwrite');
    expect(confirmVerb('Pick a folder')).toBe('Yes');
    expect(confirmVerb('42?')).toBe('Yes');
  });
});

describe('type methods', () => {
  it('are offered for the hovered type, asking only for args besides self', () => {
    const offered = methodsOf(caps.methods, 'fs/Entry');
    expect(offered.map((m) => [m.fn, m.label, m.own === undefined])).toEqual([['fs/Entry.reveal', 'Reveal', true], ['fs/Entry.rename', 'Rename', false]]);
    expect(offered[1]?.own).toEqual({ name: 'obj', props: { to: { type: { name: 'text' } } } });
    expect(methodsOf(caps.methods, undefined)).toEqual([]);
    expect(methodsOf(caps.methods, 'git/Commit')).toEqual([]);
    expect(ownArgs({ name: 'text' })).toBeUndefined();
  });

  it('run on the value as self', () => {
    expect(methodArgs({ to: 'b.md' }, { path: 'a.md' })).toEqual({ to: 'b.md', self: { path: 'a.md' } });
    expect(methodArgs(null, { path: 'a.md' })).toEqual({ self: { path: 'a.md' } });
  });
});

describe('agent and model pickers', () => {
  it('list the agents with the current one first, even one the hub no longer offers', () => {
    expect(agentOptions(caps.agents, 'fs/explore').map((a) => a.name)).toEqual(['Explore agent', 'Chat agent']);
    expect(agentOptions(caps.agents, 'crm/coach').map((a) => a.fn)).toEqual(['crm/coach', 'hub/chat', 'fs/explore']);
  });

  it("round-trip a chat's model through the picker and name it", () => {
    expect(modelPick(undefined)).toBe('default');
    expect(modelPick({ model: 'meta/llama-free' })).toBe('model:meta/llama-free');
    expect(modelPick({ category: 'fast' })).toBe('default');
    expect(modelChoiceOf('default')).toBeNull();
    expect(modelChoiceOf('model:meta/llama-free')).toEqual({ model: 'meta/llama-free' });
    expect(modelLabel(undefined, caps.models)).toBe('Agent’s model');
    expect(modelLabel({ model: 'meta/llama-free' }, caps.models)).toBe('Llama (free)');
    expect(modelLabel({ model: 'x/unknown' }, caps.models)).toBe('x/unknown');
    expect(modelLabel({ category: 'fast' }, caps.models)).toBe('Fast models');
    expect(modelLabel({ auto: {} }, caps.models)).toBe('Automatic');
  });
});

describe('a run waiting on the person', () => {
  it('shows as waiting for their answer, not busy, until it settles', () => {
    const asking = { ...run({ status: 'running' }), asking: true };
    expect(shownStatus(asking)).toBe('waiting');
    expect(isBusy(asking)).toBe(false);
    expect(runText(asking)).toBe(ASKING_TEXT);
    expect(phaseOf(asking)).toBe('waiting');
    expect(statusLine([asking], T0).lead).toBe(ASKING_TEXT);
    const done = { ...asking, status: 'done' as const };
    expect(shownStatus(done)).toBe('done');
    expect(runText(done)).not.toBe(ASKING_TEXT);
  });

  it('applies a move to the background', () => {
    expect(applyRunUpdate(emptyRun(RunId.parse('run_1'), 'fs/bash', 'running'), { type: 'background' }, T0).background).toBe(true);
  });
});

describe('run statuses, the drawer and fn display', () => {
  it('classes every status, and sorts the status line by phase', () => {
    expect(RUN_STATUSES.filter(isActive)).toEqual(['queued', 'running', 'waiting']);
    expect(PHASES).toEqual(['active', 'retry', 'waiting', 'failed', 'done']);
  });

  it('lays what the thread heard live over the drawer’s record until the record settles, then refetches', () => {
    const record = run({ id: RunId.parse('run_d'), status: 'running', progress: { fraction: 0.01 } });
    const live = { ...record, progress: { fraction: 0.3 }, cost: 0.02 };
    expect(drawerRun(live, record)).toMatchObject({ progress: { fraction: 0.3 }, cost: 0.02, args: record.args });
    expect(drawerRun(live, undefined)).toBe(live);
    expect(drawerRun(undefined, record)).toBe(record);
    const settled = run({ id: RunId.parse('run_d'), status: 'done', outcome: { status: 'done', result: { exitCode: 0 } } });
    expect(drawerRun({ ...live, status: 'running' }, settled)).toBe(settled);
    expect(recordIsBehind({ id: record.id, status: 'done' }, record)).toBe(true);
    expect(recordIsBehind({ id: record.id, status: 'running' }, record)).toBe(false);
    expect(recordIsBehind({ id: record.id, status: 'done' }, settled)).toBe(false);
    expect(recordIsBehind(undefined, record)).toBe(false);
  });

  it('keeps a card while a run goes or fails, then shows it as its fn declares', () => {
    expect(runShows({ status: 'running' }, 'hidden')).toBe('card');
    expect(runShows({ status: 'failed' }, 'hidden')).toBe('card');
    expect(runShows({ status: 'done' }, 'hidden')).toBe('hidden');
    expect(runShows({ status: 'done' }, 'message')).toBe('message');
    const found = run({ fn: 'hub/search_fns', status: 'done', outcome: { status: 'done', result: 'fs/read_file and fs/write' } });
    expect(runMessage(found)).toBe('Search fns done: fs/read_file and fs/write');
    expect(runMessage(run({ fn: 'hub/search_fns', status: 'done', outcome: { status: 'done', result: [{ fn: 'fs/read' }, { fn: 'fs/edit' }] } }))).toBe('Search fns done: 2 found');
    expect(runMessage(run({ fn: 'hub/fns_load', status: 'done' }))).toBe('Fns load done');
    expect(runMessage(run({ fn: 'hub/ctx_load', status: 'done' }))).toBe('Context load done');
  });
});

describe('model picker', () => {
  const free = { id: 'meta/llama-free', provider: 'openrouter', name: 'Llama (free)', contextWindow: 131_072, pricing: { input: 0, output: 0 }, capabilities: ['chat', 'tools'] } as const;
  const paid = { id: 'acme/vision', provider: 'openrouter', name: 'Acme vision', contextWindow: 1_000_000, pricing: { input: 3, output: 15 }, capabilities: ['chat', 'vision', 'reasoning'] } as const;
  const unknown = { id: 'x/mystery', provider: 'openrouter', name: 'Mystery', capabilities: ['chat'] } as const;
  const variant = { id: 'google/gemma:free', provider: 'openrouter', name: 'Gemma (free)', capabilities: ['chat'] } as const;
  const models: ModelInfo[] = [paid, free, unknown].map((m) => ({ ...m, capabilities: [...m.capabilities] }));
  const ids = (query: Partial<ModelQuery>): string[] => findModels(models, { text: '', filters: new Set(), sort: 'name', ...query }).map((m) => m.id);

  it('searches by words, where a filter word filters, and narrows by filter chips', () => {
    expect(ids({})).toEqual(['acme/vision', 'meta/llama-free', 'x/mystery']);
    expect(ids({ text: 'free' })).toEqual(['meta/llama-free']);
    expect(ids({ text: 'acme vision' })).toEqual(['acme/vision']);
    expect(ids({ filters: new Set(['tools']) })).toEqual(['meta/llama-free']);
    expect(ids({ filters: new Set(['reasoning', 'vision']) })).toEqual(['acme/vision']);
    expect(ids({ text: 'nothing like it' })).toEqual([]);
  });

  it('sorts by price (unknown last) and context (largest first), and says price, context and abilities', () => {
    expect(ids({ sort: 'price' })).toEqual(['meta/llama-free', 'acme/vision', 'x/mystery']);
    expect(ids({ sort: 'context' })).toEqual(['acme/vision', 'meta/llama-free', 'x/mystery']);
    const [p, f, u] = models;
    if (p === undefined || f === undefined || u === undefined) { throw new Error('models missing'); }
    expect([priceText(f), priceText(p), priceText(u)]).toEqual(['Free', '$3.00 in · $15.00 out per M tokens', 'Price unknown']);
    expect([contextText(f), contextText(p), contextText(u)]).toEqual(['131k context', '1.0M context', '']);
    expect([isFree(f), isFree(u), isFree({ ...variant, capabilities: [...variant.capabilities] })]).toEqual([true, false, true]);
    expect(abilities(p)).toEqual(['vision', 'reasoning']);
  });
});

describe('invocation carriers', () => {
  it('shows what a `!` run attached under the message that ran it, not as an answer by its system', () => {
    const asked = message({ id: 'msg_inv', turn: 'trn_inv', parts: [{ type: 'invocation', run: 'run_w', fn: 'fs/write' }], runs: ['run_w'] });
    const carrier = message({ id: 'msg_car', turn: 'trn_inv', role: 'assistant', author: 'act_fs', replyTo: 'msg_inv', runs: ['run_w'], parts: [] });
    const other = message({ id: 'msg_ans', turn: 'trn_x', role: 'assistant', author: 'act_agent', replyTo: 'msg_other', parts: [{ type: 'text', text: 'Hi' }] });
    expect(invocationCarriers([asked, carrier, other])).toEqual(new Map([['msg_inv', [carrier]]]));
    const items = threadItems([asked, carrier, other], ActorId.parse(asked.author), T0);
    expect(items.filter((i) => i.kind !== 'day').map((i) => i.kind)).toEqual(['user', 'answer']);
    const user = items.find((i) => i.kind === 'user');
    expect(user?.kind === 'user' ? user.carried : []).toEqual([carrier]);
  });
});

describe('turn controls', () => {
  const latest = { last: true, undoable: true, continuable: false, asked: true };

  it('offers nothing on an older turn, which the hub would refuse to undo while a later turn stands (regression)', () => {
    expect(turnVerbs({ ...latest, last: false })).toEqual([]);
    expect(turnVerbs({ ...latest, last: false, continuable: true })).toEqual([]);
  });

  it('offers Retry and Undo on the latest turn only while the hub lets it be undone, and Retry only with a question to resend', () => {
    expect(turnVerbs(latest)).toEqual(['retry', 'undo']);
    expect(turnVerbs({ ...latest, undoable: false })).toEqual([]);
    expect(turnVerbs({ ...latest, asked: false })).toEqual(['undo']);
  });

  it('offers Continue first when the latest turn\'s run can carry on', () => {
    expect(turnVerbs({ ...latest, continuable: true })).toEqual(['continue', 'retry', 'undo']);
  });
});

describe('run control', () => {
  const a = { run: RunId.parse('run_a'), fn: QualifiedName.parse('fs/bash'), status: 'running', pause: true, resume: false, cancel: true } as const;
  const b = { run: RunId.parse('run_b'), fn: QualifiedName.parse('fs/glob'), status: 'paused', pause: false, resume: true, cancel: false } as const;
  const controls = { pause: true, cancel: true, uncancellable: [], undoLastTurn: false, runs: [a, b] };

  it('names no runs for all, and only the chosen runs that allow the action otherwise', () => {
    expect(controlPlan(controls, false, 'all', 'pause')).toEqual({ enabled: true, runs: undefined });
    expect(controlPlan(controls, false, 'all', 'resume').enabled).toBe(true);
    expect(controlPlan(controls, false, new Set([b.run]), 'cancel')).toEqual({ enabled: false, runs: [] });
    expect(controlPlan(controls, false, new Set([a.run, b.run]), 'resume')).toEqual({ enabled: true, runs: [b.run] });
    expect(controlPlan(undefined, false, 'all', 'cancel').enabled).toBe(true);
  });

  it('lists runs only when there is a choice, and goes back to all when every run is chosen', () => {
    expect(choosableRuns({ ...controls, runs: [a] })).toEqual([]);
    const one = toggleRun('all', a.run, [a, b]);
    expect(one).toEqual(new Set([b.run]));
    expect(toggleRun(one, a.run, [a, b])).toBe('all');
  });

  it('spots words that only repeat the args', () => {
    expect([repeatsArgs('Running ls -la', 'ls -la'), repeatsArgs('Read 3 files', 'src'), repeatsArgs('Thinking', '')]).toEqual([true, false, false]);
  });
});
