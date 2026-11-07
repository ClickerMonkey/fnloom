/**
 * Ports: the one schema for a TCP port and where each harness process listens unless told otherwise. Every
 * `@ayepi/env` slice that reads a port builds it from these, so a port's rule and default live in one place.
 */
import { z } from 'zod';

/** A TCP port. */
export const Port = z.number().int().min(1).max(65535);

/** Where each process listens by default: the hub (which also serves the built web app), Vite's dev server, the mock hub. */
export const DEFAULT_PORTS = { hub: 4300, web: 4310, mockHub: 4320 } as const satisfies Record<string, z.output<typeof Port>>;

/** The hub's port as an `@ayepi/env` field. Every slice that reads `HARNESS_PORT` spreads this. */
export const HUB_PORT = { HARNESS_PORT: Port.default(DEFAULT_PORTS.hub) } as const;
