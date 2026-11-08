#!/usr/bin/env node
/** The `harness` binary: runs the command its arguments name and exits with its code. */
import { runCli } from './cli.ts';
import { nodeIo } from './io.ts';

process.exitCode = await runCli(process.argv.slice(2), nodeIo(process.cwd(), process.env));
