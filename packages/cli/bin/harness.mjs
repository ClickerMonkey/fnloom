#!/usr/bin/env node
/**
 * The `harness` binary. It starts the CLI under tsx, as the hub and systems run: the CLI loads systems' TypeScript
 * (their contracts, when building) and aeye's dist, which plain Node can't load. In the published package it first
 * makes sure `node_modules/@harness/*` link to the package's own folders (`scripts/release/link.cjs`; nothing to do in
 * the repository, where npm workspaces make them).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const links = fileURLToPath(new URL('../../../scripts/release/link.cjs', import.meta.url));
if (existsSync(links)) { createRequire(import.meta.url)(links).ensureLinks(); }

const { register } = await import('tsx/esm/api');
register();
await import('../src/main.ts');
