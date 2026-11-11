/**
 * Prints the manifest a built system's contract declares, as JSON on stdout: `tsx server/manifest-probe.ts <contract
 * module> <name> <version> [client folder]`. Its hash is what the install subject binds the pairing grant to. It is the
 * contract's manifest with the built client: what an implementation adds by running (events it handles, resources, a
 * context folder, runtime patches) isn't in it, so a system with those won't match its hello until the SDK can say the
 * hash of a built bundle itself. It runs in a child process for every build, so a changed contract is never read from
 * the module cache of an earlier one and its code never runs inside fs. It loads only the contract (`shared/`), as the
 * build's own contract check does; no server code runs before an admin approves.
 */
import { pathToFileURL } from 'node:url';
import { isSystemContract, manifestOf } from '@harness/sdk';
import { readClientBundle } from '@harness/sdk/server';

const [module, name, version, client] = process.argv.slice(2);
if (module === undefined || name === undefined || version === undefined) { throw new Error('usage: manifest-probe <contract module> <name> <version> [client folder]'); }
const loaded: unknown = await import(pathToFileURL(module).href);
const exported: unknown[] = typeof loaded === 'object' && loaded !== null ? Object.values(loaded) : [];
const contract = exported.find((value) => isSystemContract(value) && value.name === name);
if (contract === undefined || !isSystemContract(contract)) { throw new Error(`${module} exports no contract named ${name}`); }
const assets = client === undefined || client === '' ? undefined : (await readClientBundle(client)).assets;
const manifest = await manifestOf(contract, { version, ...(assets === undefined ? {} : { client: assets }) });
process.stdout.write(JSON.stringify(manifest));
