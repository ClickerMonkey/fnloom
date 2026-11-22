import { citeMarker, citeMarkersAsText, IDS, pathSteps, valueAt, type Json, type Run, type TurnId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { CiteFilter, citeParts, piecesText, readCite, streamingParts, type CitePiece } from './cites.ts';
import { CITATION_RULE, CITATIONS_CHANGED_TAG, CITATIONS_OFF, CITATIONS_ON_AGAIN, citationsNotice, citationsPrompt, citeIdLine, withCiteId } from './cite-rule.ts';
import { agentActorId } from './support.ts';
import { CLIENT, chatWorld, makeRun, settle } from './testing.ts';
import { plainText, startOf } from './turns.ts';

const HOLD = 200;
const chatAgent = agentActorId('hub/chat');
const M = (n: number): string => citeMarker(n);

/** What a filter lets out for these chunks, ended. */
function stream(chunks: readonly string[], hold = HOLD): CitePiece[] {
  const filter = new CiteFilter(hold);
  return [...chunks.flatMap((chunk) => filter.push(chunk)), ...filter.end()];
}

describe('the cite stream filter', () => {
  it('holds a cite back until it closes, however it is split, then lets it out whole', () => {
    const cite = '<cite tool="run_1" path="rows.0">the first row</cite>';
    for (let cut = 1; cut < cite.length; cut++) {
      const filter = new CiteFilter(HOLD);
      const first = filter.push(`Due Friday ${cite.slice(0, cut)}`);
      // nothing of the cite shows before it is whole
      expect(piecesText(first)).toBe('Due Friday ');
      const rest = filter.push(`${cite.slice(cut)}.`);
      expect(rest).toEqual([{ type: 'cite', cite: { index: 1, tool: 'run_1', path: 'rows.0', note: 'the first row' }, text: M(1) }, { type: 'text', text: '.' }]);
    }
  });

  it('lets out text that only looks like a cite at first, and tags that are not cites', () => {
    expect(piecesText(stream(['a <ci', 'tation> b']))).toBe('a <citation> b');
    expect(piecesText(stream(['x < y and <b>bold</b>']))).toBe('x < y and <b>bold</b>');
    expect(piecesText(stream(['ends with <c']))).toBe('ends with <c');
  });

  it('gives up on a cite that runs past the hold and shows it as text', () => {
    const long = `<cite tool="run_1" path="">${'x'.repeat(300)}`;
    const pieces = stream([long, '</cite> after'], HOLD);
    expect(pieces.every((p) => p.type === 'text')).toBe(true);
    expect(piecesText(pieces)).toBe(`${long}</cite> after`);
  });

  it('numbers cites in order, reads either quote, entities and self-closed tags', () => {
    const pieces = stream([`A<cite path='a.b' tool='call_9'>x &amp; y</cite> B<cite tool="run_2" path="" /> C`]);
    expect(pieces.flatMap((p) => (p.type === 'cite' ? [p.cite] : []))).toEqual([
      { index: 1, tool: 'call_9', path: 'a.b', note: 'x & y' }, { index: 2, tool: 'run_2', path: '', note: '' },
    ]);
    expect(piecesText(pieces)).toBe(`A${M(1)} B${M(2)} C`);
    expect(readCite('<cite>why</cite>')).toEqual({ tool: '', path: '', note: 'why' });
  });
});

describe('a finished message\'s cites', () => {
  it('takes every whole cite out of the text parts, numbering across parts, and leaves an unclosed one as written', () => {
    const { parts, cites } = citeParts([
      { type: 'text', text: 'One <cite tool="run_1" path="a">a</cite>' },
      { type: 'call', run: IDS.run.parse('run_1'), fn: 'fs/read' },
      { type: 'text', text: 'Two <cite tool="run_2" path="b">b</cite> and <cite tool="x"' },
    ], HOLD);
    expect(parts).toEqual([
      { type: 'text', text: `One ${M(1)}` }, { type: 'call', run: 'run_1', fn: 'fs/read' }, { type: 'text', text: `Two ${M(2)} and <cite tool="x"` },
    ]);
    expect(cites.map((c) => c.index)).toEqual([1, 2]);
  });

  it('reads mid-stream with whole cites as markers and the one still coming left out', () => {
    expect(streamingParts([{ type: 'text', text: 'A <cite tool="r" path="">n</cite> B <cite tool' }], HOLD)).toEqual([{ type: 'text', text: `A ${M(1)} B ` }]);
  });

  it('turns markers into [n] for plain text', () => {
    expect(citeMarkersAsText(`Due ${M(1)} and ${M(2)}`, [{ index: 1, number: 4 }])).toBe('Due [4] and ');
    expect(plainText([{ type: 'text', text: `Due ${M(1)}.` }])).toBe('Due .');
  });
});

describe('a cite\'s path', () => {
  it('reads dots, brackets and the whole value', () => {
    expect(pathSteps('results.0.title')).toEqual(['results', '0', 'title']);
    expect(pathSteps('$.rows[3]["a b"]')).toEqual(['rows', '3', 'a b']);
    expect(pathSteps('')).toEqual([]);
    const value = { results: [{ title: 'Lisbon' }], text: '{"n":2}' };
    expect(valueAt(value, 'results.0.title')).toEqual({ value: 'Lisbon' });
    expect(valueAt(value, '')).toEqual({ value });
    expect(valueAt(value, 'text.n')).toEqual({ value: 2 });
    expect(valueAt(value, 'results.1')).toBeUndefined();
    expect(valueAt(value, 'results.title')).toBeUndefined();
  });
});

describe('telling the model', () => {
  it('puts the rule in the system prompt when on at the first turn, and tells each later change once', () => {
    expect(citationsPrompt({ citations: true })).toBe(CITATION_RULE);
    expect(citationsPrompt({ citations: true, citationsTold: { prompt: false, on: true } })).toBe('');
    expect(citationsNotice(undefined, true)).toEqual({ told: { prompt: true, on: true } });
    const told = { prompt: false, on: false };
    expect(citationsNotice(told, false)).toEqual({ told });
    const on = citationsNotice(told, true);
    expect(on.notice).toContain(`<${CITATIONS_CHANGED_TAG}>`);
    expect(on.notice).toContain(CITATION_RULE);
    expect(on.told).toEqual({ prompt: false, on: true });
    expect(citationsNotice({ prompt: true, on: false }, true).notice).toContain(CITATIONS_ON_AGAIN);
    expect(citationsNotice({ prompt: true, on: true }, false).notice).toContain(CITATIONS_OFF);
  });

  it('starts each tool result with its id', () => {
    const run = IDS.run.parse('run_7');
    expect(withCiteId(run, '{"a":1}')).toBe(`${citeIdLine(run)}\n{"a":1}`);
    expect(CITATION_RULE).toContain('tool id: run_');
  });
});

/** A chat with citations on and a finished run of its first turn to cite. */
async function citingWorld() {
  const w = await chatWorld();
  await w.chat.sessions.update(w.session.id, { citations: true }, w.admin.id);
  const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'When is it due?' }] });
  const run = async (id: string, turn: TurnId, result: Json, extra: Partial<Run> = {}): Promise<Run> => w.store.table('runs').insert(makeRun({
    id: IDS.run.parse(id), fn: 'fs/read', turn, actor: w.admin.id, session: w.session.id, outcome: { status: 'done', result }, ...extra,
  }));
  /** A turn's agent run is done and the turn settles, so a later turn can follow (and the last be undone). */
  const done = async (turn: TurnId): Promise<void> => {
    const root = (await w.store.table('turns').get(turn))?.root;
    if (root !== undefined) { await w.store.table('runs').update(root, { status: 'done' }); }
    await w.chat.turns.settle(turn, 'done');
  };
  return { ...w, sent, run, done };
}

