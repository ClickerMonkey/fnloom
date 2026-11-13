/**
 * The api system's implementation, one instance per service: the `request` kind (check, describe and run through the
 * shared program runtime and the executor), `make_api` (the authoring agent in `authoring.ts`), `operations`,
 * `test_request`, and `connect` (a person's own token or header values for a service whose auth is per person).
 * Nothing is stored here: api fns are the hub's, and a person's credentials are the hub's secrets, sent with each run.
 */
import { API_KIND, ApiFnSpec, ApiServiceConfig, Json, KindDescription, strongerMode, type QualifiedName, type ResourceUri } from '@harness/core';
import { accountLabel, CallFailed, credentialsFromForm, hub, instanceConnectOf, type Files, type KindCheckCtx, type ConfigOf, type SystemCtx, type SystemImpl } from '@harness/sdk';
import { calleesMode, hubProgramHost, kindCheckLookups, kindRunLookups, ProgramError, storedProgramScope, type ProgramLookups } from '@harness/sdk/program';
import { AuthoringError } from '@harness/sdk/server';
import { HttpRequest, type ApiContract } from '../shared/index.ts';
import { ApiAuthoring, apiAuthoring } from './authoring.ts';
import type { ApiSettings } from './env.ts';
import { NoCredential, prepare, RequestRefused, ResponseFailed, responseFile, send, type SendCtx } from './http.ts';
import { operationsPage, readOperations } from './openapi.ts';
import { checkApi, modeOf, readableApi, runApi, type ApiCheck } from './program.ts';

/** Everything the implementation is built from. */
export interface ApiDeps {
  readonly settings: ApiSettings;
}

/** A payload's programs checked in the world its lookups give. */
async function checked(spec: ApiFnSpec, lookups: ProgramLookups): Promise<{ check: ApiCheck; program: Awaited<ReturnType<typeof storedProgramScope>> }> {
  const programs = [spec.request, ...(spec.output === undefined ? [] : [spec.output])];
  const types = [spec.args, spec.returns, ...(spec.responseType === undefined ? [] : [spec.responseType])];
  const program = await storedProgramScope({ types, programs }, lookups);
  return { check: checkApi(program, spec), program };
}

async function payloadProblems(spec: ApiFnSpec, ctx: KindCheckCtx): Promise<string[]> {
  return (await checked(spec, kindCheckLookups(ctx))).check.problems;
}

/** How a run sends: its fetch and signal, the person's connection, files for a file response, resource bytes. */
function sendCtx(settings: ApiSettings, ctx: { fetch: typeof fetch; signal: AbortSignal; files: Files; resources: { bytes(uri: ResourceUri): Promise<Uint8Array> }; connection: { credentials: Json } | undefined }): SendCtx {
  return {
    maxRedirects: settings.HARNESS_API_MAX_REDIRECTS,
    fetch: ctx.fetch,
    signal: ctx.signal,
    credentials: ctx.connection?.credentials,
    async keep(bytes) {
      const path = responseFile();
      await ctx.files.write(path, bytes);
      return ctx.files.share(path);
    },
    // a copy on its own ArrayBuffer, which fetch and Blob take as a body
    bytes: async (uri) => Uint8Array.from(await ctx.resources.bytes(uri)),
  };
}

/** A request failure in words, for the run's failure. */
function failure(error: unknown): string | undefined {
  if (error instanceof ResponseFailed || error instanceof RequestRefused || error instanceof ProgramError) return error.message;
  if (error instanceof CallFailed) return `A fn it calls failed: ${error.message}`;
  return undefined;
}

