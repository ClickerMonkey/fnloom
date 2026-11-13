/**
 * The MCP system's implementation: one process per MCP server instance. Its lifecycle reads the config and starts the
 * instance (`instance.ts`), which says how people connect and mirrors the server's lists; the `tool` kind calls a tool
 * on the server as the run's connection; the server fns report and refresh, forwarded with `on` to the instance that
 * holds the server; and the connect flow signs a person in (their token or headers, or OAuth through the hub's redirect)
 * and checks it by connecting with what they gave.
 */
import { InstanceName, Json, McpServerConfig, McpToolSpec, type ImportReport } from '@harness/core';
import { accountLabel, credentialsFromForm, wireType, type ConfigOf, type SystemCtx, type SystemImpl } from '@harness/sdk';
import type { SystemPatch } from '@harness/sdk/server';
import { ToolOutputType, type McpContract } from '../shared/index.ts';
import type { DialerFactory } from './dial.ts';
import type { McpSettings } from './env.ts';
import { answerText, downFailure, McpInstance, readConfig } from './instance.ts';
import { toolFacts, toolResult } from './mirror.ts';

/** Everything the implementation is built from. */
export interface McpDeps {
  readonly settings: McpSettings;
  readonly dialers: DialerFactory;
  /** The running system's runtime patch (the instance sends its mirror through it). */
  readonly patch: (change: SystemPatch) => Promise<ImportReport>;
  readonly version: string;
  readonly now: () => number;
  /** The `fetch` OAuth sign-in uses. */
  readonly fetch: typeof fetch;
}

/** The implementation, and the instance it runs (for tests and the process's stop). */
export interface McpServer {
  readonly impl: SystemImpl<McpContract['defs']>;
  instance(): McpInstance | undefined;
  close(): Promise<void>;
}

type McpCtx = SystemCtx<ConfigOf<McpContract['defs']>>;

const NOT_CONFIGURED = 'This MCP server is not configured yet: an admin adds it on the MCP servers page.';

