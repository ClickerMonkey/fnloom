/**
 * The chat agents' system prompts are written for a model that knows tools and nothing of this app
 * (docs/plans/prompt-rewrite-2026-11-21.md): they explain fns, systems, kinds, context, asking, how calls behave and
 * every tagged block a message can carry, each rule once, never the person's technical level, and the small one speaks
 * the static toolset's words without dropping the grounding rules.
 */
import { describe, expect, it } from 'vitest';
import { CHAT_BASE, CHAT_BLOCKED_RULE, CHAT_SMALL_BASE } from './chat-prompt.ts';
import { hub } from './hub.ts';
import { manifestOf } from './manifest.ts';
import { system } from './system.ts';

/** Every tag the hub can put in a user message (chat/enrich.ts, chat/files.ts, chat/announce.ts, chat/cite-rule.ts, execution/agent.ts, the fs hook). */
const MESSAGE_TAGS = [
  'local_time', 'systems_changed', 'fs_git', 'loaded_for_you', 'suggested_fns', 'suggested_context', 'mention', 'command', 'invocation', 'attachment', 'link',
  'input-answer', 'background-result', 'approval-result', 'citations_changed',
];

/** How many times `words` appear in `text`. */
function count(text: string, words: string): number {
  return text.split(words).length - 1;
}

describe('the chat system prompts', () => {
  it('are the chat agents\' instructions', () => {
    expect(hub.defs.fns.chat.payload.instructions).toBe(CHAT_BASE);
    expect(hub.defs.fns.chat_small.payload.instructions).toBe(CHAT_SMALL_BASE);
  });

  it('explain fns as tools, their tool spelling, loading, modes, approvals, undo and kinds', () => {
    for (const words of [
      'A **fn** is what you know as a tool', '`hub__fns_search`', 'hub/load_fns', 'has `loaded`', 'ranked closest to what you say', 'Every fn has a **mode**',
      'approval', 'Don\'t promise an undo a result doesn\'t offer', '**kind**', '`<systems>`',
    ]) {
      expect(CHAT_BASE).toContain(words);
    }
  });

  it('explain the app\'s words before using them: admin, reviews, sharing, the files system, memory scope', () => {
    const at = (words: string) => CHAT_BASE.indexOf(words);
    expect(at('An **admin** is')).toBeGreaterThan(-1);
    expect(at('An **admin** is')).toBeLessThan(at('an admin'));
    expect(at('**wait for a review**')).toBeLessThan(at('its fns wait for a review'));
    expect(at('who can share it with others')).toBeLessThan(at('not shared with this person'));
    expect(at('the files system, `fs`')).toBeLessThan(at('`<fs_git>`'));
    expect(CHAT_BASE).toContain('used when you leave `scope` out');
  });

  it('explain every tagged block a message can carry', () => {
    for (const tag of MESSAGE_TAGS) expect(CHAT_BASE, tag).toContain(`\`<${tag}>\``);
  });

  it('say how to read an attached file from its tag\'s attributes', () => {
    for (const words of ['`<file name mime size uri read="…">`', 'the fn named in `read`, with `{"uri": "<uri>"}`', 'hub/resource_send for a picture', 'hub/resource_read for everything else', '`truncated="true"`', 'a `hash` and no `uri`', 'don\'t call hub/resource_import']) {
      expect(CHAT_BASE).toContain(words);
    }
  });

  it('explain the runtime: background runs, the timeout, held calls, invalid input, stopped calls, the step limit and what the app can\'t do', () => {
    for (const words of [
      'Running in the background as run', 'hub/run_wait', 'in milliseconds', 'tool timeout', 'Not run: it works on the same things', 'Invalid input', '`path: what was expected`',
      'the args don\'t fit; fix these and send the whole call again:', '"Stopped by the hub:"', '16,000 tokens', 'gets 24 of them', 'Continue', 'Nothing runs later by itself',
    ]) {
      expect(CHAT_BASE).toContain(words);
    }
  });

  it('treat web reads as reads, and the citations id line as an id', () => {
    expect(CHAT_BASE).toContain('Web search, reading a page and crawling a site are reads');
    expect(CHAT_BASE).toContain('`tool id: run_…`: that is the result\'s id, for citing it, not part of the result');
  });

  it('say once what to do when blocked, invalid or failed, without contradiction', () => {
    expect(CHAT_BLOCKED_RULE).toContain('When a fn is refused or unavailable, stop');
    expect(CHAT_BLOCKED_RULE).toContain('fix exactly what it names and call again');
    expect(CHAT_BLOCKED_RULE).toContain('try at most one different approach, then tell the person');
    expect(count(CHAT_BASE, CHAT_BLOCKED_RULE)).toBe(1);
    expect(CHAT_BASE).not.toContain('make a useful start');
    expect(CHAT_BASE).toContain('Never fill it in yourself');
  });

  it('say each rule once', () => {
    for (const words of ['until a result says so', 'Don\'t promise an undo', 'whenever they send it', 'The result comes by itself later']) {
      expect(count(CHAT_BASE, words), words).toBe(1);
    }
  });

  it('give first moves for common requests', () => {
    for (const words of ['**Keeping track of something over time**', '**A photo or document attached**', '**"Every Sunday" or "remind me"**', 'near me this weekend']) {
      expect(CHAT_BASE).toContain(words);
    }
  });

  it('never speak of the person\'s technical level', () => {
    for (const prompt of [CHAT_BASE, CHAT_SMALL_BASE]) expect(prompt).not.toMatch(/technical|non-technical|developer|beginner|expert/i);
  });

  it('give the small agent the static toolset\'s five tools', () => {
    for (const tool of ['find', 'inspect', 'load', 'unload', 'run']) expect(CHAT_SMALL_BASE).toContain(tool);
    expect(CHAT_SMALL_BASE).not.toContain('hub/load_fns');
    expect(CHAT_SMALL_BASE).not.toContain('hub/load_context');
  });

  it('keep the substance in the small prompt: grounding, no invented setup, undo, forms, the three ways to ask, files and loaded blocks', () => {
    for (const words of [
      'Never describe a file, page or attachment you didn\'t read', 'Never say saved, sent or changed unless a result says so', 'never invent links, menu paths, keys or setup steps',
      'You can\'t connect accounts', 'don\'t promise an undo', 'forms are saved', 'hub/ask_user', '`<loaded_for_you>`', 'the fn named in `read`', '"Stopped by the hub:"',
    ]) {
      expect(CHAT_SMALL_BASE).toContain(words);
    }
  });

  it('carry a contract\'s `about` into its manifest, for the systems list', async () => {
    const notes = system('notes', { description: 'Notes.', about: 'Notes kept as files; load notes/guide first.' });
    expect((await manifestOf(notes, { version: '1.0.0' })).about).toBe('Notes kept as files; load notes/guide first.');
    expect((await manifestOf(system('bare', { description: 'Bare.' }), { version: '1.0.0' }))).not.toHaveProperty('about');
  });
});