/** Build the api implementation. */
export function createApiImpl(deps: ApiDeps): SystemImpl<ApiContract['defs']> {
  return {
    fns: {
      make_api: {
        async run(args, ctx) {
          const config = ApiServiceConfig.parse(ctx.config);
          const getFn = async (fn: QualifiedName) => await ctx.fns.getFn({ fn });
          const service = ctx.instance;
          const state = new ApiAuthoring({
            host: hubProgramHost(ctx, getFn),
            deps: {
              service, config, send: sendCtx(deps.settings, ctx), getFn,
              async operations(query) {
                if (config.openapi === undefined) throw new Error(`${config.label} has no OpenAPI document set.`);
                return operationsPage(await readOperations(config.openapi, ctx.fetch, ctx.signal), query);
              },
              async saveFn(save) {
                const saved = await ctx.fns.saveFn({
                  kind: API_KIND, name: save.name, description: save.description, instructions: `Asked for: ${args.request}`, payload: save.payload,
                  examples: save.examples, tags: ['api', service], routing: { to: 'instance', instance: service },
                });
                return { fn: saved.fn, version: saved.version };
              },
            },
          });
          try {
            const { result } = await apiAuthoring.run(await ctx.ai(), args.request, state);
            ctx.log.info('api.authored', { fn: result.fn, reused: result.reused });
            return ctx.done(result);
          } catch (error) {
            if (!(error instanceof AuthoringError)) throw error;
            const last = error.problems.length === 0 ? '' : ` Its last problems: ${error.problems.join(' ')}`;
            return ctx.fail('caller', `No api fn was written: ${error.message}${last} Say more exactly which operation and what the result holds.`);
          }
        },
      },
      operations: {
        async run(args, ctx) {
          const config = ApiServiceConfig.parse(ctx.config);
          if (config.openapi === undefined) return ctx.fail('caller', `${config.label} has no OpenAPI document set; an admin can add its URL to the service.`);
          return ctx.done(operationsPage(await readOperations(config.openapi, ctx.fetch, ctx.signal), args));
        },
      },
      test_request: {
        async run(args, ctx) {
          const config = ApiServiceConfig.parse(ctx.config);
          const request = HttpRequest.parse({ method: args.method ?? 'GET', url: args.url, ...(args.params === undefined ? {} : { params: args.params }), ...(args.headers === undefined ? {} : { headers: args.headers }) });
          const how = sendCtx(deps.settings, ctx);
          try {
            return ctx.done((await send(await prepare(request, config, how), config, how)).exchange);
          } catch (error) {
            if (error instanceof ResponseFailed) return ctx.done(error.exchange);
            if (error instanceof RequestRefused) return ctx.invalid(error.message);
            throw error;
          }
        },
      },
    },
    // the HTTP types have no methods
    types: { HttpHeader: {}, HttpParam: {}, HttpPart: {}, HttpBody: {}, HttpRequest: {}, HttpResponse: {} },
    kinds: {
      request: {
        check: (payload, ctx) => payloadProblems(ApiFnSpec.parse(payload), ctx),
        async describe(payload, ctx) {
          const spec = ApiFnSpec.parse(payload);
          const lookups = kindCheckLookups(ctx);
          const { check } = await checked(spec, lookups);
          const readable = readableApi(check, spec.service);
          // GET and HEAD read; anything else changes the service; a program that calls fns also does what they do
          const mode = strongerMode(modeOf(check.method), await calleesMode(check.calls, lookups));
          return KindDescription.parse({
            args: spec.args,
            returns: spec.returns,
            deps: check.calls.length === 0 ? [] : [...check.calls, hub.fns.fn_get.name],
            operations: { cancel: true, pause: false, undo: false, background: false },
            // a mode past read makes the hub's policies ask before it runs
            effects: { mode },
            ...(readable === undefined ? {} : { readable: { language: 'ts', code: readable } }),
          });
        },
        async run(payload, args, ctx) {
          const spec = ApiFnSpec.parse(payload);
          if (spec.service !== ctx.instance) return ctx.fail('fatal', `${ctx.run.fn} is for the service ${spec.service}, not ${ctx.instance}.`);
          const config = ApiServiceConfig.parse(ctx.config);
          const { check, program } = await checked(spec, kindRunLookups(ctx));
          if (check.problems.length > 0) return ctx.fail('fatal', `${ctx.run.fn} no longer checks: ${check.problems.join(' ')}`);
          try {
            const outcome = await runApi({ program, spec, check, config, send: sendCtx(deps.settings, ctx), call: async (fn, input) => ctx.call(fn, input) }, args);
            const status = outcome.exchange.response?.status;
            ctx.progress({ step: 'request', status: 'done', detail: `${outcome.exchange.method} ${outcome.exchange.url}${status === undefined ? '' : ` → ${String(status)}`}` });
            ctx.log.info('api.exchange', { method: outcome.exchange.method, url: outcome.exchange.url, status: status ?? null, headers: outcome.exchange.headers.map((header) => `${header.key}: ${header.value}`) });
            return ctx.done(outcome.result ?? null);
          } catch (error) {
            if (error instanceof NoCredential) return ctx.fail('caller', error.message, { code: 'not-connected' });
            const message = failure(error);
            if (message === undefined) throw error;
            return ctx.fail('caller', message);
          }
        },
      },
    },
    connect: {
      start(request, ctx) {
        const config = ApiServiceConfig.parse(ctx.config);
        // API services sign in with a typed token or header values (`TypedAuth`, never OAuth): there is no browser flow to start
        throw new Error(`${config.label} takes a typed token or header values on the connections page, not a sign-in (connection ${request.connection}).`);
      },
      finish(request, ctx) {
        const config = ApiServiceConfig.parse(ctx.config);
        if (!('form' in request.answer)) return Promise.resolve({ problem: `${config.label} takes a typed token or header values, not a sign-in.` });
        const made = credentialsFromForm(config.auth, request.answer.form);
        if ('problem' in made) return Promise.resolve({ problem: made.problem });
        return Promise.resolve({ account: { label: config.label, detail: accountLabel(made.credentials) }, credentials: Json.parse(made.credentials) });
      },
      disconnect: () => Promise.resolve(),
    },
    lifecycle: {
      // the Connections page shows this instance with how people connect to it, said again whenever the config changes
      started: (ctx) => announce(ctx),
      configured: (ctx) => announce(ctx),
    },
  };
}

/** Say how people connect to this service (`ctx.instanceConnect`). */
async function announce(ctx: SystemCtx<ConfigOf<ApiContract['defs']>>): Promise<void> {
  const config = ApiServiceConfig.parse(ctx.config);
  await ctx.instanceConnect(instanceConnectOf(config.label, config.auth));
}
