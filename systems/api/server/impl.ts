/**
 * The api system's implementation, one instance that authors api fns (like `code`): the `request` kind (check,
 * describe and run through the shared program runtime and the executor), `make_api` (the authoring agent in
 * `authoring.ts`), `services`, `operations`, `test_request`, and `connect` (a person's own token or header values for a
 * service, or the shared ones an admin sets for everyone). The services are records in the hub (`services.ts`); api fns
 * are the hub's; a person's credentials are the hub's secrets, sent with each run that acts through a service.
 */
import { API_KIND, ApiFnSpec, KindDescription, strongerMode, type ApiService, type Json, type QualifiedName, type ResourceUri } from '@harness/core';
import { CallFailed, credentialsFromForm, hub, sampleArgs, type Files, type KindCheckCtx, type SystemImpl } from '@harness/sdk';
import { calleesMode, hubProgramHost, kindCheckLookups, kindRunLookups, ProgramError, storedProgramScope, type ProgramLookups } from '@harness/sdk/program';
import { AuthoringError } from '@harness/sdk/server';
import { HttpRequest, type ApiContract } from '../shared/index.ts';
import { ApiAuthoring, apiAuthoring } from './authoring.ts';
import type { ApiSettings } from './env.ts';
import { boundCredentials, NoCredential, prepare, RequestRefused, ResponseFailed, responseFile, send, serviceAccount, type SendCtx } from './http.ts';
import { operationsPage, readOperations } from './openapi.ts';
import { checkApi, modeOf, readableApi, runApi, type ApiCheck } from './program.ts';
import { NoService, Services } from './services.ts';

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

/** What a run brings to sending: its fetch and signal, its connection, files for a file response, resource bytes. */
interface RunSending {
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
  readonly files: Files;
  readonly resources: { bytes(uri: ResourceUri): Promise<Uint8Array> };
  readonly connection: { credentials: Json } | undefined;
}

/**
 * How a run sends to a service: its fetch and signal, files to keep a file response, resource bytes, and the run's
 * connection, but only when the run acts through this service (`connectedTo`): a connection to one service never
 * signs a request to another.
 */
