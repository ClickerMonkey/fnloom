import { mintId, type ChangeSet, type FileChange } from '@harness/core';
import type { FnViewOf, SystemClient } from '@harness/sdk';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { FsContract, fs } from '../shared/index.ts';
import BashView from './BashView.vue';
import DiffView from './DiffView.vue';
import EntryInput from './EntryInput.vue';
import { fakeFsSystem as fakeSystem } from './fakes.ts';

type BashProps = FnViewOf<typeof fs, 'bash'>;

const run = mintId('run');
const bash = (props: Partial<BashProps>, system: SystemClient<FsContract['defs']>): BashProps => ({
  run, status: 'done', args: { command: 'npm test' }, state: { cwd: 'C:/work' }, submit: undefined, system, ...props,
});

describe('BashView', () => {
  it('shows the command, where it ran, and the output with its exit code', () => {
    const { system } = fakeSystem();
    const card = mount(BashView, { props: bash({ result: { exitCode: 1, stdout: 'ok 1\nnot ok 2\n', stderr: 'boom' } }, system) });
    expect(card.find('.command').text()).toBe('npm test');
    expect(card.find('.where').text()).toBe('in C:/work');
    expect(card.find('.chip').text()).toBe('Exit 1');
    expect(card.findAll('.stream').map((s) => s.text())).toEqual(['ok 1\nnot ok 2', 'boom']);
  });

  it('shows live progress and the last line while running, without actions', () => {
    const { system } = fakeSystem();
    const card = mount(BashView, { props: bash({ status: 'running', progress: { fraction: 0.4, message: 'compiling' } }, system) });
    expect(card.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('40');
    expect(card.find('.live').text()).toBe('compiling');
    expect(card.find('.actions').exists()).toBe(false);
  });

  it('runs again as a new bash run with the same args, and says when it started', async () => {
    const fake = fakeSystem();
    const args = { command: 'npm test', cwd: 'packages', timeout: 60_000 };
    const card = mount(BashView, { props: bash({ args, result: { exitCode: 0, stdout: 'first', stderr: '' } }, fake.system) });
    await card.find('.action.primary').trigger('click');
    expect(fake.started).toEqual([{ fn: 'bash', args }]);
    expect(card.find('.action.primary').text()).toBe('Starting…');
    expect(card.find('.action.primary').attributes('disabled')).toBeDefined();
    fake.start();
    await flushPromises();
    expect(card.find('.started').text()).toBe('Started again below');
    expect(card.find('.action.primary').attributes('disabled')).toBeUndefined();
    // the first run's output stays as it was; the new run has its own card
    expect(card.find('.stream').text()).toBe('first');
  });

  it('shows why a run again could not start, and is off while fs is offline', async () => {
    const fake = fakeSystem();
    const card = mount(BashView, { props: bash({ result: { exitCode: 0, stdout: '', stderr: '' } }, fake.system) });
    await card.find('.action.primary').trigger('click');
    fake.refuse('fs/bash is unavailable: disabled');
    await flushPromises();
    expect(card.find('[role="alert"]').text()).toBe('fs/bash is unavailable: disabled');
    expect(card.find('.started').exists()).toBe(false);

    const offline = fakeSystem(false);
    const away = mount(BashView, { props: bash({ result: { exitCode: 0, stdout: '', stderr: '' } }, offline.system) });
    expect(away.find('.note').text()).toContain('fs is offline');
    expect(away.find('.action.primary').attributes('disabled')).toBeDefined();
  });

  it('copies the command and its output', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const card = mount(BashView, { props: bash({ result: { exitCode: 0, stdout: 'hi\n', stderr: '' } }, fakeSystem().system) });
    await card.find('.action').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('$ npm test\nhi\n');
    expect(card.find('.action').text()).toBe('Copied');
  });

  it('folds long output until asked', async () => {
    const stdout = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const card = mount(BashView, { props: bash({ result: { exitCode: 0, stdout, stderr: '' } }, fakeSystem().system) });
    expect(card.find('.output').classes()).toContain('folded');
    await card.find('.more').trigger('click');
    expect(card.find('.output').classes()).not.toContain('folded');
    expect(card.find('.more').text()).toBe('Show less');
  });
});