/** Build the implementation. */
export function createMcpImpl(deps: McpDeps): McpServer {
  let current: McpInstance | undefined;

  /** Start the instance for the config, replacing the one before. */
  async function configure(ctx: McpCtx): Promise<void> {
    const config = readConfig(ctx.config);
    await current?.close();
    current = undefined;
    if (config === undefined) {
      ctx.log.warn('mcp.config-invalid', { instance: ctx.instance });
      return;
    }
    current = new McpInstance({
      instance: ctx.instance, config, settings: deps.settings, dialers: deps.dialers, log: ctx.log, version: deps.version, now: deps.now, fetch: deps.fetch,
      hub: { patch: deps.patch, instanceConnect: (connect) => ctx.instanceConnect(connect) },
    });
    await current.start();
  }

  /** The config the kind words a tool's facts by: the instance's, else the defaults. */
  const configNow = (): McpServerConfig => current?.config ?? McpServerConfig.parse({ label: 'MCP server', transport: { type: 'http', url: 'http://unconfigured.invalid/' } });

  const impl: SystemImpl<McpContract['defs']> = {
    lifecycle: {
      started: configure,
      configured: configure,
      stopping: async () => { await current?.close(); },
    },
    kinds: {
      tool: {
        check: () => Promise.resolve([]),
        describe: (payload) => {
          const spec = McpToolSpec.parse(payload);
          return Promise.resolve({
            args: spec.args,
            returns: spec.returns ?? wireType(ToolOutputType),
            deps: [],
            operations: { cancel: true, pause: false, undo: false, background: true },
            limits: { timeout: configNow().timeout },
            ...toolFacts(spec, configNow()),
          });
        },
        preview: (payload, args) => {
          const spec = McpToolSpec.parse(payload);
          const config = configNow();
          const { effects } = toolFacts(spec, config);
          return Promise.resolve({
            preview: {
              title: `${config.label}: ${spec.annotations?.title ?? spec.tool}`.slice(0, 200),
              parts: [
                { type: 'text', text: `${spec.description}${config.trusted ? '' : '\n\nThis server is not marked trusted, so what the tool says about itself is not relied on.'}` },
                { type: 'code', language: 'json', code: JSON.stringify(args, null, 2), title: 'Arguments' },
              ],
              irreversible: effects.mode === 'delete',
            },
          });
        },
        async run(payload, args, ctx) {
          const here = current;
          if (here === undefined) { return ctx.fail('fatal', NOT_CONFIGURED, { code: 'not-configured' }); }
          const spec = McpToolSpec.parse(payload);
          const called = await here.call(spec.tool, args, ctx);
          if ('down' in called) {
            const failure = downFailure(called.down);
            return ctx.fail(failure.cls, called.down.message, { code: failure.code });
          }
          if ('refused' in called) { return ctx.fail('caller', called.refused); }
          if (called.result.isError === true) { return ctx.fail('caller', answerText(called.result), { code: 'tool-error' }); }
          return ctx.done(toolResult(here.instance, spec, called.result));
        },
      },
    },
    fns: {
      at_server: {
        async run(args, ctx) {
          const here = current;
          if (here === undefined) { return ctx.fail('fatal', NOT_CONFIGURED, { code: 'not-configured' }); }
          return ctx.done(args.op === 'refresh' ? await here.refresh(ctx.connection) : here.status());
        },
      },
      server_status: {
        async run(args, ctx) {
          if (args.instance !== undefined && args.instance !== ctx.instance) { return ctx.done(await ctx.fns.at({ op: 'status' }, { on: InstanceName.parse(args.instance) })); }
          const here = current;
          return here === undefined ? ctx.fail('caller', NOT_CONFIGURED, { code: 'not-configured' }) : ctx.done(here.status());
        },
      },
      refresh: {
        async run(args, ctx) {
          if (args.instance !== undefined && args.instance !== ctx.instance) { return ctx.done(await ctx.fns.at({ op: 'refresh' }, { on: InstanceName.parse(args.instance) })); }
          const here = current;
          return here === undefined ? ctx.fail('caller', NOT_CONFIGURED, { code: 'not-configured' }) : ctx.done(await here.refresh(ctx.connection));
        },
      },
      answer_elicitation: {
        run(args, ctx) {
          return Promise.resolve(ctx.done({ sent: current?.elicitations.answer(args, ctx.run.id) ?? false }));
        },
      },
    },
    events: {
      run: (event) => {
        if (event.update.type === 'status') { current?.elicitations.settled(event.run, event.update.status); }
        return Promise.resolve();
      },
    },
    resources: {
      roots: () => current?.resources().roots() ?? Promise.resolve([]),
      list: (uri, cursor) => current?.resources().list(uri, cursor) ?? Promise.resolve({ items: [] }),
      stat: (uri) => current?.resources().stat(uri) ?? Promise.resolve(undefined),
      read: (uri, want) => current?.resources().read(uri, want) ?? Promise.reject(new Error(NOT_CONFIGURED)),
    },
    connect: {
      start: (request) => {
        const oauth = current?.oauth;
        if (oauth === undefined) { return Promise.reject(new Error(current === undefined ? NOT_CONFIGURED : `${current.config.label} doesn't sign in with OAuth.`)); }
        return oauth.start(request);
      },
      async finish(request) {
        const here = current;
        if (here === undefined) { return { problem: NOT_CONFIGURED }; }
        if ('params' in request.answer) {
          const signedIn = await here.oauth?.finish(request);
          if (signedIn === undefined) { return { problem: `${here.config.label} connects with a form, not a sign-in page.` }; }
          if ('problem' in signedIn) { return signedIn; }
          const problem = await here.verify(request.connection, signedIn.credentials);
          if (problem !== undefined) { return { problem }; }
          return {
            account: { label: accountLabel(signedIn.credentials), detail: here.config.label }, credentials: Json.parse(signedIn.credentials),
            ...(signedIn.expiresAt === undefined ? {} : { expiresAt: signedIn.expiresAt }),
          };
        }
        const made = credentialsFromForm(here.config.auth, request.answer.form);
        if ('problem' in made) { return made; }
        const problem = await here.verify(request.connection, made.credentials);
        if (problem !== undefined) { return { problem }; }
        const credentials = Json.parse(made.credentials);
        return { account: { label: accountLabel(made.credentials), detail: here.config.label }, credentials };
      },
      disconnect: async (connection) => { await current?.forget(connection.id); },
    },
  };

  return {
    impl,
    instance: () => current,
    close: async () => { await current?.close(); current = undefined; },
  };
}