function sendCtx(settings: ApiSettings, ctx: RunSending, service: ApiService, connectedTo: string | undefined): SendCtx {
  return {
    maxRedirects: settings.HARNESS_API_MAX_REDIRECTS,
    fetch: ctx.fetch,
    signal: ctx.signal,
    credentials: connectedTo === service.name ? ctx.connection?.credentials : undefined,
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
  if (error instanceof ResponseFailed || error instanceof RequestRefused || error instanceof ProgramError || error instanceof NoService) return error.message;
  if (error instanceof CallFailed) return `A fn it calls failed: ${error.message}`;
  return undefined;
}

/** Build the api implementation. */
export function createApiImpl(deps: ApiDeps): SystemImpl<ApiContract['defs']> {
  return {
    fns: {
      make_api: {
        async run(args, ctx) {
          const services = new Services(ctx.data);
          const given = args.service === undefined ? undefined : await services.get(args.service);
          if (args.service !== undefined && given === undefined) return ctx.fail('caller', new NoService(args.service).message);
          const getFn = async (fn: QualifiedName) => await ctx.fns.getFn({ fn });
          const state = new ApiAuthoring({
            host: hubProgramHost(ctx, getFn),
            service: given,
            deps: {
              services: {
                find: (query) => services.find(query),
                get: (name) => services.get(name),
                add: async (input) => {
                  const added = await services.add(input);
                  ctx.log.info('api.service.added', { service: added.service.name });
                  return added;
                },
              },
              send: (service) => sendCtx(deps.settings, ctx, service, args.service),
              async operations(service, query) {
                if (service.openapi === undefined) throw new Error(`${service.label} has no OpenAPI document set.`);
                return operationsPage(await readOperations(service.openapi, ctx.fetch, ctx.signal), query);
              },
              getFn,
              async saveFn(save) {
                const saved = await ctx.fns.saveFn({
                  kind: API_KIND, name: save.name, description: save.description, instructions: `Asked for: ${args.request}`, payload: save.payload,
                  examples: save.examples, tags: ['api', save.service],
                });
                return { fn: saved.fn, version: saved.version };
              },
            },
          });
          try {
            const { result } = await apiAuthoring.run(await ctx.ai(), args.request, state);
            ctx.log.info('api.authored', { fn: result.fn, reused: result.reused, service: state.service?.name ?? null });
            return ctx.done(result);
          } catch (error) {
            if (!(error instanceof AuthoringError)) throw error;
            const last = error.problems.length === 0 ? '' : ` Its last problems: ${error.problems.join(' ')}`;
            return ctx.fail('caller', `No api fn was written: ${error.message}${last} Say more exactly which service, which operation and what the result holds.`);
          }
        },
      },
      services: {
        async run(args, ctx) {
          return ctx.done(await new Services(ctx.data).find(args));
        },
      },
      operations: {
        async run(args, ctx) {
          const service = await new Services(ctx.data).get(args.service);
          if (service === undefined) return ctx.fail('caller', new NoService(args.service).message);
          if (service.openapi === undefined) return ctx.fail('caller', `${service.label} has no OpenAPI document set; an admin can add its URL to the service.`);
          return ctx.done(operationsPage(await readOperations(service.openapi, ctx.fetch, ctx.signal), args));
        },
      },
      test_request: {
        async run(args, ctx) {
          const service = await new Services(ctx.data).get(args.service);
          if (service === undefined) return ctx.fail('caller', new NoService(args.service).message);
          const request = HttpRequest.parse({ method: args.method ?? 'GET', url: args.url, ...(args.params === undefined ? {} : { params: args.params }), ...(args.headers === undefined ? {} : { headers: args.headers }) });
          const how = sendCtx(deps.settings, ctx, service, args.service);
          try {
            return ctx.done((await send(await prepare(request, service, how), service, how)).exchange);
          } catch (error) {
            if (error instanceof ResponseFailed) return ctx.done(error.exchange);
            if (error instanceof NoCredential) return ctx.fail('caller', error.message, { code: 'not-connected' });
            if (error instanceof RequestRefused) return ctx.invalid(error.message);
            throw error;
          }
        },
      },
    },
    // the HTTP types have no methods; services are records
    types: { Service: {}, HttpHeader: {}, HttpParam: {}, HttpPart: {}, HttpBody: {}, HttpRequest: {}, HttpResponse: {} },
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
            // it acts through the person's connection to its service
            connectKey: spec.service,
            // its args filled with sample values read off its schema
            examples: [{ args: sampleArgs(spec.args), note: `A ${check.method} request to the ${spec.service} service, with sample values: use real ones.` }],
            ...(readable === undefined ? {} : { readable: { language: 'ts', code: readable } }),
          });
        },
        async run(payload, args, ctx) {
          const spec = ApiFnSpec.parse(payload);
          const service = await new Services(ctx.data).get(spec.service);
          if (service === undefined) return ctx.fail('fatal', `${ctx.run.fn} is for the service ${spec.service}, which is gone.`);
          const { check, program } = await checked(spec, kindRunLookups(ctx));
          if (check.problems.length > 0) return ctx.fail('fatal', `${ctx.run.fn} no longer checks: ${check.problems.join(' ')}`);
          try {
            const outcome = await runApi({ program, spec, check, service, send: sendCtx(deps.settings, ctx, service, spec.service), call: async (fn, input) => ctx.call(fn, input) }, args);
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
      start(request) {
        // API services sign in with a typed token or header values (`RecordAuth`, never OAuth): there is no browser flow to start
        throw new Error(`An API service takes a typed token or header values on the connections page, not a sign-in (connection ${request.connection}).`);
      },
      async finish(request, ctx) {
        if (request.key === undefined) return { problem: 'Say which API service to connect to.' };
        const service = await new Services(ctx.data).get(request.key);
        if (service === undefined) return { problem: new NoService(request.key).message };
        if (!('form' in request.answer)) return { problem: `${service.label} takes a typed token or header values, not a sign-in.` };
        // a shared token is typed by an admin for everyone (the hub lets only an admin make that connection)
        const made = credentialsFromForm(service.auth, request.answer.form, 'any');
        if ('problem' in made) return { problem: made.problem };
        return { account: serviceAccount(made.credentials, service), credentials: boundCredentials(made.credentials, service) };
      },
      disconnect: () => Promise.resolve(),
    },
  };
}

