/**
 * The api authoring agent behind `make_api`, on the SDK's `authoringAgent` and the shared program tools (product's api
 * agent, ported): the chat model says what request it wants from the service; this agent works through the forced
 * workflow on `ctx.ai()` and the chat gets back the saved fn of the service.
 *
 * - **find:** `search` lists fns (api fns of this service among them; `reuse` answers with one).
 * - **inspect:** `operations` (the service's OpenAPI operations, a page at a time), `load`, `examples` and `signature`.
 * - **set → check → fix:** the draft's request program (and output program) is checked: the request type, a literal
 *   method, one body slot, the output over `response`. A clean GET that calls no fn is sent with the sample args, so the
 *   agent sees the real response; any other request is prepared and shown, never sent. `test` tries other args.
 * - **return:** the clean draft is kept with `hub/save_fn` as an `api/request` fn of this service (`<service>.<name>`).
 */
import type { ExprDef, TypeDef } from '@aeye/gin';
import { API_KIND, ApiFnSpec, GinExprDef, GinTypeDef, Json, QualifiedName, type ApiServiceConfig, type InstanceName } from '@harness/core';
import { encodeValue, type Infer, type StoredFn } from '@harness/sdk';
import { previewText, ProgramAuthoring, ProgramError, programTools, testTool, type ProgramHost, type ProgramSession } from '@harness/sdk/program';
import { authoringAgent, authoringTool, type AuthoredFn } from '@harness/sdk/server';
import { z } from 'zod';
import { ApiPayload, HTTP_TYPES, type OperationsPage } from '../shared/index.ts';
import { NoCredential, RequestRefused, ResponseFailed, type SendCtx } from './http.ts';
import { checkApi, runApi, type ApiCheck } from './program.ts';

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
  /** This instance: the service the fn is for. */
  readonly service: InstanceName;
  readonly config: ApiServiceConfig;
  /** How a request is sent while authoring (GETs only). */
  readonly send: SendCtx;
  /** A page of the service's operations; throws when it has no OpenAPI document. */
  operations(query: { text?: string | undefined; offset?: number | undefined }): Promise<OperationsPage>;
  getFn(name: QualifiedName): Promise<Infer<typeof StoredFn>>;
  saveFn(args: { name: string; description: string; payload: Json; examples: Array<{ args: Json; result?: Json }> }): Promise<{ fn: string; version: number }>;
}

/** One api authoring run's state. */
export class ApiAuthoring extends ProgramAuthoring {
  readonly deps: ApiAuthoringDeps;

  constructor(input: { host: ProgramHost; deps: ApiAuthoringDeps }) {
    super({ host: input.host, kind: QualifiedName.parse(API_KIND), own: HTTP_TYPES.map((name) => QualifiedName.parse(`api/${name}`)), guide: API_GUIDE });
    this.deps = input.deps;
  }
}

type Session = ProgramSession<ApiAuthoring, ApiDraft>;

const text = { name: 'text' } as const;
const arg = (name: string) => ({ kind: 'get', path: [{ prop: 'args' }, { prop: name }] });

const num = { name: 'num' } as const;
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
        params: [{ key: 'state', value: 'open' }],
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
        body: { json: { kind: 'new', type: { name: 'obj', props: { title: { type: text } } }, value: { title: arg('title') } } },
      },
    },
  },
};

/** How api programs are written, with the worked examples (`examples`). */
export const API_GUIDE = [
  'An api fn is two gin programs (JSON). request gives an api/HttpRequest; output (optional) reads `response` and gives the result. Both read args as {"kind":"get","path":[{"prop":"args"},{"prop":"<name>"}]}.',
  '- Build the request with {"kind":"new","type":{"name":"api/HttpRequest"},"value":{…}}: method written literally (GET, POST, …), url relative to the service (a template fills path parts from args), params and headers as [{"key","value"}] lists.',
  '- A body sets exactly one slot: {"json": <expr>} (most APIs), {"form": [params]}, {"multipart": [parts]}, {"text": <expr>} or {"binary": <resource uri>}. Never put a credential in a request: the service signs it.',
  '- responseType is the type of response.body; output maps response (status, headers, body) to the result. Without output, the body is the result, so responseType must fit it.',
  '- A method call is two path steps: {"prop":"toText"} then {"args":{}}. A list result is best the body itself (no output, no responseType): the checker can not type a list mapped with a lambda yet.',
  '',
  `Example 1, signature ${JSON.stringify(API_EXAMPLES.repo.signature)}: request ${JSON.stringify(API_EXAMPLES.repo.request)}, responseType ${JSON.stringify(API_EXAMPLES.repo.responseType)}, output ${JSON.stringify(API_EXAMPLES.repo.output)}`,
  `Example 2, signature ${JSON.stringify(API_EXAMPLES.openIssues.signature)}, the body as the result: request ${JSON.stringify(API_EXAMPLES.openIssues.request)}`,
  `Example 3, a POST with a JSON body (the response body, obj{number: num}, is the result): request ${JSON.stringify(API_EXAMPLES.createIssue.request)}`,
].join('\n');

