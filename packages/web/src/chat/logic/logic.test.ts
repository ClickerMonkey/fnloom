import { ActorId, HookBlock, ResolvedLimits, RunId, type ChatCapabilities } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { capabilities, llmCall, message, run, session, T0, tree } from '../test/fakes.ts';
import {
  commandArgs, commandHint, detectTrigger, draftParts, enterSends, insertText, leadingCommand, missingArgs, placeholderFor, pruneMentions, textParts, type DraftMention,
} from './composer.ts';
import { clamp, formatBytes, formatCost, formatDuration, formatTokens } from './format.ts';
import { messageContent, taggedBlocks, treeCalls, treeRuns, treeSize, turnUsage } from './inspect.ts';
import { isTyping, shortcutFor } from './keys.ts';
import { agentName, fnLabel, humanize, localName, lowerFirst, systemOf } from './labels.ts';
import { applyRunUpdate, argSummary, emptyRun, mergeRecord, phaseOf, progressFraction, runElapsed, runError, runResult, runText, statusLine } from './runs.ts';
import { budgetMeter, messageSuggestions, scopeLabel, whoAnswers } from './session.ts';
import { appendToken, dayLabel, messageText, prependPage, resendParts, splitParts, threadItems, upsertMessage } from './thread.ts';

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
    expect([formatCost(0), formatCost(0.004), formatCost(0.031), formatCost(240)]).toEqual(['$0', '<$0.01', '$0.03', '$240']);
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
    expect(runText({ ...base, status: 'running', attempt: 2 })).toBe('Retrying read file… (attempt 2)');
    expect(runText({ ...base, status: 'done' })).toBe('Read file');
    expect(runText({ ...base, status: 'failed' })).toBe('Read file failed');
    expect(runText({ ...base, status: 'awaiting-approval' })).toBe('Waiting for approval to read file');
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
    expect(line.groups.map((g) => g.text)).toEqual(['Read file ×3…', 'Write file']);
    expect(line.lead).toBe('');
    expect(statusLine([write], T0 + 10_000).groups).toEqual([]);
    expect(statusLine([], T0).lead).toBe('Thinking…');
    expect(statusLine([run({ status: 'awaiting-approval' })], T0).lead).toBe('Waiting for your approval');
    const many = ['a', 'b', 'c', 'd', 'e'].map((name) => run({ id: `run_${name}`, fn: `fs/${name}`, status: 'running' }));
    expect(statusLine(many, T0).more).toBe(2);
    expect(phaseOf({ status: 'running', attempt: 2 })).toBe('retry');
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

  it('names days', () => {
    expect(dayLabel(T0, T0)).toBe('Today');
    expect(dayLabel(T0 - 86_400_000, T0)).toBe('Yesterday');
    expect(dayLabel(T0 - 3 * 86_400_000, T0)).not.toMatch(/Today|Yesterday/);
  });

  it('reads a message as text, and as parts to send again', () => {
    const parts = message({ parts: [
      { type: 'text', text: 'Read' }, { ...mention, text: 'the file' }, { type: 'command', context: 'fs/tree', args: { root: 'src' } },
      { type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'local-time', text: '9:30' }] },
    ] }).parts;
    expect(messageText(parts)).toBe('Read @harness.md /fs/tree src');
    expect(resendParts(parts).map((p) => p.type)).toEqual(['text', 'mention', 'command']);
    expect(splitParts(parts).added).toHaveLength(1);
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
    expect(whoAnswers(solo, undefined, false).text).toBe('Chat agent will answer');
    const group = session({ participants: [...solo.participants, { actor: 'act_bea', role: 'member', notify: 'all', joinedAt: T0 }] });
    expect(whoAnswers(group, undefined, false).agents).toEqual([]);
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
    expect(meter?.rows.find((r) => r.tightest)?.rule).toBe('bgt_s');
    expect(budgetMeter(limits, 1, 0.2)?.tone).toBe('danger');
    expect(budgetMeter(undefined, 0, 0)).toBeUndefined();
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
