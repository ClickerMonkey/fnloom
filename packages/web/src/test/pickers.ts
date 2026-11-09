/**
 * Fake picker and visibility callers: `pick` answers from a few options per kind (matched by label or value, or the
 * labels of values asked for), and visibility is kept in memory, every target public and editable until set. `pickIn`
 * types into a picker and picks the first row, as a person does.
 */
import { AccessTarget, accessKey, ActorId, type AccessView, type PickOption, type PickSource } from '@harness/core';
import { flushPromises } from '@vue/test-utils';
import { listSource } from '../ui/picker.ts';
import { fakeCaller } from './fakes.ts';

/** The options the fake `pick` knows, by kind. */
export const PICK_OPTIONS: Readonly<Partial<Record<PickSource, readonly PickOption[]>>> = {
  fn: [{ value: 'fs/read', label: 'fs/read', hint: 'Read a file' }, { value: 'fs/search', label: 'fs/search', hint: 'Search files' }, { value: 'hub/chat', label: 'hub/chat', hint: 'The chat agent' }],
  context: [{ value: 'fs/guide', label: 'fs/guide', hint: 'How to use fs' }, { value: 'fs/shell', label: 'fs/shell', hint: 'Running commands' }, { value: 'me/tabs', label: 'me/tabs', hint: 'Prefers tabs' }],
  system: [{ value: 'fs', label: 'fs' }, { value: 'web', label: 'web' }, { value: 'claude', label: 'claude' }],
  person: [{ value: 'act_ann', label: 'Ann', hint: 'ann@example.com' }, { value: 'act_bob', label: 'Bob', hint: 'bob@example.com' }],
  group: [{ value: 'act_team', label: 'Team', hint: 'group' }],
  kind: [{ value: 'native', label: 'native' }, { value: 'hub/llm', label: 'hub/llm' }],
  model: [{ value: 'openai/gpt-oss-20b:free', label: 'gpt-oss-20b (free)' }],
};

/** Fake `pick`, `accessInfo`, `access` and `setAccess` callers; `multiUser` says whether the hub has more than one person. */
export function fakePickerApi(multiUser = false) {
  const stored = new Map<string, AccessView>();
  const owner = ActorId.parse('act_me');
  return {
    pick: fakeCaller<'pick'>(async ({ source, text, values }) => {
      const from = listSource(PICK_OPTIONS[source] ?? []);
      return [...(values === undefined ? await from.search(text ?? '') : await from.label(values))];
    }),
    accessInfo: fakeCaller<'accessInfo'>(() => Promise.resolve({ multiUser })),
    access: fakeCaller<'access'>(({ targets }) => Promise.resolve(targets.map((asked) => {
      const target = AccessTarget.parse(asked);
      return stored.get(accessKey(target)) ?? { target, sharing: { owner, visibility: 'public', with: [] }, editable: true };
    }))),
    setAccess: fakeCaller<'setAccess'>(({ target: asked, sharing }) => {
      const target = AccessTarget.parse(asked);
      const view: AccessView = { target, sharing: { owner, visibility: sharing.visibility, with: sharing.with.map((id) => ActorId.parse(id)) }, editable: true };
      stored.set(accessKey(target), view);
      return Promise.resolve(view);
    }),
  };
}

/** Type `text` into a picker (its input, or an element holding it), wait for its options, and pick the first with Enter. */
export async function pickIn(at: Element, text: string): Promise<void> {
  const input = at instanceof HTMLInputElement ? at : at.querySelector('input');
  if (input === null) { throw new Error('no picker input'); }
  input.dispatchEvent(new Event('focus'));
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => { setTimeout(resolve, 250); });
  await flushPromises();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flushPromises();
}
