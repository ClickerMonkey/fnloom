/**
 * The service's operations, read from its OpenAPI document (JSON) a page at a time: what `operations` and the authoring
 * agent's `operations` tool show. The document is read fresh each time; nothing is kept here. It is fetched like a
 * request: every hop through the service's address check, redirects followed by hand.
 */
import { HttpMethod } from '@harness/core';
import { followRedirects } from '@harness/sdk/server';
import { z } from 'zod';
import type { ApiOperation, OperationsPage } from '../shared/index.ts';
import { RequestRefused, type SendCtx } from './http.ts';

const Operation = z.object({ summary: z.string().optional(), description: z.string().optional(), operationId: z.string().optional() });
const Document = z.object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) });

/** Every operation of a document, in its order. */
export function operationsOf(document: unknown): ApiOperation[] {
  const parsed = Document.safeParse(document);
  if (!parsed.success) throw new Error('The OpenAPI document has no paths (only JSON documents are read).');
  return Object.entries(parsed.data.paths).flatMap(([path, item]) => Object.entries(item).flatMap(([key, value]): ApiOperation[] => {
    const method = HttpMethod.safeParse(key.toUpperCase());
    const operation = Operation.safeParse(value);
    if (!method.success || !operation.success) return [];
    const summary = operation.data.summary ?? operation.data.description ?? '';
    return [{ method: method.data, path, summary, ...(operation.data.operationId === undefined ? {} : { operationId: operation.data.operationId }) }];
  }));
}

/** One page of the operations whose path, summary or id holds every word of `text`. */
export function operationsPage(all: readonly ApiOperation[], query: { text?: string | undefined; offset?: number | undefined; limit?: number | undefined }): OperationsPage {
  const words = (query.text ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
  const hits = all.filter((op) => { const hay = `${op.method} ${op.path} ${op.summary} ${op.operationId ?? ''}`.toLowerCase(); return words.every((word) => hay.includes(word)); });
  const offset = query.offset ?? 0;
  const items = hits.slice(offset, offset + (query.limit ?? 20));
  return { items, total: hits.length, ...(offset + items.length < hits.length ? { next: offset + items.length } : {}) };
}

/** Read a service's OpenAPI document, each hop through the service's address check (`SendCtx.guard`). */
export async function readOperations(url: string, how: Pick<SendCtx, 'fetch' | 'signal' | 'guard' | 'maxRedirects'>): Promise<ApiOperation[]> {
  const { response: answer } = await followRedirects(url, { signal: how.signal, headers: { accept: 'application/json' } }, {
    fetch: how.fetch,
    redirects: how.maxRedirects,
    check: (at, signal) => how.guard.check(at, signal),
    problems: {
      noLocation: (at) => new RequestRefused(`The OpenAPI document at ${at.href} redirected without saying where.`),
      tooMany: (start, limit) => new RequestRefused(`The OpenAPI document at ${start.href} redirected more than ${String(limit)} times.`),
    },
  });
  if (!answer.ok) throw new Error(`The OpenAPI document at ${url} answered ${String(answer.status)}.`);
  const document: unknown = await answer.json();
  return operationsOf(document);
}
