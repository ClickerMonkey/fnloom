/**
 * An api fn's two programs on the shared runtime (`@harness/sdk/program`): the request program must give an
 * `api/HttpRequest` whose method is written literally (so the fn's mode is known before it runs) with at most one body
 * slot; the output program reads `response` (an `api/HttpResponse` whose body is `responseType`) and gives the fn's
 * result. Absent an output program, the response body is the result.
 */
import type { ExprDef, Type, TypeDef } from '@aeye/gin';
import { HttpMethod, isGinExprDef, Json, type ApiFnSpec, type ApiServiceConfig, type HttpExchange, type QualifiedName } from '@harness/core';
import { checkProgram, runProgram, type ProgramCheck, type ProgramScope } from '@harness/sdk/program';
import { ginAs } from '@harness/sdk';
import { HttpRequest, HttpResponse } from '../shared/http.ts';
import { prepare, send, type SendCtx } from './http.ts';

/** The request type's name, as programs spell it. */
export const REQUEST_TYPE = 'api/HttpRequest';
/** The name the output program reads the response by. */
export const RESPONSE_SCOPE = 'response';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every `new api/HttpRequest` payload in a program. */
function requestPayloads(def: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!isRecord(node)) return;
    const type = node['type'];
    const value = node['value'];
    if (node['kind'] === 'new' && isRecord(type) && type['name'] === REQUEST_TYPE && isRecord(value)) found.push(value);
    for (const child of Object.values(node)) visit(child);
  };
  visit(def);
  return found;
}

/** The method every request the program builds agrees on, written literally; `undefined` when it isn't known. */
export function requestMethod(def: ExprDef): HttpMethod | undefined {
  const methods = requestPayloads(def).map((payload) => HttpMethod.safeParse(payload['method']));
  const first = methods[0];
  if (first === undefined || !first.success) return undefined;
  return methods.every((method) => method.success && method.data === first.data) ? first.data : undefined;
}

/** What a request with this method does: GET and HEAD read; DELETE deletes; the others write. */
export function modeOf(method: HttpMethod | undefined): 'read' | 'write' | 'delete' {
  if (method === 'GET' || method === 'HEAD') return 'read';
  return method === 'DELETE' ? 'delete' : 'write';
}

/** Problems with the bodies the program writes literally: each sets exactly one slot. */
function bodyProblems(def: ExprDef): string[] {
  return requestPayloads(def).flatMap((payload) => {
    const body = payload['body'];
    if (!isRecord(body) || isGinExprDef(body)) return [];
    const slots = Object.keys(body);
    return slots.length === 1 ? [] : [`request: set exactly one body slot (json, form, multipart, text or binary); this body sets ${slots.length === 0 ? 'none' : slots.join(' and ')}. The slot you set is the wire encoding.`];
  });
}

/** The `response` an output program reads: `HttpResponse` with its body typed by `responseType`. */
export function responseType(program: ProgramScope, body: TypeDef): Type {
  const response = ginAs(HttpResponse).toJSON();
  return program.parse({ ...response, props: { ...response.props, body: { type: body } } });
}

/** What an api fn's check found: its problems, the method, and each program's check. */
export interface ApiCheck {
  readonly problems: string[];
  readonly method: HttpMethod | undefined;
  readonly request: ProgramCheck;
  readonly output: ProgramCheck | undefined;
  /** Every fn either program calls. */
  readonly calls: QualifiedName[];
}

/** The parts of an api fn its check reads. */
export type ApiPrograms = Pick<ApiFnSpec, 'args' | 'returns' | 'request' | 'responseType' | 'output'>;

/** Check both programs, the literal method and the body slots. */
export function checkApi(program: ProgramScope, spec: ApiPrograms): ApiCheck {
  const problems: string[] = [];
  if (spec.args.name !== 'obj') problems.push('args must be an obj type.');
  const request = checkProgram(program, spec.request, { args: spec.args, returns: { name: REQUEST_TYPE }, label: 'request' });
  problems.push(...request.problems);
  const method = requestMethod(spec.request);
  if (method === undefined) problems.push('request: write `method` literally (GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS) in the api/HttpRequest it gives, the same in every branch: a computed method can\'t be approved before it runs. Two methods are two fns.');
  problems.push(...bodyProblems(spec.request));
  let output: ProgramCheck | undefined;
  if (spec.output === undefined) {
    if (spec.responseType !== undefined && !program.parse(spec.returns).compatible(program.parse(spec.responseType))) {
      problems.push('Without an output program the response body is the result, so responseType must fit the declared result: add an output program, or make them one type.');
    }
  } else if (spec.responseType === undefined) {
    problems.push('output: give responseType, the type of response.body the output program reads.');
  } else {
    output = checkProgram(program, spec.output, { args: spec.args, returns: spec.returns, owned: new Map([[RESPONSE_SCOPE, responseType(program, spec.responseType)]]), label: 'output' });
    problems.push(...output.problems);
  }
  return { problems, method, request, output, calls: [...new Set([...request.calls, ...(output?.calls ?? [])])] };
}

/** What running an api fn needs: its checked programs, the service, the run's sending context and its fn calls. */
export interface ApiRun {
  readonly program: ProgramScope;
  readonly spec: ApiPrograms;
  readonly check: ApiCheck;
  readonly config: ApiServiceConfig;
  readonly send: SendCtx;
  readonly call: (fn: QualifiedName, args: Json) => Promise<Json>;
}

/** What one api fn run gave: the exchange, and the result (absent when the request was only prepared). */
export interface ApiOutcome {
  readonly exchange: HttpExchange;
  readonly result?: Json | undefined;
}

/**
 * Run an api fn: the request program with these args, the request prepared (under the base URL, signed), and, unless
 * `prepareOnly`, sent and mapped by the output program (else the body, checked against the result type).
 */
export async function runApi(run: ApiRun, args: Json, options: { prepareOnly?: boolean } = {}): Promise<ApiOutcome> {
  const { program, spec, check } = run;
  if (check.request.expr === undefined) throw new Error('The request program does not parse.');
  const built = await runProgram({ program, expr: check.request.expr, args: spec.args, returns: { name: REQUEST_TYPE }, calls: check.request.calls, call: run.call, signal: run.send.signal }, args);
  const request = HttpRequest.parse(built);
  const prepared = await prepare(request, run.config, run.send);
  if (options.prepareOnly === true) return { exchange: prepared.exchange };
  const sent = await send(prepared, run.config, run.send);
  if (spec.output === undefined || check.output?.expr === undefined || spec.responseType === undefined) {
    return { exchange: sent.exchange, result: Json.parse(program.parse(spec.returns).parse(sent.response.body).encodeLogical()) };
  }
  const response = responseType(program, spec.responseType).parse(sent.response);
  const result = await runProgram({
    program, expr: check.output.expr, args: spec.args, returns: spec.returns, calls: check.output.calls, call: run.call, signal: run.send.signal, owned: { [RESPONSE_SCOPE]: response },
  }, args);
  return { exchange: sent.exchange, result };
}
