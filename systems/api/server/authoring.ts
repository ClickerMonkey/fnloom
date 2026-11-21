/**
 * The api authoring agent behind `make_api`, on the SDK's `authoringAgent` and the shared program tools (product's api
 * agent, ported): the chat model says what request it wants from which web API; this agent works through the forced
 * workflow on `ctx.ai()` and the chat gets back the saved api fn. Like `code`, it authors code: here, code that calls
 * an external service.
 *
 * - **find:** the service, unless `make_api` named it: `services` lists them (in the hub's database), `use_service`
 *   picks one, `add_service` adds one from the base URL the request gives (a record, never a secret: people connect
 *   to it on the Connections page). `search` lists fns (api fns among them; `reuse` answers with one).
 * - **inspect:** `operations` (the service's OpenAPI operations, a page at a time), `load`, `examples` and `signature`.
 * - **set → check → fix:** the draft's request program (and output program) is checked: the request type, a literal
 *   method, one body slot, the output over `response`. A clean GET that calls no fn is sent with the sample args, so the
 *   agent sees the real response; any other request is prepared and shown, never sent. `test` tries other args.
 * - **return:** the clean draft is kept with `hub/save_fn` as an `api/request` fn of its service (`<service>.<name>`).
 */
import type { ExprDef, TypeDef } from '@aeye/gin';
import { API_KIND, ApiFnSpec, GinExprDef, GinTypeDef, Json, QualifiedName, type ApiService } from '@harness/core';
import { encodeValue, type Infer, type StoredFn } from '@harness/sdk';
import { previewText, ProgramAuthoring, ProgramError, programTools, testTool, type ProgramHost, type ProgramSession } from '@harness/sdk/program';
import { authoringAgent, authoringTool, type AuthoredFn } from '@harness/sdk/server';
import { z } from 'zod';
import { ApiPayload, HTTP_TYPES, type OperationsPage, type ServicesPage } from '../shared/index.ts';
import { NoCredential, RequestRefused, ResponseFailed, type SendCtx } from './http.ts';
import { checkApi, runApi, type ApiCheck } from './program.ts';
import { NewService } from './services.ts';

/** A draft as the agent writes it. */
export interface ApiDraft {
  readonly name: string;
  readonly description: string;
  readonly request: ExprDef;
  readonly responseType?: TypeDef | undefined;
  readonly output?: ExprDef | undefined;
  /** Args to check it with, by name. */
  readonly sample: Record<string, Json>;
}

/** What an api authoring run needs from its run besides the program host. */
export interface ApiAuthoringDeps {
  /** The services, as the run's person sees them (`Services`). */
  readonly services: {
    find(query: { text?: string | undefined; limit?: number | undefined }): Promise<ServicesPage>;
    get(name: string): Promise<ApiService | undefined>;
    add(input: unknown): Promise<{ service: ApiService }>;
  };
  /** How a request to this service is sent while authoring (GETs only), signed by the run's connection to it if any. */
  send(service: ApiService): SendCtx;
  /** A page of the service's operations; throws when it has no OpenAPI document. */
  operations(service: ApiService, query: { text?: string | undefined; offset?: number | undefined }): Promise<OperationsPage>;
  getFn(name: QualifiedName): Promise<Infer<typeof StoredFn>>;
  saveFn(args: { service: string; name: string; description: string; payload: Json; examples: Array<{ args: Json; result?: Json }> }): Promise<{ fn: string; version: number }>;
}

/** One api authoring run's state: the service it writes for, once given, picked or added. */
export class ApiAuthoring extends ProgramAuthoring {
  readonly deps: ApiAuthoringDeps;
  #service: ApiService | undefined;

  constructor(input: { host: ProgramHost; deps: ApiAuthoringDeps; service?: ApiService | undefined }) {
    super({ host: input.host, kind: QualifiedName.parse(API_KIND), own: HTTP_TYPES.map((name) => QualifiedName.parse(`api/${name}`)), guide: API_GUIDE });
    this.deps = input.deps;
    this.#service = input.service;
  }

  /** The service the fn is for; undefined until it is given, picked or added. */
  get service(): ApiService | undefined {
    return this.#service;
  }

  /** Write for this service from now on. */
  use(service: ApiService): void {
    this.#service = service;
  }
}

type Session = ProgramSession<ApiAuthoring, ApiDraft>;

