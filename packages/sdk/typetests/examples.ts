// Compile-time proof that the SDK reads well and catches mistakes (ported from types/examples.ts). Nothing here runs:
// `npm run typecheck` fails if an expectation breaks. Every `@ts-expect-error` marks a mistake a system author must
// not be able to make.

import { h, type Component, type DefineComponent } from 'vue';
import {
  action, client, context, expectType, fn, g, handler, hook, hub, json, kind, mention, steps, system, type,
  type FnErrorType, type ModelChoiceType,
  type AttachmentViewOf, type ContextRef, type Equal, type FnRef, type FnViewOf, type Infer, type InputViewOf, type ValueOf,
} from '@harness/sdk';
import { harnessAiOf, serve, type HarnessAi } from '@harness/sdk/server';
import { type ClientRuntime } from '@harness/sdk/client';
import { fs, type Entry } from '@harness/system-fs';
import { mintId, type ApprovedRun, type ContentRef, type FnError, type ModelChoice, type RunId } from '@harness/core';

// Stand-ins for real file and shell code.
declare function readText(path: string): Promise<string>;
declare function shell(command: string, signal: AbortSignal, onOutput: (fraction: number) => void): Promise<{ exitCode: number; stdout: string; stderr: string }>;

// ── Types and refs are inferred ───────────────────────────────────────────────

expectType<Equal<ValueOf<typeof Entry>, { path: string; type: 'file' | 'folder' | 'link'; size: number; modifiedAt: Date }>>(true);
// a type's methods are typed fn refs, called with the value as self
expectType<Equal<typeof fs.types.Entry.methods.reveal.name, 'fs/Entry.reveal'>>(true);
expectType<Equal<Infer<typeof fs.types.Entry.methods.reveal.args>, { self: ValueOf<typeof Entry> }>>(true);
// a type's display names a value by one of its own fields
type({ description: 'x', shape: g.obj({ name: g.text() }), display: { label: 'X', title: 'name' } });
// @ts-expect-error the title must be one of the type's fields
type({ description: 'x', shape: g.obj({ name: g.text() }), display: { label: 'X', title: 'nmae' } });
// a stored type: the hub keeps its records and searches its text fields
type({ description: 'x', shape: g.obj({ name: g.text(), size: g.num() }), display: { label: 'X', title: 'name' }, records: { shape: 'table', owner: 'shared', search: { text: ['name'] } } });
// @ts-expect-error a stored type's search fields must be its own text fields
type({ description: 'x', shape: g.obj({ name: g.text(), size: g.num() }), display: { label: 'X' }, records: { shape: 'table', owner: 'shared', search: { text: ['size'] } } });
expectType<Equal<typeof fs.fns.read.name, 'fs/read'>>(true);
expectType<Equal<typeof fs.fns.explore.name, 'fs/explore'>>(true);
expectType<Equal<typeof fs.types.Entry.name, 'fs/Entry'>>(true);
// a command's args are typed: tree's root is optional
expectType<Equal<typeof fs.context.tree, ContextRef<'fs/tree', { root?: string }>>>(true);
expectType<Equal<typeof fs.fns.read, FnRef<'fs/read', { path: string; offset?: number | undefined; limit?: number | undefined }, { text: string; lines: number; truncated: boolean }, {}>>>(true);
// a named type from another system is a field like any other: the hub's ContentRef is core's ContentRef
expectType<Equal<Infer<typeof hub.types.ContentRef>, ContentRef>>(true);
// every other gin type the hub mirrors from a core schema is pinned to it the same way
expectType<Equal<Infer<typeof FnErrorType>, FnError>>(true);
expectType<Equal<Infer<typeof ModelChoiceType>, ModelChoice>>(true);

// ── The fs system's server: everything declared must be implemented ─────────

