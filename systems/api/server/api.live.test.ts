/**
 * Live: `make_api` on a real free model (skipped without a key) against a fake service (no network but the model):
 * it reads the operations, writes a GET, has it sent with its sample, and saves it on the service. Run with
 * `npm run test:live`.
 */
import { InstanceName, type ApiServiceConfig, type Json } from '@harness/core';
import { liveTurn, realModel, testHub } from '@harness/sdk/testing';
import { describe, expect } from 'vitest';
import { api } from '../shared/index.ts';
import { apiEnv } from './env.ts';
import { createApiImpl } from './impl.ts';

const CONFIG: ApiServiceConfig = { label: 'Tracker', baseUrl: 'https://tracker.test/v1', auth: { kind: 'none' }, openapi: 'https://tracker.test/openapi.json', timeout: 60_000, maxBody: 2_000_000 };

/** The fake service: an OpenAPI document with one operation, and a repository. */
const service: typeof fetch = (input) => {
  const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
  const json = (status: number, value: Json) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));
  if (url === 'https://tracker.test/openapi.json') return json(200, { paths: { '/repos/{owner}/{repo}': { get: { summary: 'One repository: name, stargazers_count' } } } });
  if (url.startsWith('https://tracker.test/v1/repos/')) return json(200, { name: url.split('/').at(-1) ?? '', stargazers_count: 42 });
  return json(404, { message: 'Not Found' });
};

describe('make_api, live', () => {
  realModel.it('writes a GET from the operations, sends it with its sample and saves it', async (model) => {
    const kit = await testHub(api, createApiImpl({ settings: apiEnv.parse() }), { config: CONFIG, model, hub: { instance: InstanceName.parse('tracker') }, serve: { fetch: service } });
    try {
      const { result } = await kit.call('make_api', { request: 'The star count of a repository: GET /repos/{owner}/{repo}; args owner and repo (text); give the stargazers_count as a num. acme/web has 42.' }, liveTurn());
      expect(result.fn).toMatch(/^api\/tracker\./);
      expect(kit.hub.fns.kept.get(result.fn)?.saved.routing).toEqual({ to: 'instance', instance: 'tracker' });
    } finally {
      await kit.stop();
    }
  }, 300_000);
});
