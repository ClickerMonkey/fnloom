/**
 * Every fn has at least one example (Phil's examples-enforce decision). A static fn (native, a type method, an agent)
 * carries its author's, or the build and `serve` refuse its contract (`checkExamples`); a fn of any other kind gets its
 * kind's (`KindDescription.examples`). This checks the hub's own contract and every system's shared contract, so a
 * fn added without one fails here before it fails a build.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fnsMissingExamples, hub, isSystemContract, manifestBody } from '@harness/sdk';
import { describe, expect, it } from 'vitest';

const systems = join(import.meta.dirname, '..', 'systems');

/** Every system folder with a shared contract module. */
const folders = readdirSync(systems, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(systems, entry.name, 'shared', 'index.ts')))
  .map((entry) => entry.name);

/** The static fns of a contract that have no example. */
function missing(contract: Parameters<typeof manifestBody>[0]): string[] {
  return fnsMissingExamples(manifestBody(contract, { version: '0.0.0' }).fns);
}

describe('every static fn has an example', () => {
  it('the hub', () => {
    expect(missing(hub)).toEqual([]);
  });

  it.each(folders)('%s', async (folder) => {
    const loaded: unknown = await import(pathToFileURL(join(systems, folder, 'shared', 'index.ts')).href);
    const contracts = typeof loaded === 'object' && loaded !== null ? Object.values(loaded).filter(isSystemContract) : [];
    expect(contracts.length).toBeGreaterThan(0);
    for (const contract of contracts) { expect({ system: contract.name, missing: missing(contract) }).toEqual({ system: contract.name, missing: [] }); }
  });
});
