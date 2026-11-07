/**
 * The web app's dev-server settings, read by `vite.config.ts`: the hub port it proxies to (the hub's own
 * `HARNESS_PORT` field) and the port Vite serves on.
 */
import { env } from '@ayepi/env';
import { DEFAULT_PORTS, HUB_PORT, Port } from '@harness/core';

/** Vite's ports. */
export const webEnv = env({
  ...HUB_PORT,
  HARNESS_WEB_PORT: Port.default(DEFAULT_PORTS.web),
});
