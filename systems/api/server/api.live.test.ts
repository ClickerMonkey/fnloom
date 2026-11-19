/**
 * Live: `make_api` on a real free model (skipped without a key) against a fake service (no network but the model):
 * with no service named, it adds the service from the base URL the request gives, reads the operations, writes a GET,
 * has it sent with its sample, and saves it for the service. Run with `npm run test:live`.
 */
import { API_SERVICE_TYPE, type Json } from '@harness/core';
import { liveTurn, realModel, testHub } from '@harness/sdk/testing';
import { describe, expect } from 'vitest';
import { api } from '../shared/index.ts';
import { apiEnv } from './env.ts';
import { createApiImpl } from './impl.ts';

/** The fake service: an OpenAPI document with one operation, and a repository. */
const service: typeof fetch = (input) => {
  const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
  const json = (status: number, value: Json) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));
  if (url === 'https://tracker.test/openapi.json') return json(200, { paths: { '/repos/{owner}/{repo}': { get: { summary: 'One repository: name, stargazers_count' } } } });
  if (url.startsWith('https://tracker.test/v1/repos/')) return json(200, { name: url.split('/').at(-1) ?? '', stargazers_count: 42 });
  return json(404, { message: 'Not Found' });
};

describe('make_api, live', () => {
  realModel.it('adds the service, writes a GET from the operations, sends it with its sample and saves it', async (model) => {
    const kit = await testHub(api, createApiImpl({ settings: apiEnv.parse() }), { model, serve: { fetch: service } });
    try {
      const { result } = await kit.call('make_api', {
        request: 'The star count of a repository on the Tracker API (service name tracker, base URL https://tracker.test/v1, no sign-in, OpenAPI document https://tracker.test/openapi.json): GET /repos/{owner}/{repo}; args owner and repo (text); give the stargazers_count as a num. acme/web has 42.',
      }, liveTurn());
      expect(result.fn).toMatch(/^api\/tracker\./);
      expect(kit.hub.data.of(API_SERVICE_TYPE).map((record) => record.value)).toEqual([expect.objectContaining({ name: 'tracker', baseUrl: 'https://tracker.test/v1' })]);
      expect(kit.hub.fns.kept.get(result.fn)?.saved.routing).toBeUndefined();
    } finally {
      await kit.stop();
    }
  }, 300_000);
});