const text = { name: 'text' } as const;
const arg = (name: string) => ({ kind: 'get', path: [{ prop: 'args' }, { prop: name }] });

const num = { name: 'num' } as const;
/** A literal of a type: how a composite slot (a list, an object, a body, an any-JSON value) is written in a strict program. */
const lit = (type: object, value: unknown) => ({ kind: 'new', type, value });
const field = (from: string, name: string) => ({ kind: 'get', path: [{ prop: from }, { prop: 'body' }, { prop: name }] });
const ISSUE = { name: 'obj', props: { number: { type: num }, title: { type: text } } };

/** The worked examples `examples` shows. */
export const API_EXAMPLES = {
  /** `(owner: text, repo: text) → obj{name, stars}`: a GET with a templated path, and an output program over the body. */
  repo: {
    signature: { args: { name: 'obj', props: { owner: { type: text }, repo: { type: text } } }, returns: { name: 'obj', props: { name: { type: text }, stars: { type: num } } } },
    request: {
      kind: 'new', type: { name: 'api/HttpRequest' },
      value: { method: 'GET', url: { kind: 'template', template: '/repos/{owner}/{repo}', params: { kind: 'get', path: [{ prop: 'args' }] } } },
    },
    responseType: { name: 'obj', props: { name: { type: text }, stargazers_count: { type: num } } },
    output: { kind: 'new', type: { name: 'obj', props: { name: { type: text }, stars: { type: num } } }, value: { name: field('response', 'name'), stars: field('response', 'stargazers_count') } },
  },
  /** `(owner: text, repo: text) → list<obj{number, title}>`: a GET with a query param; no output, so the body is the result. */
  openIssues: {
    signature: { args: { name: 'obj', props: { owner: { type: text }, repo: { type: text } } }, returns: { name: 'list', generic: { V: ISSUE } } },
    request: {
      kind: 'new', type: { name: 'api/HttpRequest' },
      value: {
        method: 'GET',
        url: { kind: 'template', template: '/repos/{owner}/{repo}/issues', params: { kind: 'get', path: [{ prop: 'args' }] } },
        params: lit({ name: 'list', generic: { V: { name: 'api/HttpParam' } } }, [lit({ name: 'api/HttpParam' }, { key: 'state', value: lit(text, 'open') })]),
      },
    },
  },
  /** `(owner, repo, title: text) → obj{number}`: a POST with a JSON body; no output, so the body is the result. */
  createIssue: {
    request: {
      kind: 'new', type: { name: 'api/HttpRequest' },
      value: {
        method: 'POST',
        url: { kind: 'template', template: '/repos/{owner}/{repo}/issues', params: { kind: 'get', path: [{ prop: 'args' }] } },
        body: lit({ name: 'api/HttpBody' }, { json: lit({ name: 'obj', props: { title: { type: text } } }, { title: arg('title') }) }),
      },
    },
  },
};

/** How api programs are written, with the worked examples (`examples`). */
export const API_GUIDE = [
  'An api fn is two gin programs (JSON). request gives an api/HttpRequest; output (optional) reads `response` and gives the result. Both read args as {"kind":"get","path":[{"prop":"args"},{"prop":"<name>"}]}.',
  '- In a {"kind":"new"} value, a plain field (text, a number, a bool, an enum such as method) takes its value as is ("GET") or an expression; every other field (a list, an object, a body, a value of any JSON) takes an expression, usually a {"kind":"new"} of its type.',
  '- Build the request with {"kind":"new","type":{"name":"api/HttpRequest"},"value":{…}}: method written literally ("GET", "POST", …), url relative to the service (a template fills path parts from args), params and headers each a new list<api/HttpParam> / list<api/HttpHeader> of new api/HttpParam / api/HttpHeader items.',
  '- A body is a new api/HttpBody setting exactly one slot: json (most APIs, any JSON expression), form (a list of params), multipart (a list of parts), text or binary (a resource uri). Never put a credential in a request: the service signs it.',
  '- responseType is the type of response.body; output maps response (status, headers, body) to the result. Without output, the body is the result, so responseType must fit it.',
  '- A method call is two path steps: {"prop":"toText"} then {"args":{}}. A list result is best the body itself (no output, no responseType): the checker can not type a list mapped with a lambda yet.',
  '',
  `Example 1, signature ${JSON.stringify(API_EXAMPLES.repo.signature)}: request ${JSON.stringify(API_EXAMPLES.repo.request)}, responseType ${JSON.stringify(API_EXAMPLES.repo.responseType)}, output ${JSON.stringify(API_EXAMPLES.repo.output)}`,
  `Example 2, signature ${JSON.stringify(API_EXAMPLES.openIssues.signature)}, the body as the result: request ${JSON.stringify(API_EXAMPLES.openIssues.request)}`,
  `Example 3, a POST with a JSON body (the response body, obj{number: num}, is the result): request ${JSON.stringify(API_EXAMPLES.createIssue.request)}`,
].join('\n');