/** The agent's job, step by step. */
const INSTRUCTIONS = [
  'You write one api fn for the request below: a request to this web API service, kept as a fn of the service. Work through the tools in order; each step unlocks the next.',
  '',
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

/** The draft as the payload's parts. */
function programsOf(draft: ApiDraft, session: Session): ApiFnSpec | undefined {
  const signature = session.state.signature;
  if (signature === undefined) return undefined;
  return {
    service: session.state.deps.service, args: signature.args, returns: signature.returns, request: draft.request,
    ...(draft.responseType === undefined ? {} : { responseType: draft.responseType }),
    ...(draft.output === undefined ? {} : { output: draft.output }),
  };
}

/** Check a draft, then send it (a GET calling no fn) or prepare it, with these args. */
async function tryDraft(draft: ApiDraft, args: Record<string, Json>, session: Session): Promise<{ check: ApiCheck | undefined; problems: string[]; notes: string[]; result?: Json }> {
  const state = session.state;
  const spec = programsOf(draft, session);
  if (spec === undefined) return { check: undefined, problems: ['Declare the signature first (signature), then set the draft again.'], notes: [] };
  const check = checkApi(state.program, spec);
  if (check.problems.length > 0) return { check, problems: check.problems, notes: [] };
  if (check.calls.length > 0) return { check, problems: [], notes: [`It calls ${check.calls.join(', ')}, so it was checked, not run.`] };
  const sendable = check.method === 'GET' || check.method === 'HEAD';
  try {
    const outcome = await runApi({ program: state.program, spec, check, config: state.deps.config, send: state.deps.send, call: () => Promise.reject(new Error('A test run calls no fn.')) }, args, { prepareOnly: !sendable });
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

/** `operations`: the service's OpenAPI operations, narrowed by words, a page at a time. */
const operationsTool = authoringTool<ApiAuthoring, ApiDraft, { text?: string | undefined; offset?: number | undefined }>({
  name: 'operations',
  stage: 'inspect',
  description: 'List the service\'s operations (method, path, summary) from its OpenAPI document, narrowed by words of the path or summary.',
  schema: z.object({ text: z.string().optional().describe('Words of the path or summary.'), offset: z.number().int().min(0).optional().describe('`next` of the last page.') }),
  when: (session) => session.state.deps.config.openapi !== undefined,
  async call(query, session) {
    const page = await session.state.deps.operations(query);
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
  description: 'Find or write one api fn (a request to this service, and how its response becomes the result).',
  instructions: INSTRUCTIONS,
  tools: [...programTools<ApiAuthoring, ApiDraft>(), operationsTool, apiTest],
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
    const spec = programsOf(draft, session);
    if (spec === undefined) throw new Error('Declare the signature first.');
    const preview = session.lastCheck?.preview;
    const saved = await state.deps.saveFn({
      name: `${state.deps.service}.${draft.name}`, description: draft.description, payload: encodeValue(ApiPayload, spec),
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
    if (stored.kind !== API_KIND || !spec.success || spec.data.service !== state.deps.service) return `${fn} is not an api fn of this service.`;
    await state.loadTypes([...state.program.unresolved(spec.data.args), ...state.program.unresolved(spec.data.returns)].map((type) => QualifiedName.parse(type)));
    return { fn: stored.fn, version: stored.version, about: stored.description, reused: true, signature: state.program.signature(stored.fn, spec.data.args, spec.data.returns), call: callText(stored.fn, {}) };
  },
});
