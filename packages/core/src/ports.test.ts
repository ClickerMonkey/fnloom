import { describe, expect, it } from 'vitest';
import { DEFAULT_PORTS, HUB_PORT, Port } from './ports.ts';

describe('ports', () => {
  it('accepts a TCP port and refuses anything else', () => {
    expect(Port.parse(4300)).toBe(4300);
    for (const bad of [0, 65536, 4300.5, -1]) { expect(Port.safeParse(bad).success).toBe(false); }
  });

  it('gives every default port a distinct, valid number', () => {
    const ports = Object.values(DEFAULT_PORTS);
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) { expect(Port.safeParse(port).success).toBe(true); }
  });

  it('makes HARNESS_PORT a port defaulting to the hub port', () => {
    expect(HUB_PORT.HARNESS_PORT.parse(undefined)).toBe(DEFAULT_PORTS.hub);
    expect(HUB_PORT.HARNESS_PORT.parse(4777)).toBe(4777);
    expect(HUB_PORT.HARNESS_PORT.safeParse(70_000).success).toBe(false);
  });
});