describe('citations in a chat', () => {
  it('streams no partial cite, sends each whole one, and stores them resolved and numbered on the message', async () => {
    const w = await citingWorld();
    await w.run('run_a', w.sent.turn, { items: [{ due: '2026-11-27' }] }, { toolCallId: 'call_a' });
    const answer = await w.chat.turns.begin({ turn: w.sent.turn, author: chatAgent });
    for (const chunk of ['Friday <ci', 'te tool="call_a" path="items.0.due">due date</ci', 'te>; also <cite tool="run_zz" path="x">gone</cite>', ' and <cite tool="run_a" path="nope">no</cite>.']) {
      w.chat.turns.stream(answer.id, { text: chunk });
    }
    // a page read mid-stream shows markers, never the XML
    expect((await w.chat.sessions.messages(w.session.id, w.admin.id, {})).items[0]?.parts).toEqual([{ type: 'text', text: `Friday ${M(1)}; also ${M(2)} and ${M(3)}.` }]);
    const done = await w.chat.turns.finish(answer.id, [{ type: 'text', text: 'Friday <cite tool="call_a" path="items.0.due">due date</cite>; also <cite tool="run_zz" path="x">gone</cite> and <cite tool="run_a" path="nope">no</cite>.' }], 'done');
    expect(done.parts).toEqual([{ type: 'text', text: `Friday ${M(1)}; also ${M(2)} and ${M(3)}.` }]);
    expect(done.citations).toEqual([
      { index: 1, number: 1, tool: 'call_a', path: 'items.0.due', note: 'due date', run: 'run_a', fn: 'fs/read', found: 'result', value: '2026-11-27' },
      { index: 2, number: 2, tool: 'run_zz', path: 'x', note: 'gone', problem: 'No tool call of this chat has the id run_zz.' },
      { index: 3, number: 3, tool: 'run_a', path: 'nope', note: 'no', run: 'run_a', fn: 'fs/read', problem: 'Its result has nothing at nope.' },
    ]);
    await settle();
    const tokens = w.bus.of('message.token').map((t) => t.text);
    expect(tokens.some((t) => t.includes('<cite') || t.includes('</ci') || t.endsWith('<ci'))).toBe(false);
    expect(tokens.join('')).toBe(`Friday ${M(1)}; also ${M(2)} and ${M(3)}.`);
    expect(w.bus.of('message.cite').map((e) => e.cite)).toEqual([
      { index: 1, number: 1, tool: 'call_a', path: 'items.0.due', note: 'due date' },
      { index: 2, number: 2, tool: 'run_zz', path: 'x', note: 'gone' }, { index: 3, number: 3, tool: 'run_a', path: 'nope', note: 'no' },
    ]);
  });

  it('keeps an answer with no cites as cited nothing, numbers on across the chat, and leaves a large value to the run', async () => {
    const w = await citingWorld();
    const deps = w.deps.settings.chat;
    const first = await w.chat.turns.begin({ turn: w.sent.turn, author: chatAgent });
    expect((await w.chat.turns.finish(first.id, [{ type: 'text', text: 'No idea.' }], 'done')).citations).toEqual([]);
    await w.done(w.sent.turn);
    const next = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'And now?' }] });
    await w.run('run_b', next.turn, { big: 'x'.repeat(deps.HARNESS_CITE_VALUE_CHARS + 1), rows: [[1], [2]] });
    const second = await w.chat.turns.begin({ turn: next.turn, author: chatAgent });
    const done = await w.chat.turns.finish(second.id, [{ type: 'text', text: 'A <cite tool="run_b" path="big">b</cite> B <cite tool="run_b" path="rows.1.0">r</cite>' }], 'done');
    expect(done.citations?.map((c) => ({ n: c.number, large: c.large, value: c.value }))).toEqual([{ n: 1, large: true, value: undefined }, { n: 2, large: undefined, value: 2 }]);
    await w.done(next.turn);
    const third = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'Again' }] });
    const answer = await w.chat.turns.begin({ turn: third.turn, author: chatAgent });
    const again = await w.chat.turns.finish(answer.id, [{ type: 'text', text: 'C <cite tool="run_b" path="">all</cite>' }], 'done');
    expect(again.citations?.[0]?.number).toBe(3);
  });

  it('gives an undone turn\'s numbers again, and puts back what the model was told', async () => {
    const w = await citingWorld();
    await w.run('run_a', w.sent.turn, { n: 1 });
    const answer = await w.chat.turns.begin({ turn: w.sent.turn, author: chatAgent });
    await w.chat.turns.finish(answer.id, [{ type: 'text', text: 'One <cite tool="run_a" path="n">n</cite>' }], 'done');
    await w.done(w.sent.turn);
    await w.store.table('sessions').update(w.session.id, { citationsTold: { prompt: true, on: true } });
    const next = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'More' }] });
    expect((await w.store.table('turns').get(next.turn))?.start?.citationsTold).toEqual({ prompt: true, on: true });
    const second = await w.chat.turns.begin({ turn: next.turn, author: chatAgent });
    expect((await w.chat.turns.finish(second.id, [{ type: 'text', text: 'Two <cite tool="run_a" path="">a</cite>' }], 'done')).citations?.[0]?.number).toBe(2);
    await w.done(next.turn);
    // the model was told citations went off in that turn; undoing it puts the record back, so a retry tells it again
    await w.store.table('sessions').update(w.session.id, { citationsTold: { prompt: true, on: false } });
    await w.chat.undo.undoTurn(next.turn, w.admin.id);
    expect((await w.store.table('sessions').get(w.session.id))?.citationsTold).toEqual({ prompt: true, on: true });
    const retry = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'More' }] });
    const third = await w.chat.turns.begin({ turn: retry.turn, author: chatAgent });
    expect((await w.chat.turns.finish(third.id, [{ type: 'text', text: 'Two <cite tool="run_a" path="">a</cite>' }], 'done')).citations?.[0]?.number).toBe(2);
  });

  it('leaves cites alone with citations off', async () => {
    const w = await chatWorld();
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'hi' }] });
    const answer = await w.chat.turns.begin({ turn: sent.turn, author: chatAgent });
    w.chat.turns.stream(answer.id, { text: 'A <cite' });
    const done = await w.chat.turns.finish(answer.id, [{ type: 'text', text: 'A <cite tool="r">x</cite>' }], 'done');
    expect(done.citations).toBeUndefined();
    expect(done.parts).toEqual([{ type: 'text', text: 'A <cite tool="r">x</cite>' }]);
    await settle();
    expect(w.bus.of('message.token').map((t) => t.text)).toEqual(['A <cite']);
    expect(startOf({ transcript: [], tools: [], context: [] }).citationsTold).toBeUndefined();
  });
});
