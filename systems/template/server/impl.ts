/**
 * The template system's implementation: everything its contract declares, and nothing else. Its type is computed from
 * the contract (`SystemImpl`), so a declared fn, method, kind, dynamic context, hook, mention, sectioner, action
 * or model provider left out does not compile, and neither does one the contract doesn't declare.
 */
import type { SystemImpl } from '@harness/sdk';
import type { template } from '../shared/index.ts';
import type { TemplateSettings } from './env.ts';

/** Everything the implementation is built from: the settings and each outside dependency (`index.ts`). */
export interface TemplateDeps {
  readonly settings: TemplateSettings;
  // TODO: add a field per outside dependency, or delete this comment.
}

/** Build the template system's implementation. */
export function createImpl(_deps: TemplateDeps): SystemImpl<(typeof template)['defs']> {
  return {
    // fns: one `{ async run(args, ctx) { ... return ctx.done(result); } }` per native fn, plus
    // `async undo(payload, ctx) { ... return { status: 'undone', summary }; }` for a fn that declares `undo`.
    // TODO: implement every declared fn, or delete this comment.

    // types: per named type with methods, `{ <method>: { async run(self, args, ctx) { ... } } }`.
    // TODO: implement every declared method, or delete this comment.

    // kinds: per kind, `{ async check(payload, ctx), async describe(payload, ctx), async run(payload, args, ctx) }`.
    // `describe` returns at least one example worked out from the payload (`examples: [{ args: sampleArgs(args), note }]`).
    // TODO: implement every declared kind, or delete this comment.

    // context: per dynamic context (declared without `content`), `async (args, ctx) => text`.
    // TODO: implement every dynamic context, or delete this comment.

    // hooks: per hook, `async (input, ctx) => contributions` (text blocks, suggested or loaded context and fns).
    // TODO: implement every declared hook, or delete this comment.

    // mentions: per mention provider, `{ async search(query, ctx), async hover(target, ctx), async llm(target, ctx) }`.
    // TODO: implement every declared mention provider, or delete this comment.

    // providers: per model provider, `(ctx) => provider`, an aeye `Provider` for the current config (made again when it
    // changes); an embedding model's vectors come from its `embed`.
    // TODO: implement every declared provider, or delete this comment.

    // sectioners: per sectioner, `async (text, stat) => sections`, keys made with `sectionKeys(paths)`.
    // TODO: implement every declared sectioner, or delete this comment.

    // actions: per action, `async (input, ctx) => result`.
    // TODO: implement every declared action, or delete this comment.

    // resources: a `ResourceProvider` ({ roots, list, stat, read, watch? }) if this system serves resources.
    // TODO: serve resources, or delete this comment.

    // events: hub events to hear, by type (`message`, `run`, `resources`, `system`, `fns`): `async (event, ctx) => {}`.
    // TODO: handle events, or delete this comment.

    // lifecycle: `installed`, `started`, `configured`, `stopping`, `upgraded`, `uninstalled`, each `async (ctx) => {}`.
    // TODO: handle lifecycle moments, or delete this comment.
  };
}
