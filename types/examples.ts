// # Examples
// Compile-time proof that the SDK reads well and catches mistakes. Nothing here runs: `npm run typecheck` fails if
// an expectation breaks. Every `@ts-expect-error` marks a mistake a system author must not be able to make.

import { h, type DefineComponent } from 'vue';
import { system, fn, handler, steps, serve, client, kind, mention, g, hub, type Infer, type FnRef, type ContextRef, type FnViewOf, type AttachmentViewOf, type InputViewOf } from './sdk.ts';
import { fs, Entry } from './fs.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const expect = <T extends true>(_: T): void => undefined;

// Stand-ins for real file and shell code.
declare function readText(path: string): Promise<string>;
declare function shell(command: string, signal: AbortSignal, onOutput: (fraction: number) => void): Promise<{ exitCode: number; stdout: string; stderr: string }>;

// ── Types and refs are inferred ───────────────────────────────────────────────

expect<Equal<Infer<typeof Entry>, { path: string; type: 'file' | 'folder' | 'link'; size: number; modifiedAt: number }>>(true);
expect<Equal<typeof fs.fns.read.name, 'fs/read'>>(true);
expect<Equal<typeof fs.fns.explore.name, 'fs/explore'>>(true);
expect<Equal<typeof fs.types.Entry.name, 'fs/Entry'>>(true);
// a command's args are typed: tree's root is optional
expect<Equal<typeof fs.context.tree, ContextRef<'fs/tree', { root?: string }>>>(true);
expect<Equal<typeof fs.fns.read, FnRef<'fs/read', { path: string; offset?: number; limit?: number }, { text: string; lines: number; truncated: boolean }, {}>>>(true);

// ── The fs system's server: everything declared must be implemented ─────────

void serve(fs, {
  fns: {
    read: {
      async run(args, ctx) {
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
        const after = args.all ? before.split(args.find).join(args.replace) : before.replace(args.find, args.replace);
        await ctx.files.write(args.path, after);
        ctx.attach(fs.attachments.diff, { path: args.path, before, after }, `Edited ${args.path}`);
        // @ts-expect-error attachment data is checked
        ctx.attach(fs.attachments.diff, { path: args.path }, 'missing before and after');
        return ctx.done({ replacements: 1 }, { undo: { path: args.path, previous } });
      },
      async undo(payload) { return { status: 'undone', summary: `restored ${payload.path}` }; },
    },
    list: { async run(_args, ctx) { return ctx.done({ entries: [] }); } },
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
        expect<Equal<typeof policy, { allowed: boolean; safe: string[] } | undefined>>(true);
        const safe = policy?.safe.some(p => args.command.startsWith(p)) ?? false;
        if (!safe) {
          // confirm is optional: it may be missing, and the compiler makes us check
          // @ts-expect-error may be undefined
          await ctx.handlers.confirm({ command: args.command, reason: 'not in safe list' });
          const ok = ctx.handlers.confirm ? await ctx.handlers.confirm({ command: args.command, reason: 'not in safe list' }) : false;
          if (!ok) { return ctx.fail('caller', 'The command needs confirmation and none was given.', { code: 'denied' }); }
        }
        // the working folder cd left in session state; bash sees only the fields it declared
        const state = await ctx.state.get();
        expect<Equal<typeof state, Readonly<{ cwd?: string }>>>(true);
        // @ts-expect-error bash didn't declare this field, so it can't see it
        void state.lastQuery;
        const out = await shell(`cd ${args.cwd ?? state.cwd ?? '.'} && ${args.command}`, ctx.signal, f => ctx.progress.set(f));
        return ctx.done(out);
      },
    },
    cd: {
      async run(args, ctx) {
        await ctx.state.set({ cwd: args.path });
        // @ts-expect-error state values are typed
        await ctx.state.set({ cwd: 42 });
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
  },
  // tree is dynamic context, so it must be implemented; its args are typed from the command
  // actions sent from renderers; this one has the same state view as bash
  actions: {
    rerun: async (input, ctx) => {
      const { cwd } = await ctx.state.get();
      return shell(`cd ${cwd ?? '.'} && ${input.command}`, ctx.signal, () => undefined);
    },
  },
  context: { tree: async (args) => `tree of ${args.root ?? 'all roots'}` },
  hooks: { git: async () => [{ type: 'text', tag: 'git', text: 'branch main, 2 files changed' }] },
  mentions: {
    files: {
      // the chip shows the friendly name; the target is the system's own key for the thing
      async search(query) { return [{ label: 'harness.md', hint: `docs · matches "${query}"`, icon: 'file', target: { root: 'harness', path: 'docs/harness.md' } }]; },
      // the hover card is for the person
      async hover(target) { return { title: target.path, subtitle: `in ${target.root}`, fields: [{ label: 'Size', value: '28 KB' }], open: { resource: `file:///${target.path}` } }; },
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
}, { hub: 'ws://localhost:4100', state: '.system' });

// ── Mistakes that don't compile ───────────────────────────────────────────────

// @ts-expect-error every native fn must be implemented (most are missing here)
void serve(fs, { fns: { read: { async run(_a, ctx) { return ctx.done({ text: '', lines: 0, truncated: false }); } } } }, { hub: '', state: '' });

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
        expect<Equal<typeof file.text, string>>(true);
        // @ts-expect-error args are checked
        ctx.fns.read({ file: args.from });
        // @ts-expect-error only deps can be called
        ctx.fns.remove({ path: args.to });
        if (!(await ctx.handlers.overwrite({ path: args.to }))) { return ctx.cancelled(); }
        ctx.progress.step('write', 'active');
        await ctx.fns.write({ path: args.to, text: file.text });
        return ctx.done({ bytes: file.text.length });
      },
    },
    snapshot: {
      async run(args, ctx) {
        // @ts-expect-error copy has a required handler, so it must be passed
        ctx.fns.copy({ from: args.path, to: `${args.path}.bak` });
        const done = await ctx.fns.copy({ from: args.path, to: `${args.path}.bak` }, { handlers: { overwrite: async () => true }, key: 'copy' });
        const answer = await ctx.fns.ask({ question: 'Keep the snapshot?' });
        return ctx.done(`${done.bytes} bytes, ${answer.answer}`);
      },
    },
  },
}, { hub: '', state: '' });

