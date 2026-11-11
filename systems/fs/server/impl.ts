/**
 * The fs system's implementation: every fn, method, action, hook, mention, context and resource the contract
 * declares, wired to the server's parts. `createFsImpl` takes every seam (shell, git, snapshots, documents, the
 * file manager, the restarter, the watcher, hosting and the clock), so tests run it against a temp folder with fakes.
 */
import { InstanceName, SystemName, type PairingGrant, type PairingGrantRequest, type PreviewAnswer } from '@harness/core';
import type { FnCtx, FnSearch, FnTypes, HookContribution, Outcome, SystemImpl } from '@harness/sdk';
import { COMMAND_TIMEOUT_MIN, fs, type FsContract } from '../shared/index.ts';
import { CommandRunner, outputOf, type CommandOutcome } from './commands.ts';
import { authoringStart, PackagedAuthoring, type AuthoringSource } from './authoring.ts';
import type { FsSettings } from './env.ts';
import { FileService } from './files.ts';
import { InstallRefused, type Hosting } from './hosting.ts';
import { describeStatus } from './git.ts';
import type { Documents, FsConfig, Git, Opener, PathGuard, Restarter, Shell, Snapshots, WatchFolder } from './index.ts';
import { FileMentions, PathIndex } from './mentions.ts';
import { RootGuard } from './paths.ts';
import { FsProblem } from './problem.ts';
import { FsResources } from './resources.ts';
import { DEFAULT_SECRETS, GlobSecrets, type SecretFilter } from './secrets.ts';
import { compilePattern, globPaths, grepFiles, searchBases, type SearchLimits } from './search.ts';
import { renderTree } from './tree.ts';

/** Everything the implementation is built from. */
export interface FsDeps {
  readonly settings: FsSettings;
  readonly shell: Shell;
  readonly git: Git;
  readonly opener: Opener;
  readonly snapshots: Snapshots;
  readonly documents: Documents;
  readonly restarter: Restarter;
  readonly watch: WatchFolder;
  readonly now: () => number;
  /**
   * Building, starting and supervising systems written here (`install_system` and the rest); absent when this fs
   * can't build systems (a packed fs without `@harness/build`), and those fns say so.
   */
  readonly hosting?: Hosting;
  /** The hub's one-time pairing token for an approved install run (`grantPairing` on the link). */
  readonly grantPairing?: (request: PairingGrantRequest) => Promise<PairingGrant>;
  /** Where the authoring start item finds the template. Default: beside the installed SDK. */
  readonly authoring?: AuthoringSource;
}

/** The implementation and the parts tests and `main` reach into. */
export interface FsServer {
  readonly impl: SystemImpl<FsContract['defs']>;
  readonly resources: FsResources;
  /** The config the system last started or was configured with. */
  config(): FsConfig;
}

/** Run fn code, turning a problem the caller can fix into a `caller` failure with its code. */
async function attempt<T extends FnTypes>(ctx: Pick<FnCtx<T, FsConfig>, 'fail'>, work: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FsProblem) { return ctx.fail('caller', error.message, { code: error.code }); }
    throw error;
  }
}

/** What the hosting fns say on an fs that can't build systems. */
const NO_HOSTING = 'This fs can\x27t build systems (it runs without @harness/build). Install the system with the harness CLI, or from an fs that runs from the harness repository.';

/** Whether the hub knows a system instance (it has fns somewhere), searched as the system or the run's person. */
async function knownTo(search: FnSearch, system: SystemName, instance: InstanceName): Promise<boolean> {
  const page = await search.searchFns({ systems: [system], instance, available: false, limit: 1 });
  return page.items.length > 0;
}

/** Hosting work, turning a refused install into invalid input the model can fix. */
async function hosted<T extends FnTypes>(ctx: Pick<FnCtx<T, FsConfig>, 'fail' | 'invalid'>, hosting: Hosting | undefined, work: (hosting: Hosting) => Promise<Outcome<T>>): Promise<Outcome<T>> {
  if (hosting === undefined) { return ctx.fail('caller', NO_HOSTING, { code: 'no-hosting' }); }
  try {
    return await work(hosting);
  } catch (error) {
    if (error instanceof InstallRefused) { return ctx.invalid(error.message); }
    if (error instanceof FsProblem) { return ctx.fail('caller', error.message, { code: error.code }); }
    throw error;
  }
}