void serve(fs, {
  fns: {
    read: {
      async run(args, ctx) {
        // the system's config is typed in every context; a run keeps the value it started with
        expectType<Equal<(typeof ctx.config.roots)[number]['index'], 'all' | 'on-read' | 'none'>>(true);
        const text = await ctx.files.readText(args.path);
        const lines = text.split('\n');
        const from = args.offset ?? 0;
        const slice = lines.slice(from, args.limit === undefined ? undefined : from + args.limit);
        return ctx.done({ text: slice.join('\n'), lines: lines.length, truncated: slice.length < lines.length });
      },
    },
    write: {
      async run(args, ctx) {
        await ctx.files.write(args.path, args.text);
        // undo payload is typed: { path: string; previous: ContentRef | null }
        return ctx.done({ created: true }, { undo: { path: args.path, previous: null } });
      },
      async undo(payload, ctx) {
        if (payload.previous === null) { await ctx.files.remove(payload.path); }
        return { status: 'undone', summary: `restored ${payload.path}` };
      },
    },
    edit: {
      async run(args, ctx) {
        const previous = await ctx.files.share(args.path);
        const before = await ctx.files.readText(args.path);
        const after = args.all === true ? before.split(args.find).join(args.replace) : before.replace(args.find, args.replace);
        await ctx.files.write(args.path, after);
        ctx.attach(fs.attachments.diff, { path: args.path, before, after }, `Edited ${args.path}`);
        // @ts-expect-error attachment data is checked
        ctx.attach(fs.attachments.diff, { path: args.path }, 'missing before and after');
        return ctx.done({ replacements: 1 }, { undo: { path: args.path, previous } });
      },
      async undo(payload) { return { status: 'undone', summary: `restored ${payload.path}` }; },
    },
    list: {
      async run(_args, ctx) {
        // every run knows who it is for, their time, and where the call came from
        ctx.log.info('fs.list', { user: ctx.run.user.email, zone: ctx.run.user.timeZone, at: ctx.run.time.local, from: ctx.run.system.from?.system ?? 'hub' });
        return ctx.done({ entries: [] });
      },
    },
    glob: { async run(_args, ctx) { return ctx.done({ paths: [] }); } },
    grep: {
      async run(_args, ctx) {
        ctx.progress.set(0.5, 'half way');
        // @ts-expect-error grep reports linear progress, not steps
        ctx.progress.step('scan', 'active');
        return ctx.done({ matches: [] });
      },
    },
    bash: {
      async run(args, ctx) {
        const policy = await ctx.setting(fs.settings.shell);
        expectType<Equal<typeof policy, { allowed: boolean; safe: string[] } | undefined>>(true);
        const safe = policy?.safe.some((p) => args.command.startsWith(p)) ?? false;
        if (!safe) {
          // confirm is optional: it may be missing, and the compiler makes us check
          // @ts-expect-error may be undefined
          await ctx.handlers.confirm({ command: args.command, reason: 'not in safe list' });
          const ok = ctx.handlers.confirm ? await ctx.handlers.confirm({ command: args.command, reason: 'not in safe list' }) : false;
          if (!ok) { return ctx.fail('caller', 'The command needs confirmation and none was given.', { code: 'denied' }); }
        }
        // the working folder cd left in session state; bash sees only the fields it declared
        const state = await ctx.state.get();
        expectType<Equal<typeof state, Readonly<{ cwd?: string }>>>(true);
        // @ts-expect-error bash didn't declare this field, so it can't see it
        void state.lastQuery;
        const out = await shell(`cd ${args.cwd ?? state.cwd ?? '.'} && ${args.command}`, ctx.signal, (f) => ctx.progress.set(f));
        return ctx.done(out);
      },
    },
    cd: {
      async run(args, ctx) {
        await ctx.state.set({ cwd: args.path });
        // @ts-expect-error state values are typed
        await ctx.state.set({ cwd: 42 });
        // @ts-expect-error cd declared only cwd, so it can't write another field either
        await ctx.state.set({ lastQuery: 'x' });
        // @ts-expect-error cd has no form, so there's nothing to wait for
        await ctx.form();
        return ctx.done({ cwd: args.path });
      },
    },
    remove: {
      async run(args, ctx) {
        const previous = await ctx.files.share(args.path);
        await ctx.files.remove(args.path);
        return ctx.done({ removed: true }, { undo: { path: args.path, previous } });
      },
      async undo(payload) { return { status: 'undone', summary: `restored ${payload.path}` }; },
    },
    restart: {
      async run(_args, ctx) {
        // @ts-expect-error restart has no resume type, so it can't pause
        return ctx.pause({ at: 'now' });
      },
    },
    // installing runs only once approved: the run carries the approval it went ahead on
    install_system: {
      async run(_args, ctx) {
        expectType<Equal<typeof ctx.approved, ApprovedRun | undefined>>(true);
        return ctx.fail('fatal', 'not in a typetest');
      },
    },
    system_status: { async run(_args, ctx) { return ctx.done([]); } },
    restart_system: { async run(_args, ctx) { return ctx.fail('fatal', 'not in a typetest'); } },
    stop_system: { async run(_args, ctx) { return ctx.fail('fatal', 'not in a typetest'); } },
  },
  // methods of the system's types: native fns that also get the value they were called on
  types: {
    Entry: {
      reveal: {
        async run(self, _args, ctx) {
          expectType<Equal<typeof self, ValueOf<typeof Entry>>>(true);
          ctx.log.info('fs.reveal', { path: self.path });
          return ctx.done(true);
        },
      },
    },
  },
  // fs declares no actions, so it can't implement one
  // @ts-expect-error actions the contract doesn't declare are refused
  actions: { rerun: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  // tree is dynamic context, so it must be implemented; its args are typed from the command (and so are the authoring
  // guide's start item, whose parts come from its context folder)
  context: { tree: async (args) => `tree of ${args.root ?? 'all roots'}`, 'system-authoring': async () => 'How to write a system.' },
  hooks: { git: async () => [{ type: 'text', tag: 'git', text: 'branch main, 2 files changed' }] },
  mentions: {
    files: {
      // the chip shows the friendly name; the target is the system's own key for the thing
      async search(query) { return [{ label: 'harness.md', hint: `docs · matches "${query}"`, icon: 'file', target: { root: 'harness', path: 'docs/harness.md' } }]; },
      // returning the value as an Entry lets the card show Entry's icon and offer its reveal method
      async hover(target) { return { title: target.path, subtitle: `in ${target.root}`, fields: [{ label: 'Size', value: '28 KB' }], open: { resource: `file:///${target.path}` }, value: { path: target.path, type: 'file', size: 28_000, modifiedAt: new Date(0) } }; },
      // the LLM text says exactly what and where, and how to reach it
      async llm(target) { return `File ${target.path} in the fs root "${target.root}". Read it with fs/read { "path": "${target.path}" }.`; },
    },
  },
  resources: {
    async roots() { return []; },
    async list() { return { items: [] }; },
    async stat() { return undefined; },
    async read(uri) { return { stat: { uri, name: uri, type: 'file', version: '1' }, text: { inline: await readText(uri) } }; },
  },
  events: { resources: async (event, ctx) => ctx.log.info('fs.resources.changed', { count: event.changes.length }) },
  lifecycle: {
    async started(ctx) { ctx.log.info('fs.started', { roots: ctx.config.roots.length }); },
    // someone changed the config: react if it matters (here, watch the new set of folders)
    async configured(ctx) { ctx.log.info('fs.configured', { roots: ctx.config.roots.length, before: ctx.previous?.roots.length ?? 0 }); },
    async stopping(ctx) { ctx.log.info('fs.stopping', { reason: ctx.reason }); },
  },
}, { hub: 'ws://localhost:4300/link', state: '.system' });

// ── Mistakes that don't compile ───────────────────────────────────────────────

// @ts-expect-error every native fn must be implemented (most are missing here)
void serve(fs, { fns: { read: { async run(_a, ctx) { return ctx.done({ text: '', lines: 0, truncated: false }); } } } }, { hub: '', state: '' });

// Every section a contract declares must be implemented. `every` declares one of each; `complete` implements them all,
// and each line below leaves exactly one out.
const every = system('every', { description: 'One of everything.' }).with({
  types: {
    Item: type({
      description: 'An item.', shape: g.obj({ id: g.text() }), display: { label: 'Item', title: 'id' },
      methods: { touch: fn({ description: 'Touch it.', args: g.obj({}), returns: g.bool() }) },
    }),
  },
  kinds: { macro: kind({ description: 'A macro.', applicability: 'Macros.', payload: g.obj({ steps: g.list(g.text()) }) }) },
  fns: { save: fn({ description: 'Save.', args: g.obj({ id: g.text() }), returns: g.bool(), undo: g.obj({ id: g.text() }) }) },
  context: { items: context({ description: 'The items.', command: { name: 'items', args: {} } }) },
  hooks: { recent: hook({ description: 'Recent items.' }) },
  mentions: { items: mention({ title: 'Items', description: 'Any item.', target: g.obj({ id: g.text() }) }) },
  actions: { refresh: action({ description: 'Refresh.', input: g.obj({}), returns: g.bool() }) },
});
type EveryImpl = Parameters<typeof serve<'every', (typeof every)['defs']>>[1];
declare function omit<T, K extends keyof T>(value: T, key: K): Omit<T, K>;
const complete = {
  types: { Item: { touch: { async run(_self, _args, ctx) { return ctx.done(true); } } } },
  kinds: {
    macro: {
      async check() { return []; },
      async describe() { return { args: { name: 'obj' }, returns: { name: 'text' }, deps: [], operations: { cancel: true, pause: false, undo: false, background: true }, examples: [{ args: {} }] }; },
      async run(_payload, _args, ctx) { return ctx.done(null); },
    },
  },
  fns: { save: { async run(args, ctx) { return ctx.done(true, { undo: { id: args.id } }); }, async undo() { return { status: 'undone', summary: 'unsaved' }; } } },
  context: { items: async () => 'no items' },
  hooks: { recent: async () => [] },
  mentions: { items: { async search() { return []; }, async hover() { return undefined; }, async llm(target) { return `item ${target.id}`; } } },
  actions: { refresh: async () => true },
} satisfies EveryImpl;
void serve(every, complete, { hub: '', state: '' });
// @ts-expect-error save declares an undo type, so it must be undoable
void serve(every, { ...complete, fns: { save: { async run(_a, ctx) { return ctx.done(true, { undo: { id: 'x' } }); } } } }, { hub: '', state: '' });
// @ts-expect-error every method of a type must be implemented
void serve(every, omit(complete, 'types'), { hub: '', state: '' });
// @ts-expect-error every kind must be implemented
void serve(every, omit(complete, 'kinds'), { hub: '', state: '' });
// @ts-expect-error every dynamic context must be implemented
void serve(every, omit(complete, 'context'), { hub: '', state: '' });
// @ts-expect-error every hook must be implemented
void serve(every, omit(complete, 'hooks'), { hub: '', state: '' });
// @ts-expect-error every mention provider must be implemented
void serve(every, omit(complete, 'mentions'), { hub: '', state: '' });
// @ts-expect-error every action must be implemented
void serve(every, omit(complete, 'actions'), { hub: '', state: '' });

const tiny = system('tiny', { description: 'One fn.' }).with({
  fns: { ping: fn({ description: 'Ping.', args: g.obj({}), returns: g.literal('pong') }) },
});
void serve(tiny, { fns: { ping: { async run(_a, ctx) { return ctx.done('pong'); } } } }, { hub: '', state: '' });
// @ts-expect-error the result is checked
void serve(tiny, { fns: { ping: { async run(_a, ctx) { return ctx.done('pang'); } } } }, { hub: '', state: '' });
// @ts-expect-error tiny declares no hooks, so none can be implemented
void serve(tiny, { fns: { ping: { async run(_a, ctx) { return ctx.done('pong'); } } }, hooks: { extra: async () => [] } }, { hub: '', state: '' });
// @ts-expect-error a fn that isn't in the contract can't be implemented
void serve(tiny, { fns: { ping: { async run(_a, ctx) { return ctx.done('pong'); } }, pong: { async run(_a: {}, ctx: never) { return ctx; } } } }, { hub: '', state: '' });

// ── Calling other systems' fns ───────────────────────────────────────────────

const copyFn = fn({
  description: 'Copy a file.',
  args: g.obj({ from: g.text(), to: g.text() }),
  returns: g.obj({ bytes: g.num() }),
  progress: steps({ read: 'Read the file', write: 'Write the copy' }),
  handlers: { overwrite: handler({ description: 'The target exists. Overwrite it?', args: g.obj({ path: g.text() }), returns: g.bool(), required: true }) },
  deps: { read: fs.fns.read, write: fs.fns.write },
});

const backup = system('backup', { description: 'Backups.' })
  .with({ fns: { copy: copyFn } })
  // a later step can depend on an earlier step's fns
  .with(({ fns }) => ({
    fns: { snapshot: fn({ description: 'Copy a file next to itself.', args: g.obj({ path: g.text() }), returns: g.text(), deps: { copy: fns.copy, ask: hub.fns.ask_user } }) },
  }));

void serve(backup, {
  fns: {
    copy: {
      async run(args, ctx) {
        ctx.progress.step('read', 'active');
        // @ts-expect-error only declared steps
        ctx.progress.step('verify', 'active');
        // a call is awaitable for its typed result
        const file = await ctx.fns.read({ path: args.from });
        expectType<Equal<typeof file.text, string>>(true);
        // @ts-expect-error args are checked
        void ctx.fns.read({ file: args.from });
        // @ts-expect-error only deps can be called
        void ctx.fns.remove({ path: args.to });
        if (!(await ctx.handlers.overwrite({ path: args.to }))) { return ctx.cancelled(); }
        ctx.progress.step('write', 'active');
        await ctx.fns.write({ path: args.to, text: file.text });
        return ctx.done({ bytes: file.text.length });
      },
    },
    snapshot: {
      async run(args, ctx) {
        // @ts-expect-error copy has a required handler, so it must be passed
        void ctx.fns.copy({ from: args.path, to: `${args.path}.bak` });
        const done = await ctx.fns.copy({ from: args.path, to: `${args.path}.bak` }, { handlers: { overwrite: async () => true }, key: 'copy' });
        const answer = await ctx.fns.ask({ question: 'Keep the snapshot?' });
        return ctx.done(`${done.bytes} bytes, ${answer.answer}`);
      },
    },
  },
}, { hub: '', state: '' });

// ── Calling a type's method from another system ───────────────────────────────

const viewer = system('viewer', { description: 'Shows files.' }).with({
  fns: { show: fn({ description: 'Reveal a file.', args: g.obj({ entry: fs.types.Entry }), returns: g.bool(), deps: { reveal: fs.types.Entry.methods.reveal } }) },
});
void serve(viewer, {
  fns: {
    show: {
      async run(args, ctx) {
        // a type ref is a gin type, so it works as a field; its method takes the value as self
        const shown = await ctx.fns.reveal({ self: args.entry });
        // @ts-expect-error a method call needs the value it is called on
        void ctx.fns.reveal({});
        return ctx.done(shown);
      },
    },
  },
}, { hub: '', state: '' });

// ── Kinds ─────────────────────────────────────────────────────────────────────

const Request = g.obj({ method: g.enum(['GET', 'POST']), url: g.text() });
const web = system('web', { description: 'HTTP fns.' })
  .with({ kinds: { api: kind({ description: 'A fn that makes one HTTP request.', applicability: 'Use for a single REST call.', payload: Request }) } })
  // a fn of a kind declares the args and result it expects; the kind's system runs it
  .with(({ kinds }) => ({
    fns: { weather: kinds.api.fn({ description: 'Weather for a city.', payload: { method: 'GET', url: 'https://wttr.in/{{args.city}}?format=j1' }, args: g.obj({ city: g.text() }), returns: json() }) },
  }));

// the kind must be implemented; its fns must not be
void serve(web, {
  kinds: {
    api: {
      async check(payload) { return payload.url.startsWith('https://') ? [] : ['Only https URLs.']; },
      async describe() { return { args: { name: 'obj' }, returns: { name: 'any' }, deps: [], operations: { cancel: true, pause: false, undo: false, background: true }, examples: [{ args: {} }] }; },
      async run(payload, _args, ctx) { return ctx.done({ requested: payload.url }); },
    },
  },
}, { hub: '', state: '' });

// ── Mentions: a database row ──────────────────────────────────────────────────

const crm = system('crm', { description: 'Customers and orders.' }).with({
  mentions: {
    rows: mention({ title: 'Customers and orders', description: 'Any customer or order.', target: g.obj({ table: g.enum(['customers', 'orders']), id: g.text() }) }),
  },
});

void serve(crm, {
  mentions: {
    rows: {
      // @ts-expect-error the target is the declared key: a table it knows ('invoices' isn't one) and an id
      async search(query) { return [{ label: query, target: { table: 'invoices', id: '7' } }]; },
      async hover(target) {
        return { title: 'Acme Corp', subtitle: `${target.table} #${target.id}`, fields: [{ label: 'Open orders', value: '3' }] };
      },
      async llm(target) {
        // @ts-expect-error only the declared fields exist
        void target.name;
        return `Row ${target.id} of table ${target.table} in the crm database (system crm). Customer "Acme Corp", 3 open orders.`;
      },
    },
  },
}, { hub: '', state: '' });

// ── Renderers are typed by the contract ───────────────────────────────────────

// A functional component: the props are the typed view, live. It shows the shared working folder and has a
// "run again" button that starts a new bash run with the same args in the session, through the hub.
const BashView = (view: FnViewOf<typeof fs, 'bash'>) =>
  h('div', [
    h('pre', { 'data-fraction': view.progress?.fraction ?? 0 }, [`${view.state.cwd ?? '.'} $ ${view.args.command}\n`, view.result?.stdout ?? '']),
    h('button', {
      disabled: !view.system.online,
      onClick: async () => {
        const again = await view.system.run.bash({ ...view.args });   // a new run, with its own card, approval and undo
        expectType<Equal<typeof again, RunId>>(true);
        // @ts-expect-error fn args are checked
        void view.system.run.bash({ cmd: 'ls' });
        // @ts-expect-error only fns the contract declares can be run
        void view.system.run.deploy({});
        // @ts-expect-error only actions the contract declares can be sent, and fs declares none
        view.system.send.rerun({ command: 'ls' });
      },
    }, 'Run again'),
  ]);

// ── A fn shown as a form: the run waits until the user submits ────────────────

const deploy = system('deploy', { description: 'Deploys after a person approves.' }).with({
  fns: {
    approve: fn({
      description: 'Ask the user to approve a deploy plan. Returns their decision.',
      args: g.obj({ plan: hub.types.LongText }),
      returns: g.obj({ approved: g.bool(), note: g.optional(g.text()) }),
      form: g.obj({ approved: g.bool(), note: g.optional(g.text()) }),
      // once answered, the card turns into a plain message
      display: 'message',
    }),
  },
});

void serve(deploy, {
  fns: {
    approve: {
      async run(_args, ctx) {
        const answer = await ctx.form();   // waits for the renderer's submit (stored by the hub if the system is offline)
        return ctx.done(answer);
      },
    },
  },
}, { hub: '', state: '' });

const ApproveForm = (view: FnViewOf<typeof deploy, 'approve'>) =>
  h('form', { onSubmit: () => view.submit({ approved: true, note: 'ship it' }) }, [
    h('pre', view.args.plan),
    h('button', 'Approve'),
  ]);
// @ts-expect-error the form value is checked
void ((view: FnViewOf<typeof deploy, 'approve'>) => view.submit({ approved: 'yes' }));

export const deployClient = client(deploy, { fns: { approve: ApproveForm } });

// What a `.vue` file compiles to. In the SFC: `const props = defineProps<AttachmentViewOf<typeof fs, 'diff'>>()`.
declare const DiffView: DefineComponent<AttachmentViewOf<typeof fs, 'diff'>>;
// An input for fs/Entry. In the SFC: `const value = defineModel<Infer<typeof Entry.shape>>()`.
declare const EntryInput: DefineComponent<InputViewOf<typeof fs, 'Entry'>>;

export const fsClient = client(fs, {
  fns: { bash: BashView },
  attachments: { diff: DiffView },
  inputs: { Entry: EntryInput },
});

declare const WrongView: DefineComponent<{ other: number }>;
// @ts-expect-error a renderer's props must match what it renders
client(fs, { attachments: { diff: WrongView } });
// @ts-expect-error a functional renderer's props must match too
client(fs, { fns: { read: (view: FnViewOf<typeof fs, 'bash'>) => h('pre', view.args.command) } });
// @ts-expect-error renderers only for things the contract has
client(fs, { fns: { nope: BashView } });

// ── The runtime surface is typed by the contract too ──────────────────────────

declare const runningFs: Awaited<ReturnType<typeof serve<'fs', typeof fs.defs>>>;
// a fn added at runtime gets a ref named under its system, typed by its def; its implementation is checked
void runningFs.add('shout', fn({ description: 'Shout.', args: g.obj({ text: g.text() }), returns: g.text() }), {
  async run(args, ctx) { return ctx.done(args.text.toUpperCase()); },
}).then((ref) => {
  expectType<Equal<typeof ref.name, 'fs/shout'>>(true);
  expectType<Equal<Infer<typeof ref.args>, { text: string }>>(true);
});
// @ts-expect-error a runtime native fn's result is checked as well
void runningFs.add('bad', fn({ description: 'Bad.', args: g.obj({}), returns: g.num() }), { async run(_a, ctx) { return ctx.done('x'); } });

// the chat registers any system's module, whatever its contract, and looks renderers up by qualified name
declare const runtime: ClientRuntime;
runtime.register(fsClient);
runtime.register(deployClient);
expectType<Equal<ReturnType<ClientRuntime['fnRenderer']>, Component | undefined>>(true);
// a form is submitted with the fn's own form type
void runtime.submit(mintId('run'), deploy.defs.fns.approve.form ?? g.obj({ approved: g.bool(), note: g.optional(g.text()) }), { approved: true });

// the hub-backed aeye AI for a run, for prompts, tools and agents
void serve(tiny, { fns: { ping: { async run(_a, ctx) { expectType<Equal<ReturnType<typeof harnessAiOf>, HarnessAi>>(true); void harnessAiOf(ctx.llm); return ctx.done('pong'); } } } }, { hub: '', state: '' });