/** The agent's job, step by step. */
const INSTRUCTIONS = [
  'You write one api fn for the request below: a request to a web API service, kept as a fn of that service. Work through the tools in order; each step unlocks the next.',
  '',
  '0. The service, unless one is given: services with words of its name or base URL, then use_service with its name; when there is none, add_service with the base URL the request gives (a short lowercase name, a label, how it signs in; never a token).',
  '1. search with what the request does: an api fn of this service that already does it is the answer (call reuse with its name and stop).',
  '2. operations to find the method, path and params (when the service has an OpenAPI document); examples once; load fns or types you need.',
  '3. signature: the args as an obj type and the result type (what the caller gets, not the whole response).',
  '4. set the whole draft: name (snake_case), description (one sentence), request, responseType and output when the result is not the whole body, and sample args.',
  '   It is checked at once. A GET is sent with the sample args and you see the real response; other methods are only prepared. Fix every problem listed and set it again, whole.',
  '5. When it is clean, test other args if it matters, then call return. Answer in one line.',
].join('\n');

/** The fn's call as the chat model writes it. */
function callText(fn: string, args: Json): string {
  return `${fn}(${JSON.stringify(args)})`;
}

/** The draft as the payload's parts, for the service chosen. */
function programsOf(draft: ApiDraft, session: Session, service: ApiService): ApiFnSpec | undefined {
  const signature = session.state.signature;
  if (signature === undefined) return undefined;
  return {
    service: service.name, args: signature.args, returns: signature.returns, request: draft.request,
    ...(draft.responseType === undefined ? {} : { responseType: draft.responseType }),
    ...(draft.output === undefined ? {} : { output: draft.output }),
  };
}

/** Check a draft, then send it (a GET calling no fn) or prepare it, with these args. */
async function tryDraft(draft: ApiDraft, args: Record<string, Json>, session: Session): Promise<{ check: ApiCheck | undefined; problems: string[]; notes: string[]; result?: Json }> {
  const state = session.state;
  const service = state.service;
  if (service === undefined) return { check: undefined, problems: [NO_SERVICE], notes: [] };
  const spec = programsOf(draft, session, service);
  if (spec === undefined) return { check: undefined, problems: ['Declare the signature first (signature), then set the draft again.'], notes: [] };
  const check = checkApi(state.program, spec);
  if (check.problems.length > 0) return { check, problems: check.problems, notes: [] };
  if (check.calls.length > 0) return { check, problems: [], notes: [`It calls ${check.calls.join(', ')}, so it was checked, not run.`] };
  const sendable = check.method === 'GET' || check.method === 'HEAD';
  try {
    const outcome = await runApi({ program: state.program, spec, check, service, send: state.deps.send(service), call: () => Promise.reject(new Error('A test run calls no fn.')) }, args, { prepareOnly: !sendable });
    const exchange = `${outcome.exchange.method} ${outcome.exchange.url}${outcome.exchange.response === undefined ? '' : ` → ${String(outcome.exchange.response.status)}`}`;
    return {
      check, problems: [],
      notes: [sendable ? `Sent: ${exchange}` : `Prepared, not sent (a ${check.method ?? 'write'} is never sent while writing): ${exchange}${outcome.exchange.body === undefined ? '' : `, body ${outcome.exchange.body}`}`],
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
    };
  } catch (error) {
    if (error instanceof NoCredential) return { check, problems: [], notes: [`Not sent: ${error.message}`] };
    if (error instanceof ResponseFailed) return { check, problems: [`Sending it with the sample args failed: ${error.message}`], notes: [] };
    if (error instanceof RequestRefused || error instanceof ProgramError) return { check, problems: [error.message], notes: [] };
    throw error;
  }
}

