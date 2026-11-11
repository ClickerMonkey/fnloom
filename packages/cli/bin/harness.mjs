#!/usr/bin/env node
/**
 * The `harness` binary. It starts the CLI under tsx, as the hub and systems run: the CLI loads systems' TypeScript
 * (their contracts, when building) and aeye's dist, which plain Node can't load.
 */
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