/** `make` memoized per config value. */
function perConfig<T>(make: (config: FsConfig) => T): (config: FsConfig) => T {
  const made = new WeakMap<FsConfig, T>();
  return (config) => {
    const known = made.get(config);
    if (known !== undefined) { return known; }
    const value = make(config);
    made.set(config, value);
    return value;
  };
}

/** Build the fs implementation. */
export function createFsImpl(deps: FsDeps): FsServer {
  const s = deps.settings;
  const authoring = deps.authoring ?? new PackagedAuthoring();
  const files = new FileService(deps.snapshots, { readLines: s.FS_READ_LINES, fileMax: s.FS_FILE_MAX, listLimit: s.FS_LIST_LIMIT, ignore: s.FS_IGNORE });
  const commands = new CommandRunner(deps.shell, files, { timeout: s.FS_COMMAND_TIMEOUT, maxTimeout: s.FS_COMMAND_TIMEOUT_MAX, safe: s.FS_SAFE_COMMANDS });
  const index = new PathIndex({ ttl: s.FS_INDEX_TTL, max: s.FS_INDEX_MAX, ignore: s.FS_IGNORE }, deps.now);
  const mentions = new FileMentions({ index, files, documents: deps.documents, limits: { results: s.FS_MENTION_LIMIT, previewLines: s.FS_PREVIEW_LINES } });
  const search: SearchLimits = { scanMax: s.FS_SCAN_MAX, lineMax: s.FS_LINE_MAX, ignore: s.FS_IGNORE };

  // one guard (and secret filter) per config value: runs keep the config they started with, so each gets its own
  const guard = perConfig<PathGuard>((config) => new RootGuard(config.roots));
  const secrets = perConfig<SecretFilter>((config) => new GlobSecrets(config.secrets ?? DEFAULT_SECRETS));
  let current: FsConfig = { roots: [] };
  const resources = new FsResources({
    guard: () => guard(current),
    secrets: () => secrets(current),
    files,
    documents: deps.documents,
    limits: { page: s.FS_RESOURCE_PAGE, textMax: s.FS_RESOURCE_TEXT_MAX, ignore: s.FS_IGNORE, debounce: s.FS_WATCH_DEBOUNCE },
    watch: deps.watch,
  });

  /** Attach a diff when it is small enough to draw. */
  const attachDiff = (ctx: Pick<FnCtx<FnTypes, FsConfig>, 'attach'>, path: string, before: string, after: string, title: string) => {
    if (before.length + after.length <= s.FS_DIFF_MAX) { ctx.attach(fs.attachments.diff, { path, before, after }, title); }
  };
  const logRun = (ctx: Pick<FnCtx<FnTypes, FsConfig>, 'log'>, key: string, run: CommandOutcome) => {
    ctx.log.info(key, { cwd: run.cwd, exitCode: run.exitCode, ended: run.ended, timeout: run.timeout });
  };

  const impl: SystemImpl<FsContract['defs']> = {
    fns: {
      read: {
        run: (args, ctx) => attempt(ctx, async () => {
          const at = guard(ctx.config).resolve(args.path, { write: false });
          return ctx.done(await files.read(at, args.offset, args.limit));
        }),
      },
      write: {
        run: (args, ctx) => attempt(ctx, async () => {
          const at = guard(ctx.config).resolve(args.path, { write: true });
          const change = await files.write(at, args.text);
          index.clear();
          attachDiff(ctx, at.path, change.before, change.after, change.created ? `Created ${at.relative}` : `Wrote ${at.relative}`);
          return ctx.done({ created: change.created }, { undo: { path: at.path, previous: change.previous } });
        }),
        undo: (payload, ctx) => files.restore(payload, guard(ctx.config)),
      },
      edit: {
        run: (args, ctx) => attempt(ctx, async () => {
          const at = guard(ctx.config).resolve(args.path, { write: true });
          const change = await files.edit(at, args.find, args.replace, args.all ?? false);
          attachDiff(ctx, at.path, change.before, change.after, `Edited ${at.relative}`);
          return ctx.done({ replacements: change.replacements }, { undo: { path: at.path, previous: change.previous } });
        }),
        undo: (payload, ctx) => files.restore(payload, guard(ctx.config)),
      },
      remove: {
        run: (args, ctx) => attempt(ctx, async () => {
          const at = guard(ctx.config).resolve(args.path, { write: true });
          const change = await files.remove(at);
          index.clear();
          attachDiff(ctx, at.path, change.before, change.after, `Deleted ${at.relative}`);
          return ctx.done({ removed: true }, { undo: { path: at.path, previous: change.previous } });
        }),
        undo: (payload, ctx) => files.restore(payload, guard(ctx.config)),
      },
      list: {
        run: (args, ctx) => attempt(ctx, async () => {
          const at = guard(ctx.config).resolve(args.path, { write: false });
          return ctx.done({ entries: await files.list(at, args.depth ?? 1) });
        }),
      },
      glob: {
        run: (args, ctx) => attempt(ctx, async () => {
          const bases = searchBases(guard(ctx.config), args.root);
          return ctx.done({ paths: await globPaths(bases, args.pattern, s.FS_GLOB_LIMIT, search, ctx.signal) });
        }),
      },
      grep: {
        run: (args, ctx) => attempt(ctx, async () => {
          const pattern = compilePattern(args.pattern);
          const bases = searchBases(guard(ctx.config), args.root);
          const query = { pattern, glob: args.glob, limit: args.limit ?? s.FS_GREP_LIMIT };
          const matches = await grepFiles(files, bases, query, search, ctx.signal, (fraction, message) => { ctx.progress.set(fraction, message); });
          return ctx.done({ matches });
        }),
      },
      cd: {
        run: (args, ctx) => attempt(ctx, async () => {
          const { cwd } = await ctx.state.get();
          const folder = await commands.folder(guard(ctx.config), args.path, cwd);
          await ctx.state.set({ cwd: folder });
          return ctx.done({ cwd: folder });
        }),
      },
      bash: {
        run: (args, ctx) => attempt(ctx, async () => {
          if (args.timeout !== undefined && args.timeout < COMMAND_TIMEOUT_MIN) {
            return ctx.invalid([{ path: 'timeout', message: `The timeout is in milliseconds and must be at least ${String(COMMAND_TIMEOUT_MIN)} (30000 is 30 seconds); ${String(args.timeout)} was given.` }]);
          }
          const state = await ctx.state.get();
          const run = await commands.run({ command: args.command, cwd: args.cwd, timeout: args.timeout }, {
            guard: guard(ctx.config),
            policy: await ctx.setting(fs.settings.shell),
            sessionCwd: state.cwd,
            signal: ctx.signal,
            confirm: ctx.handlers.confirm,
            onOutput: (fraction, line) => { ctx.progress.set(fraction, line); },
          });
          logRun(ctx, 'fs.bash.ran', run);
          switch (run.ended) {
            case 'cancelled': return ctx.cancelled({ partial: outputOf(run) });
            case 'timeout': return ctx.fail('caller', `The command didn't finish within ${run.timeout} ms, so it was stopped.`, { code: 'timeout', data: outputOf(run) });
            case 'exit': return ctx.done(outputOf(run));
          }
        }),
      },
      restart: {
        run: (args, ctx) => {
          ctx.log.info('fs.restart.scheduled', { reason: args.reason, delay: s.FS_RESTART_DELAY });
          deps.restarter.schedule(args.reason);
          return Promise.resolve(ctx.done({ restarting: true }));
        },
      },
      install_system: {
        preview: async (args, ctx): Promise<PreviewAnswer> => {
          const hosting = deps.hosting;
          if (hosting === undefined) { return { refused: NO_HOSTING }; }
          try {
            const at = guard(ctx.config).resolve(args.path, { write: false });
            const known = (system: SystemName, instance: InstanceName) => knownTo(ctx, system, instance);
            return { preview: await hosting.preview(at.path, { instance: args.instance, replace: args.replace, known }, ctx.signal) };
          } catch (error) {
            if (error instanceof InstallRefused || error instanceof FsProblem) { return { refused: error.message }; }
            throw error;
          }
        },
        run: (args, ctx) => hosted(ctx, deps.hosting, async (hosting) => {
          const subject = ctx.approved?.preview.subject;
          const grant = deps.grantPairing;
          if (subject === undefined) { return ctx.fail('fatal', 'install_system runs only once an admin approves its card, and this run carries no approval.', { code: 'not-approved' }); }
          if (grant === undefined) { return ctx.fail('fatal', 'This fs can\x27t ask the hub for a pairing token.', { code: 'no-grant' }); }
          const at = guard(ctx.config).resolve(args.path, { write: false });
          const result = await hosting.install(at.path, subject, (bound) => grant({ run: ctx.run.id, subject: bound }), ctx.signal);
          ctx.log.info('fs.hosted.installed', { system: result.system, instance: result.instance, version: result.version, status: result.status });
          return ctx.done(result);
        }),
      },
      system_status: {
        run: (args, ctx) => hosted(ctx, deps.hosting, async (hosting) => ctx.done(await hosting.status(args.system))),
      },
      restart_system: {
        run: (args, ctx) => hosted(ctx, deps.hosting, async (hosting) => {
          ctx.log.info('fs.hosted.restart', { system: args.system, reason: args.reason });
          return ctx.done({ state: await hosting.restart(args.system, args.instance) });
        }),
      },
      stop_system: {
        run: (args, ctx) => hosted(ctx, deps.hosting, async (hosting) => {
          const remove = args.remove === true;
          if (remove) {
            const folders = await hosting.removes(args.system, args.instance);
            const confirm = ctx.handlers.confirm;
            if (confirm === undefined) { return ctx.invalid('Removing a hosted system deletes its data, so the person must confirm it, and this call has no way to ask. Stop it without remove, or ask the person to remove it from its page.'); }
            if (!await confirm({ system: args.system, folders })) { return ctx.cancelled(); }
          }
          return ctx.done(await hosting.stop(args.system, args.instance, remove));
        }),
      },
    },
    types: {
      Entry: {
        reveal: {
          run: (self, _args, ctx) => attempt(ctx, async () => {
            const at = guard(ctx.config).resolve(self.path, { write: false });
            return ctx.done(await deps.opener.reveal(at.path, self.type));
          }),
        },
      },
    },
    context: {
      'system-authoring': () => Promise.resolve(authoringStart(authoring)),
      tree: async (args, ctx) => {
        const g = guard(ctx.config);
        if (g.roots.length === 0) { return 'No folders are configured yet.'; }
        const named = args.root === undefined ? undefined : g.root(args.root);
        if (args.root !== undefined && named === undefined) {
          return `There is no root named "${args.root}". The roots are: ${g.roots.map((r) => r.name).join(', ')}.`;
        }
        const roots = named === undefined ? g.roots : [named];
        const limits = { depth: s.FS_TREE_DEPTH, entries: s.FS_TREE_ENTRIES, ignore: s.FS_IGNORE };
        return (await Promise.all(roots.map((root) => renderTree(root, limits, ctx.signal)))).join('\n\n');
      },
    },
    hooks: {
      git: async (_input, ctx) => {
        const roots = guard(ctx.config).roots;
        const statuses = await Promise.all(roots.map(async (root) => ({ root, status: await deps.git.status(root.folder, ctx.signal) })));
        const lines = statuses.flatMap(({ root, status }) => (status === undefined ? [] : [describeStatus(root.name, status, s.FS_GIT_FILES)]));
        const blocks: HookContribution[] = lines.length === 0 ? [] : [{ type: 'text', tag: 'git', text: lines.join('\n') }];
        return blocks;
      },
    },
    mentions: {
      files: {
        search: (query, ctx) => mentions.search(guard(ctx.config), query),
        hover: (target, ctx) => mentions.hover(guard(ctx.config), target, ctx.user),
        llm: (target, ctx) => mentions.llm(guard(ctx.config), target),
      },
    },
    resources,
    lifecycle: {
      started: (ctx) => {
        current = ctx.config;
        ctx.log.info('fs.started', { roots: ctx.config.roots.length });
        // the systems this machine hosts start with it, without holding up fs's own start
        deps.hosting?.startAll().then((started) => {
          for (const { system, outcome } of started) {
            ctx.log.info('fs.hosted.started', { system, outcome: 'state' in outcome ? outcome.state : 'refused' in outcome ? 'refused' : 'exited' in outcome ? 'exited' : 'timed-out' });
          }
        }).catch((error: unknown) => { ctx.log.error('fs.hosted.start.failed', {}, error); });
        return Promise.resolve();
      },
      configured: (ctx) => {
        current = ctx.config;
        index.clear();
        ctx.log.info('fs.configured', { roots: ctx.config.roots.length, before: ctx.previous?.roots.length ?? 0 });
        return Promise.resolve();
      },
      stopping: async (ctx) => {
        ctx.log.info('fs.stopping', { reason: ctx.reason });
        await deps.hosting?.stopAll();
      },
    },
  };
  return { impl, resources, config: () => current };
}
