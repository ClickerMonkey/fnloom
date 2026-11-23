/**
 * The Ollama page's logic: the instances as the hub lists them, offering a model by writing the config back, and how
 * states, sizes and the server's actions read.
 */
import { InstanceName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { OllamaConfig, type OllamaStatus } from '../shared/index.ts';
import { abilities, actionsOf, bytes, instancesOf, offerFor, stateOf, withOffer, type SystemInstances } from './logic.ts';

const STATUS: OllamaStatus = { instance: 'desk', mode: 'managed', state: 'stopped', url: 'http://127.0.0.1:11435', answering: false, restartsLastHour: 0, pulls: [], offered: [], output: [] };

describe('the Ollama page', () => {
  it('lists the instances with their parsed configs, offline ones too', () => {
    const view: SystemInstances = {
      instances: [
        { instance: InstanceName.parse('laptop'), status: 'disconnected', config: { value: { offered: [{ model: 'qwen3' }] } } },
        { instance: InstanceName.parse('desk'), status: 'connected' },
        { instance: InstanceName.parse('box'), status: 'connected', config: { value: { server: { mode: 'nope' } } } },
      ],
    };
    expect(instancesOf(view).map((i) => [i.instance, i.connected, i.config?.offered.length])).toEqual([['box', true, undefined], ['desk', true, undefined], ['laptop', false, 1]]);
    expect(instancesOf(undefined)).toEqual([]);
  });

  it('offers a model with its tag, replaces its offer, and stops offering it', () => {
    const config = OllamaConfig.parse({ offered: [{ model: 'qwen3:8b' }] });
    const offered = withOffer(config, 'llama3.2', { decision: false, contextWindow: 8_192 });
    expect(offered.offered).toEqual([{ model: 'qwen3:8b', decision: false }, { model: 'llama3.2:latest', decision: false, contextWindow: 8_192 }]);
    expect(offerFor(offered, 'llama3.2:latest')?.contextWindow).toBe(8_192);
    expect(withOffer(offered, 'qwen3:8b', undefined).offered.map((o) => o.model)).toEqual(['llama3.2:latest']);
    expect(OllamaConfig.safeParse(offered).success).toBe(true);
  });

  it('reads states, sizes, abilities and what can be done now', () => {
    expect(stateOf('running', true)).toEqual({ label: 'Running', tone: 'ok' });
    expect(stateOf('external', false)).toEqual({ label: 'Not answering', tone: 'danger' });
    expect(stateOf('failed', false).tone).toBe('danger');
    expect([bytes(5_225_000_000), bytes(274_000_000), bytes(1_500), bytes(12)]).toEqual(['5.2 GB', '274 MB', '2 kB', '12 B']);
    expect(abilities({ name: 'q', size: 1, capabilities: ['chat', 'streaming', 'json', 'tools', 'vision'], contextLength: 40_960, servedWindow: 4_096, offered: true })).toBe('tools · vision · 40k context, 4k served');
    expect(actionsOf(STATUS)).toEqual({ install: true, start: false, stop: false });
    expect(actionsOf({ ...STATUS, installed: { version: '0.12.3', binary: '/b', asset: 'a', installedAt: 1 } })).toEqual({ install: true, start: true, stop: false });
    expect(actionsOf({ ...STATUS, state: 'running' })).toEqual({ install: true, start: false, stop: true });
    expect(actionsOf({ ...STATUS, mode: 'url', state: 'external' })).toEqual({ install: false, start: false, stop: false });
    expect(actionsOf(undefined)).toEqual({ install: false, start: false, stop: false });
  });
});
