/**
 * Build 8 in the run views: what a command changed (a tab per text file with its diff, the rest listed with why),
 * sensitive files on an approval card (plain words, never remembered), and a fn's notice on the approval card and a
 * running run's card.
 */
import { ChangeSet, Json, QualifiedName, SensitivityFlag, type ApprovalPreview, type FileChange } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import ApprovalCard from '../approvals/ApprovalCard.vue';
import { flagRows, flagsHeading } from '../approvals/flags.ts';
import RunCard from '../../chat/components/RunCard.vue';
import RunDetails from '../../chat/components/RunDetails.vue';
import { run, T0 } from '../../chat/test/fakes.ts';
import { FnNotices } from '../../fns/state/fn-notices.ts';
import { fakeFnsApi, SAMPLE_FACTS } from '../../fns/test/fakes.ts';
import ChangeSetView from './ChangeSetView.vue';
import { changeRows, changeSetOf, changesNote } from './changes.ts';

const PATCH = '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n';

function file(path: string, extra: Partial<FileChange> = {}): FileChange {
  return { path, root: 'work', status: 'modified', certain: true, ...extra };
}

const CHANGES: ChangeSet = ChangeSet.parse({
  source: 'git', cwd: '/work', ignored: 2, truncated: false,
  files: [
    file('src/app.ts', { diff: PATCH, added: 1, removed: 1 }),
    file('docs/app.ts', { status: 'added', diff: '+hello\n', added: 1, removed: 0, certain: false }),
    file('logo.png', { noDiff: 'binary' }),
    file('.env', { noDiff: 'sensitive', sensitive: 'env' }),
  ],
});

/** A bash result, as it arrives over the wire. */
const RESULT: Json = Json.parse({ exitCode: 0, stdout: 'ok', stderr: '', changes: CHANGES });

afterEach(() => { document.body.innerHTML = ''; });

describe('what a command changed', () => {
  it('reads the change set off a result, names tabs, and says why files have no diff', () => {
    expect(changeSetOf(RESULT)).toEqual(CHANGES);
    expect(changeSetOf({ exitCode: 0 })).toBeUndefined();
    const rows = changeRows(CHANGES);
    // two files named app.ts: each tab shows its folder
    expect(rows.map((row) => row.name)).toEqual(['src/app.ts', 'docs/app.ts', 'logo.png', '.env']);
    expect(rows.map((row) => row.why)).toEqual(['', '', 'Binary file', 'Sensitive: not shown']);
    expect(changesNote(CHANGES)).toBe('Files marked “maybe” changed while another call ran in the same folder. 2 ignored files (build output and the like) not listed.');
  });

  it('shows a tab per diffed file and lists the rest', async () => {
    const view = mount(ChangeSetView, { props: { changes: CHANGES } });
    const tabs = view.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.text())).toEqual(['src/app.ts', 'docs/app.ts']);
    expect(view.get('[data-testid="change-diff"]').attributes('data-path')).toBe('src/app.ts');
    await tabs[1]?.trigger('click');
    expect(view.get('[data-testid="change-diff"]').attributes('data-path')).toBe('docs/app.ts');
    expect(view.get('[data-testid="change-diff"]').text()).toContain('maybe');
    expect(view.findAll('[data-testid="change-plain"]').map((row) => row.attributes('data-path'))).toEqual(['logo.png', '.env']);
    expect(view.text()).not.toContain('SECRET');
  });

  it('adds a Changes tab to a run whose result carries them', async () => {
    const done = { ...run({ fn: 'fs/bash', status: 'done', outcome: { status: 'done', result: RESULT } }), asking: false };
    const details = mount(RunDetails, { props: { run: done, loading: false, now: T0, tab: 'changes' } });
    expect(details.findAll('[role="tab"]').map((tab) => tab.text())).toContain('Changes4');
    expect(details.find('[data-testid="change-set"]').exists()).toBe(true);
    await details.setProps({ run: { ...run({ status: 'done', outcome: { status: 'done', result: { exitCode: 0 } } }), asking: false } });
    expect(details.findAll('[role="tab"]').map((tab) => tab.text()).join()).not.toContain('Changes');
  });
});

const FLAGS = [
  SensitivityFlag.parse({ path: '.env', kind: 'env', rule: 'env-files', access: 'read', action: 'ask', why: 'Env files hold keys and passwords.', certain: true }),
  SensitivityFlag.parse({ path: 'deploy/id_rsa', kind: 'key', rule: 'keys', access: 'write', action: 'ask', why: 'Private keys sign in as you.', certain: false }),
];

describe('sensitive files on an approval card', () => {
  it('says each file in plain words, writes first', () => {
    const rows = flagRows([...FLAGS, FLAGS[0] ?? FLAGS[1]].filter((flag): flag is SensitivityFlag => flag !== undefined));
    expect(rows.map((row) => `${row.verb} ${row.path} · ${row.kind}`)).toEqual(['May write deploy/id_rsa · Key file', 'Reads .env · Environment file']);
    expect(flagsHeading(rows)).toBe('It touches 2 sensitive files');
  });

  it('lists them on the card and never offers to remember the answer', async () => {
    const preview: ApprovalPreview = { title: 'Read .env and write a key', parts: [{ type: 'flags', flags: FLAGS }], irreversible: false };
    const card = mount(ApprovalCard, { props: { fn: QualifiedName.parse('fs/bash'), description: '', args: undefined, preview } });
    expect(card.findAll('[data-testid="sensitive-file"]')).toHaveLength(2);
    expect(card.get('[data-testid="sensitive-files"]').text()).toContain('Env files hold keys and passwords.');
    expect(card.text()).not.toContain('This chat');
    expect(card.text()).not.toContain('Always');
  });
});

describe("a fn's notice", () => {
  it('shows on the approval card and on a running card, not once it ends', async () => {
    const notice = 'This usually takes about 3 minutes.';
    const card = mount(ApprovalCard, { props: { fn: QualifiedName.parse('fs/bash'), description: '', args: { command: 'npm test' }, notice } });
    expect(card.get('[data-testid="approval-notice"]').text()).toBe(notice);
    const running = mount(RunCard, { props: { run: { ...run({ status: 'running' }), asking: false }, now: T0, collapsed: false, notice } });
    expect(running.get('[data-testid="run-notice"]').text()).toBe(notice);
    await running.setProps({ run: { ...run({ status: 'done', outcome: { status: 'done', result: 'ok' } }), asking: false } });
    expect(running.find('[data-testid="run-notice"]').exists()).toBe(false);
  });

  it('asks for each fn once and fills the notice in when it comes', async () => {
    const api = fakeFnsApi();
    api.fnFacts.call = (body) => { calls.push(body.fn); return Promise.resolve({ ...SAMPLE_FACTS, notice: 'This usually takes about 3 minutes.' }); };
    const calls: string[] = [];
    const notices = new FnNotices(api);
    const fn = QualifiedName.parse('fs/bash');
    expect(notices.of(fn)).toBe('');
    expect(notices.of(fn)).toBe('');
    await flushPromises();
    expect(notices.of(fn)).toBe('This usually takes about 3 minutes.');
    expect(calls).toEqual(['fs/bash']);
  });
});