/** What a check says while no service is chosen. */
const NO_SERVICE = 'Choose the service first: use_service with one services listed, or add_service with its base URL.';

/** A service in one line: its name, label, base URL, sign-in and whether it has an OpenAPI document. */
function serviceLine(service: ApiService): string {
  const auth = service.auth.kind === 'none' ? 'no sign-in' : `${service.auth.kind} (${service.auth.per})`;
  return `- ${service.name}: ${service.label}, ${service.baseUrl}, ${auth}${service.openapi === undefined ? '' : ', has an OpenAPI document'}${service.description === undefined ? '' : `. ${service.description}`}`;
}

/** `services`: the services there are, by words of their name, label, description or base URL. */
const servicesTool = authoringTool<ApiAuthoring, ApiDraft, { text?: string | undefined }>({
  name: 'services',
  stage: 'find',
  description: 'List the web API services api fns are sent to, narrowed by words of their name, label, description or base URL.',
  schema: z.object({ text: z.string().optional().describe('Words of the service\'s name, label or base URL.') }),
  when: (session) => session.state.service === undefined,
  async call({ text }, session) {
    const page = await session.state.deps.services.find({ text, limit: 10 });
    return page.items.length === 0 ? 'No service matches: add_service adds one from its base URL.' : ['Services (use_service with the one the request is for):', ...page.items.map(serviceLine)].join('\n');
  },
});

/** `use_service`: write for a service there is. */
const useServiceTool = authoringTool<ApiAuthoring, ApiDraft, { name: string }>({
  name: 'use_service',
  stage: 'find',
  description: 'Write the fn for this service (one services listed).',
  schema: z.object({ name: z.string().min(1).describe('The service\'s name, as services listed it.') }),
  when: (session) => session.state.service === undefined,
  async call({ name }, session) {
    const service = await session.state.deps.services.get(name);
    if (service === undefined) throw new Error(`There is no service ${name}: services lists them.`);
    session.state.use(service);
    return `Writing for ${service.label}:\n${serviceLine(service)}`;
  },
});

/** `add_service`: add the service the request is for, from its base URL; it holds no secret. */
const addServiceTool = authoringTool<ApiAuthoring, ApiDraft, z.infer<typeof NewService>>({
  name: 'add_service',
  stage: 'find',
  description: 'Add the web API service the request is for, when services lists none: its name, label, base URL, how it signs in, and its OpenAPI document when the request gives one.',
  instructions: 'Only for a service there is none of. Never put a token in it: people connect their own (per: person), or an admin sets a shared one (per: shared), on the Connections page. It is the person\'s own until an admin shares it. A private or local address (localhost, 10.x, 192.168.x, 169.254.x) is refused.',
  schema: NewService,
  when: (session) => session.state.service === undefined,
  async call(input, session) {
    const { service } = await session.state.deps.services.add(input);
    session.state.use(service);
    const signIn = service.auth.kind === 'none' ? '' : ` People connect to it on the Connections page (${service.auth.per === 'person' ? 'each their own' : 'an admin, for everyone'}).`;
    return `Added ${service.label} and writing for it:\n${serviceLine(service)}${signIn} Only this person sees it until an admin shares it.`;
  },
});

/** `operations`: the service's OpenAPI operations, narrowed by words, a page at a time. */
const operationsTool = authoringTool<ApiAuthoring, ApiDraft, { text?: string | undefined; offset?: number | undefined }>({
  name: 'operations',
  stage: 'inspect',
  description: 'List the service\'s operations (method, path, summary) from its OpenAPI document, narrowed by words of the path or summary.',
  schema: z.object({ text: z.string().optional().describe('Words of the path or summary.'), offset: z.number().int().min(0).optional().describe('`next` of the last page.') }),
  when: (session) => session.state.service?.openapi !== undefined,
  async call(query, session) {
    const service = session.state.service;
    if (service === undefined) throw new Error(NO_SERVICE);
    const page = await session.state.deps.operations(service, query);
    return [
      page.items.length === 0 ? 'No operation matches.' : `Operations (${String(page.total)} match):`,
      ...page.items.map((op) => `- ${op.method} ${op.path}${op.operationId === undefined ? '' : ` (${op.operationId})`}: ${op.summary}`),
      page.next === undefined ? '' : `More: offset ${String(page.next)}.`,
    ].filter((line) => line !== '').join('\n');
  },
});

