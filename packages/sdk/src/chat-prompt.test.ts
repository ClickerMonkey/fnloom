/**
 * The chat agents' system prompts are written for a model that knows tools and nothing of this app
 * (docs/plans/prompt-rewrite-2026-11-21.md): they explain fns, systems, kinds, context, asking, how calls behave and
 * every tagged block a message can carry, never the person's technical level, and the small one speaks the static
 * toolset's words.
 */
import { describe, expect, it } from 'vitest';
import { CHAT_BASE, CHAT_SMALL_BASE } from './chat-prompt.ts';
import { hub } from './hub.ts';
import { manifestOf } from './manifest.ts';
import { system } from './system.ts';

/** Every tag the hub can put in a user message (chat/enrich.ts, chat/announce.ts, execution/agent.ts, the fs hook). */
const MESSAGE_TAGS = [
  'local_time', 'systems_changed', 'fs_git', 'suggested_fns', 'suggested_context', 'mention', 'command', 'invocation', 'file', 'attachment', 'link',
  'input-answer', 'background-result', 'approval-result',
];

describe('the chat system prompts', () => {
  it('are the chat agents\' instructions', () => {
    expect(hub.defs.fns.chat.payload.instructions).toBe(CHAT_BASE);
    expect(hub.defs.fns.chat_small.payload.instructions).toBe(CHAT_SMALL_BASE);
  });

  it('explain fns as tools, their tool spelling, loading, approvals, undo and kinds', () => {
    for (const words of ['A **fn** is what you know as a tool', '`hub__fns_search`', 'hub/load_fns', 'approval', 'Some calls can be undone, not all', '**kind**', '`<systems>`']) {
      expect(CHAT_BASE).toContain(words);
    }
  });

  it('explain every tagged block a message can carry', () => {
    for (const tag of MESSAGE_TAGS) expect(CHAT_BASE, tag).toContain(`\`<${tag}>\``);
  });

  it('explain the runtime: background runs, the timeout, held calls, invalid input, the step limit and what the app can\'t do', () => {
    for (const words of ['Running in the background as run', 'hub/run_wait', 'tool timeout', 'Not run: it works on the same things', 'Invalid input', 'Continue', 'Nothing runs later by itself']) {
      expect(CHAT_BASE).toContain(words);
    }
  });

  it('never speak of the person\'s technical level', () => {
    for (const prompt of [CHAT_BASE, CHAT_SMALL_BASE]) expect(prompt).not.toMatch(/technical|non-technical|developer|beginner|expert/i);
  });

  it('give the small agent the static toolset\'s five tools', () => {
    for (const tool of ['find', 'inspect', 'load', 'unload', 'run']) expect(CHAT_SMALL_BASE).toContain(tool);
    expect(CHAT_SMALL_BASE).not.toContain('hub/load_fns');
  });

  it('carry a contract\'s `about` into its manifest, for the systems list', async () => {
    const notes = system('notes', { description: 'Notes.', about: 'Notes kept as files; load notes/guide first.' });
    expect((await manifestOf(notes, { version: '1.0.0' })).about).toBe('Notes kept as files; load notes/guide first.');
    expect((await manifestOf(system('bare', { description: 'Bare.' }), { version: '1.0.0' }))).not.toHaveProperty('about');
  });
});
