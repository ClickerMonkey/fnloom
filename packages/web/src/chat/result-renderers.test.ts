/**
 * The result-renderer slot in the chat (item 9): a finished run whose system's build has a result renderer
 * (`client({ results })`, by fn or kind) is drawn by it under the card's own line, which then leaves the args out; a
 * fn renderer still wins; a run not yet done, or with no result renderer, draws as before (rows, or the result in
 * brief).
 */
import { Json, QualifiedName, RunId } from '@harness/core';
import { client, fn, g, kind, system, type ResultView, type ResultViewOf, type UntypedFn, type WithSystem } from '@harness/sdk';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { h } from 'vue';
import RunCard from './components/RunCard.vue';
import { emptyRun, type RunView } from './logic/runs.ts';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import { SAMPLE_TABLE } from '../data/test/samples.ts';

const boards = system('boards', { description: 'Boards.' }).with({
  kinds: { board: kind({ description: 'A board.', applicability: 'Boards.', payload: g.obj({}) }) },
  fns: { pin: fn({ description: 'Pin.', args: g.obj({ note: g.text() }), returns: g.obj({ pinned: g.text() }) }) },
});
const Pinned = (view: ResultViewOf<typeof boards, 'pin'>) => h('p', { 'data-testid': 'pinned' }, `${view.title}: ${view.result.pinned}`);
const Board = (view: ResultView<UntypedFn> & WithSystem<(typeof boards)['defs']>) => h('p', { 'data-testid': 'board' }, JSON.stringify(view.result));

function storesWithBoards() {
  const fakes = fakeStores({ signedIn: true });
  fakes.stores.chat.renderers.runtime.register(client(boards, { results: { fns: { pin: Pinned }, kinds: { board: Board } } }));
  return fakes;
}

function doneRun(fnName: string, args: Json, result: Json, kindName?: string): RunView {
  return { ...emptyRun(RunId.parse('run_r1'), QualifiedName.parse(fnName), 'done'), kind: kindName === undefined ? 'native' : QualifiedName.parse(kindName), args, outcome: { status: 'done', result } };
}

function card(run: RunView, fakes = storesWithBoards()) {
  return mount(RunCard, { props: { run, now: 0, collapsed: false }, global: { provide: { [STORES]: fakes.stores } } });
}

describe('result renderers in the run card', () => {
  it("draws a done run's result with its fn's result renderer, and leaves the args off the line", () => {
    const wrapper = card(doneRun('boards/pin', { note: 'milk' }, { pinned: 'milk' }));
    expect(wrapper.get('[data-testid=pinned]').text()).toBe('Pin: milk');
    expect(wrapper.find('.about').exists()).toBe(false);
    expect(wrapper.find('pre.brief').exists()).toBe(false);
  });

  it("draws a fn of a kind with the kind's result renderer, and rows or the brief without one", () => {
    expect(card(doneRun('other/shelf', {}, { rows: 1 }, 'boards/board')).get('[data-testid=board]').text()).toBe('{"rows":1}');
    const plain = card(doneRun('other/shelf', { a: 1 }, 'just text'));
    expect(plain.find('[data-testid=board]').exists()).toBe(false);
    expect(plain.get('pre.brief').text()).toContain('just text');
    expect(card(doneRun('other/rows', {}, Json.parse(SAMPLE_TABLE))).find('[data-testid=widget-view]').exists()).toBe(true);
  });

  it('waits for a run to be done, and lets a fn renderer win', () => {
    const running: RunView = { ...doneRun('boards/pin', { note: 'milk' }, { pinned: 'milk' }), status: 'running', outcome: undefined };
    expect(card(running).find('[data-testid=pinned]').exists()).toBe(false);
    // a build with a fn renderer for pin too: the chat hands its view to the card, which draws it and no result renderer
    const fakes = fakeStores({ signedIn: true });
    fakes.stores.chat.renderers.runtime.register(client(boards, { fns: { pin: () => h('i', { 'data-testid': 'fn-renderer' }) }, results: { fns: { pin: Pinned } } }));
    const done = doneRun('boards/pin', { note: 'milk' }, { pinned: 'milk' });
    const own = fakes.stores.chat.renderers.fnView(done, {});
    expect(own).toBeDefined();
    const wrapper = mount(RunCard, { props: { run: done, now: 0, collapsed: false, view: own }, global: { provide: { [STORES]: fakes.stores } } });
    expect(wrapper.find('[data-testid=fn-renderer]').exists()).toBe(true);
    expect(wrapper.find('[data-testid=pinned]').exists()).toBe(false);
  });
});