/** `test`: the clean draft with other args. */
const apiTest = testTool<ApiAuthoring, ApiDraft>(async (draft, args, session) => {
  const { problems, notes, result } = await tryDraft(draft, args, session);
  if (problems.length > 0) return `It fails with these args:\n${problems.join('\n')}`;
  return [...notes, result === undefined ? '' : `It gives: ${previewText(result)}`].filter((line) => line !== '').join('\n');
});

/** The draft's args, typed by gin's schemas over the types this session offers. */
function draftSchema(session: Session): z.ZodType<ApiDraft> {
  const { Expr, Type } = session.state.program.schemas();
  return z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/).describe('snake_case, after what it does.'),
    description: z.string().min(1).describe('One sentence: what it gives and what its args are for.'),
    request: Expr.pipe(GinExprDef).describe('The program giving the api/HttpRequest.'),
    responseType: Type.pipe(GinTypeDef).optional().describe('The type of response.body, when output reads it.'),
    output: Expr.pipe(GinExprDef).optional().describe('The program mapping `response` to the result.'),
    sample: z.record(z.string(), Json).describe('Sample args: a value for every required arg.'),
  });
}

/** The api authoring agent. Run it with the run's `ctx.ai()` and an `ApiAuthoring`. */
export const apiAuthoring = authoringAgent<ApiAuthoring, ApiDraft>({
  name: 'api_author',
  description: 'Find or write one api fn (a request to a web API service, and how its response becomes the result).',
  instructions: INSTRUCTIONS,
  tools: [servicesTool, useServiceTool, addServiceTool, ...programTools<ApiAuthoring, ApiDraft>(), operationsTool, apiTest],
  toolNames: { draft: 'set', save: 'return' },
  draft: { description: 'an api fn: name, description, the request program, responseType and output when needed, and sample args.', schema: draftSchema },
  async check(draft, session) {
    const { check, problems, notes, result } = await tryDraft(draft, draft.sample, session);
    const note = [
      check?.request.code === undefined ? '' : `Request as code: ${check.request.code}`,
      check?.output?.code === undefined ? '' : `Output as code: ${check.output.code}`,
      ...notes,
    ].filter((line) => line !== '').join('\n');
    return { problems, ...(result === undefined ? {} : { preview: result }), ...(note === '' ? {} : { note }) };
  },
  async save(draft, session) {
    const state = session.state;
    const service = state.service;
    if (service === undefined) throw new Error(NO_SERVICE);
    const spec = programsOf(draft, session, service);
    if (spec === undefined) throw new Error('Declare the signature first.');
    const preview = session.lastCheck?.preview;
    const saved = await state.deps.saveFn({
      service: service.name, name: `${service.name}.${draft.name}`, description: draft.description, payload: encodeValue(ApiPayload, spec),
      examples: [{ args: draft.sample, ...(preview === undefined ? {} : { result: preview }) }],
    });
    return {
      fn: saved.fn, version: saved.version, about: draft.description, reused: false, signature: state.program.signature(saved.fn, spec.args, spec.returns),
      call: callText(saved.fn, draft.sample), ...(preview === undefined ? {} : { preview }),
    } satisfies AuthoredFn;
  },
  async reuse(fn, session) {
    const state = session.state;
    const name = QualifiedName.safeParse(fn);
    if (!name.success || !session.disclosure.awareUnloaded('fn').concat(session.disclosure.loaded('fn')).includes(fn)) return `${fn} was not listed by search.`;
    const stored = await state.deps.getFn(name.data);
    const spec = ApiFnSpec.safeParse(stored.payload);
    const service = state.service;
    if (stored.kind !== API_KIND || !spec.success) return `${fn} is not an api fn.`;
    if (service !== undefined && spec.data.service !== service.name) return `${fn} is an api fn of ${spec.data.service}, not ${service.name}.`;
    await state.loadTypes([...state.program.unresolved(spec.data.args), ...state.program.unresolved(spec.data.returns)].map((type) => QualifiedName.parse(type)));
    return { fn: stored.fn, version: stored.version, about: stored.description, reused: true, signature: state.program.signature(stored.fn, spec.data.args, spec.data.returns), call: callText(stored.fn, {}) };
  },
});