// ── Kinds ─────────────────────────────────────────────────────────────────────

const Request = g.obj({ method: g.enum('GET', 'POST'), url: g.text() });
const web = system('web', { description: 'HTTP fns.' })
  .with({ kinds: { api: kind({ description: 'A fn that makes one HTTP request.', applicability: 'Use for a single REST call.', payload: Request }) } })
  // a fn of a kind declares the args and result it expects; the kind's system runs it
  .with(({ kinds }) => ({
    fns: { weather: kinds.api.fn({ description: 'Weather for a city.', payload: { method: 'GET', url: 'https://wttr.in/{{args.city}}?format=j1' }, args: g.obj({ city: g.text() }), returns: g.json() }) },
  }));

// the kind must be implemented; its fns must not be
void serve(web, {
  kinds: {
    api: {
      async check(payload) { return payload.url.startsWith('https://') ? [] : ['Only https URLs.']; },
      async describe() { return { args: { name: 'obj' }, returns: { name: 'any' }, deps: [], operations: { cancel: true, pause: false, undo: false, background: true } }; },
      async run(payload, _args, ctx) { return ctx.done({ requested: payload.url }); },
    },
  },
}, { hub: '', state: '' });

// ── Mentions: a database row ──────────────────────────────────────────────────

const crm = system('crm', { description: 'Customers and orders.' }).with({
  mentions: {
    rows: mention({ title: 'Customers and orders', description: 'Any customer or order.', target: g.obj({ table: g.enum('customers', 'orders'), id: g.text() }) }),
  },
});

void serve(crm, {
  mentions: {
    rows: {
      // @ts-expect-error the target is the declared key: a table it knows ('invoices' isn't one) and an id
      async search(query) { return [{ label: query, target: { table: 'invoices', id: '7' } }]; },
      async hover(target) {
        return { title: `Acme Corp`, subtitle: `${target.table} #${target.id}`, fields: [{ label: 'Open orders', value: '3' }] };
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
// "run again" button that sends the rerun action to the fs system through the hub.
const BashView = (view: FnViewOf<typeof fs, 'bash'>) =>
  h('div', [
    h('pre', { 'data-fraction': view.progress?.fraction ?? 0 }, [`${view.state.cwd ?? '.'} $ ${view.args.command}\n`, view.result?.stdout ?? '']),
    h('button', {
      disabled: !view.system.online,
      onClick: async () => {
        const delivery = view.system.send.rerun({ command: view.args.command });   // stored by the hub, delivered when fs is online
        const again = await delivery.result;
        expect<Equal<typeof again, { exitCode: number; stdout: string; stderr: string }>>(true);
        // @ts-expect-error only actions the contract declares can be sent
        view.system.send.deploy({});
        // @ts-expect-error action input is checked
        view.system.send.rerun({ cmd: 'ls' });
      },
    }, 'Run again'),
  ]);

// ── A fn shown as a form: the run waits until the user submits ────────────────

const deploy = system('deploy', { description: 'Deploys after a person approves.' }).with({
  fns: {
    approve: fn({
      description: 'Ask the user to approve a deploy plan. Returns their decision.',
      args: g.obj({ plan: g.text({ multiline: true }) }),
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
// An input for fs/Entry. In the SFC: `const value = defineModel<Infer<typeof Entry>>()`.
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
