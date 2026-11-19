/**
 * Starting a chat from outside one (`openChat`: a system page's `host.openChat`, the fn page's "Open in chat"): the
 * chat is made as the person, its first fn runs there, and the app moves to it; a chat that can't be made, or a fn
 * that can't be started, rejects with the reason and goes nowhere.
 */
import { QualifiedName, RunId, SessionId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { links } from '../../app/routes.ts';
import { openChat, type OpenChatDeps } from './open-chat.ts';

const S1 = SessionId.parse('ses_open');
const WIDGET = QualifiedName.parse('widgets/open_notes');

function fakeChat(options: { session?: SessionId | undefined; run?: RunId | undefined } = {}) {
  const made: Array<{ title?: string }> = [];
  const invoked: Array<{ fn: QualifiedName; args: unknown }> = [];
  const pushed: unknown[] = [];
  const session = 'session' in options ? options.session : S1;
  const run = 'run' in options ? options.run : RunId.parse('run_open');
  const chat: OpenChatDeps['chat'] = {
    sessions: { create: (input) => { made.push({ ...input }); return Promise.resolve(session); }, problem: ref(session === undefined ? 'The hub is busy.' : '') },
    thread: () => ({ invoke: (fn, args) => { invoked.push({ fn, args }); return Promise.resolve(run); }, problem: ref(run === undefined ? 'It is switched off.' : '') }),
  };
  return { deps: { chat, push: (to: unknown) => { pushed.push(to); return Promise.resolve(); } }, made, invoked, pushed };
}

describe('openChat', () => {
  it('makes the chat, runs the fn there and goes to it', async () => {
    const fake = fakeChat();
    expect(await openChat(fake.deps, { title: 'Open notes', run: { fn: WIDGET, args: {} } })).toBe(S1);
    expect(fake.made).toEqual([{ title: 'Open notes' }]);
    expect(fake.invoked).toEqual([{ fn: WIDGET, args: {} }]);
    expect(fake.pushed).toEqual([links.session(S1)]);
  });

  it('starts an empty chat when there is nothing to run', async () => {
    const fake = fakeChat();
    await openChat(fake.deps, { title: 'Notes' });
    expect(fake.invoked).toEqual([]);
    expect(fake.pushed).toEqual([links.session(S1)]);
  });

  it('rejects with the reason, going nowhere, when the chat or its run can\'t be started', async () => {
    const noChat = fakeChat({ session: undefined });
    await expect(openChat(noChat.deps, { title: 'Notes', run: { fn: WIDGET, args: {} } })).rejects.toThrow('The hub is busy.');
    expect(noChat.pushed).toEqual([]);
    const noRun = fakeChat({ run: undefined });
    await expect(openChat(noRun.deps, { title: 'Notes', run: { fn: WIDGET, args: {} } })).rejects.toThrow('It is switched off.');
    expect(noRun.pushed).toEqual([]);
  });
});
