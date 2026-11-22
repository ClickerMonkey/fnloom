/**
 * The chat agents' own instructions are the minimal core (docs/plans/injected-context-2026-11-22.md, section 5),
 * written for a model that knows tools and nothing of this app (docs/plans/prompt-rewrite-2026-11-21.md): they explain
 * fns, systems, context, how calls behave and every tagged block the hub itself adds, each rule once, never the
 * person's technical level; they name no system that may not be installed and list no tools; and the small one speaks
 * the static toolset's words without dropping the grounding rules. What the hub's features and each system say is
 * injected context (packages/hub/context/, each system's `basics`), checked in scripts/chat-prompt.test.ts.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_BASE, CHAT_BLOCKED_RULE, CHAT_CORE_TAGS, CHAT_SMALL_BASE, INJECTED_CONTEXT, MAX_STEPS } from './chat-prompt.ts';
import { hub } from './hub.ts';
import { manifestOf } from './manifest.ts';
import { system } from './system.ts';

/** Every system in this repository: none may be named by the core. */
const SYSTEMS = readdirSync(join(import.meta.dirname, '..', '..', '..', 'systems'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(import.meta.dirname, '..', '..', '..', 'systems', entry.name, 'system.json')))
  .map((entry) => entry.name);

/** How many times `words` appear in `text`. */
function count(text: string, words: string): number {
  return text.split(words).length - 1;
}

describe('the chat system prompts', () => {
  it('are the chat agents\' instructions, the small one at its summary detail', () => {
    expect(hub.defs.fns.chat.payload.instructions).toBe(CHAT_BASE);
    expect(hub.defs.fns.chat_small.payload.instructions).toBe(CHAT_SMALL_BASE);
    expect(hub.defs.fns.chat_small.payload.injected).toEqual({ detail: 'summary', maxTokens: 600 });
  });

  it('start the chat with the tools mode\'s own six tools only: the rest come with their injected items', () => {
    expect(hub.defs.fns.chat.payload.tools).toEqual(['hub/fns_search', 'hub/fns_load', 'hub/fns_drop', 'hub/ctx_search', 'hub/ctx_load', 'hub/ctx_drop']);
  });

  it('hold the injected section and the agent\'s own step limit as placeholders', () => {
    for (const prompt of [CHAT_BASE, CHAT_SMALL_BASE]) {
      expect(count(prompt, INJECTED_CONTEXT)).toBe(1);
      expect(count(prompt, MAX_STEPS)).toBe(1);
      expect(prompt).not.toMatch(/gets 24|get 16/);
    }
    expect(CHAT_BASE.trimEnd().endsWith(INJECTED_CONTEXT)).toBe(true);
  });

  it('name no system that may not be installed, and list no tools', () => {
    expect(SYSTEMS.length).toBeGreaterThan(5);
    for (const prompt of [CHAT_BASE, CHAT_SMALL_BASE]) {
      for (const name of SYSTEMS) {
        expect(prompt, name).not.toContain(`${name}/`);
        expect(prompt, name).not.toContain(`<${name}_`);
        expect(prompt, name).not.toContain(`\`${name}\``);
      }
      expect(prompt).not.toMatch(/you start with|six tools|seven|ten of the hub/i);
      // no tool spellings: the one name is the renderer's (slice D)
      expect(prompt).not.toMatch(/__|--/);
      // the hub's features are injected items now
      for (const fn of ['hub/remember', 'hub/ask_user', 'hub/run_status', 'hub/run_wait', 'hub/fns_examples', 'hub/resource_read', 'hub/turn_undo', 'hub/sessions_list']) {
        expect(prompt, fn).not.toContain(fn);
      }
    }
  });

  it('explain fns as tools, loading context, modes, approvals and agents', () => {
    for (const words of [
      'A **fn** is what you know as a tool', 'exactly as written', 'hub/ctx_search finds context', 'hub/ctx_load', 'Every fn has a **mode**', 'approval', 'Some fns are **agents**', '`<systems>`',
      'Don\'t search for them or load them again',
    ]) {
      expect(CHAT_BASE).toContain(words);
    }
  });

  it('explain the app\'s words before using them: admin, reviews', () => {
    const at = (words: string) => CHAT_BASE.indexOf(words);
    expect(at('An **admin** is')).toBeGreaterThan(-1);
    expect(at('An **admin** is')).toBeLessThan(at('an admin'));
    expect(at('**wait for a review**')).toBeLessThan(at('its fns wait for a review'));
  });

  it('explain every tagged block the hub itself adds, and hook blocks generically', () => {
    for (const tag of CHAT_CORE_TAGS) expect(CHAT_BASE, tag).toContain(`\`<${tag}>\``);
    expect(CHAT_BASE).toContain('A block named after a system and one of its hooks');
    expect(CHAT_SMALL_BASE).toContain('`<system_hook>`');
  });

  it('explain the runtime: background runs, the timeout, held calls, invalid input, stopped calls and the step limit', () => {
    for (const words of [
      'Running in the background as run', 'tool timeout', 'Not run: it works on the same things', 'Invalid input', '`path: what was expected`',
      'the args don\'t fit; fix these and send the whole call again:', '"Stopped by the hub:"', '16,000 tokens', 'Continue', 'The result comes by itself later',
    ]) {
      expect(CHAT_BASE).toContain(words);
    }
    expect(CHAT_BASE).toContain('`tool id: run_…`: that is the result\'s id, for citing it, not part of the result');
  });

  it('say once what to do when blocked, invalid or failed, without contradiction', () => {
    expect(CHAT_BLOCKED_RULE).toContain('When a fn is refused or unavailable, stop');
    expect(CHAT_BLOCKED_RULE).toContain('fix exactly what it names and call again');
    expect(CHAT_BLOCKED_RULE).toContain('try at most one different approach, then tell the person');
    expect(count(CHAT_BASE, CHAT_BLOCKED_RULE)).toBe(1);
    expect(CHAT_BASE).toContain('Never fill it in yourself');
  });

  it('say each rule once', () => {
    for (const words of ['until a result says so', 'The result comes by itself later', 'Never fill it in yourself']) {
      expect(count(CHAT_BASE, words), words).toBe(1);
    }
  });

  it('never speak of the person\'s technical level', () => {
    for (const prompt of [CHAT_BASE, CHAT_SMALL_BASE]) expect(prompt).not.toMatch(/technical|non-technical|developer|beginner|expert/i);
  });

  it('speak the static toolset\'s words in the small prompt', () => {
    for (const tool of ['find', 'find_ctx', 'inspect', 'load', 'run']) expect(CHAT_SMALL_BASE).toContain(tool);
    expect(CHAT_SMALL_BASE).not.toContain('hub/fns_load');
    expect(CHAT_SMALL_BASE).not.toContain('hub/ctx_load');
    expect(CHAT_SMALL_BASE.length).toBeLessThan(CHAT_BASE.length / 3);
  });

  it('keep the grounding in the small prompt', () => {
    for (const words of [
      'Never describe a file, page or attachment you didn\'t read', 'Never say saved, sent or changed unless a result says so', 'Never invent amounts, dates or sizes',
      '`<loaded_for_you>`', '"Stopped by the hub:"', '`<background-result>`',
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