describe('the changes strip', () => {
  const file = (path: string, more: Partial<FileChange>): FileChange => ({ path, root: 'work', status: 'modified', certain: true, ...more });
  const changes: ChangeSet = {
    source: 'git', cwd: 'C:/work', ignored: 3, truncated: false,
    files: [
      file('src/a.ts', { diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two', added: 1, removed: 1 }),
      file('lib/a.ts', { status: 'added', diff: '--- /dev/null\n+++ b/lib/a.ts\n@@ -0,0 +1 @@\n+fresh', added: 1, removed: 0, certain: false }),
      file('logo.png', { status: 'added', noDiff: 'binary' }),
      file('.env', { noDiff: 'sensitive', sensitive: 'env' }),
    ],
  };

  it('shows a tab per diffed file, switches between them, and lists the rest with why', async () => {
    const { system } = fakeSystem();
    const card = mount(BashView, { props: bash({ result: { exitCode: 0, stdout: '', stderr: '', changes } }, system) });
    expect(card.find('.changes .summary').text()).toBe('4 files changed · 3 more ignored by git');
    expect(card.find('.unsure').exists()).toBe(true);
    const tabs = card.findAll('[role="tab"]');
    // two files named a.ts: their tabs carry the folder
    expect(tabs.map((tab) => tab.find('.name').text())).toEqual(['src/a.ts', 'lib/a.ts']);
    expect(tabs[0]?.attributes('aria-selected')).toBe('true');
    expect(card.find('[role="tabpanel"] .removed .text').text()).toBe('one');
    await tabs[1]?.trigger('click');
    expect(card.findAll('[role="tab"]')[1]?.attributes('aria-selected')).toBe('true');
    expect(card.find('[role="tabpanel"] .added .text').text()).toBe('fresh');
    await card.find('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' });
    expect(card.findAll('[role="tab"]')[0]?.attributes('aria-selected')).toBe('true');
    expect(card.findAll('.other').map((row) => [row.find('.where').text(), row.find('.why').text()])).toEqual([
      ['logo.png', 'Binary file'], ['.env', 'Sensitive (an env file), so not shown'],
    ]);
  });

  it('is absent when the command changed nothing', () => {
    const card = mount(BashView, { props: bash({ result: { exitCode: 0, stdout: 'ok', stderr: '' } }, fakeSystem().system) });
    expect(card.find('.changes').exists()).toBe(false);
  });
});

describe('DiffView', () => {
  it('draws the change with stats and opens a fold when clicked', async () => {
    const before = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 12', 'line twelve');
    const diff = mount(DiffView, { props: { data: { path: 'C:/work/a.txt', before, after }, title: 'Edited a.txt', system: fakeSystem().system } });
    expect(diff.find('.plus').text()).toBe('+1');
    expect(diff.find('.minus').text()).toBe('−1');
    expect(diff.find('.fold').text()).toBe('⋯ 8 unchanged lines');
    expect(diff.findAll('.line')).toHaveLength(5);
    await diff.find('.fold').trigger('click');
    expect(diff.find('.fold').exists()).toBe(false);
    expect(diff.findAll('.line')).toHaveLength(13);
    expect(diff.find('.added .text').text()).toBe('line twelve');
  });

  it('labels new files', () => {
    const diff = mount(DiffView, { props: { data: { path: 'n.md', before: '', after: '# n' }, title: 'Created n.md', system: fakeSystem().system } });
    expect(diff.find('.kind').text()).toBe('New file');
  });
});

describe('EntryInput', () => {
  it('emits a whole Entry as the path and type change, and shows problems', async () => {
    const input = mount(EntryInput, { props: { modelValue: undefined, problems: [], readonly: false, system: fakeSystem().system } });
    await input.find('input').setValue('docs/a.md');
    const first = input.emitted('update:modelValue')?.[0]?.[0];
    expect(first).toMatchObject({ path: 'docs/a.md', type: 'file', size: 0 });
    await input.findAll('.type')[1]?.trigger('click');
    expect(input.emitted('update:modelValue')?.[1]?.[0]).toMatchObject({ type: 'folder' });
    await input.setProps({ problems: ['path is required'] });
    expect(input.find('.problem').text()).toBe('path is required');
    expect(input.find('input').attributes('aria-invalid')).toBe('true');
  });

  it('shows the size and time of an entry from the system', () => {
    const value = { path: 'C:/w/a.md', type: 'file' as const, size: 2048, modifiedAt: new Date(0) };
    const input = mount(EntryInput, { props: { modelValue: value, problems: [], readonly: false, system: fakeSystem().system } });
    expect(input.find('.help').text()).toContain('2.0 KB');
    expect(input.find('[aria-checked="true"]').text()).toBe('File');
  });

  it('is the viewer too: read-only, nothing can change and nothing is emitted', async () => {
    const value = { path: 'C:/w/a.md', type: 'file' as const, size: 2048, modifiedAt: new Date(0) };
    const input = mount(EntryInput, { props: { modelValue: value, problems: [], readonly: true, system: fakeSystem().system } });
    expect(input.find('input').attributes('readonly')).toBeDefined();
    expect(input.findAll('.type').every((button) => button.attributes('disabled') !== undefined)).toBe(true);
    await input.findAll('.type')[1]?.trigger('click');
    expect(input.emitted('update:modelValue')).toBeUndefined();
    expect(input.find('.help').text()).toContain('2.0 KB');
  });
});
