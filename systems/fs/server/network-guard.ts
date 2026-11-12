/**
 * Loaded first (`--import`) in each process that runs an unapproved folder's test files (`ProcessSystemTests`). Node
 * 22's permission model limits the disk, child processes, workers and addons but not the network, so this shuts the
 * ways out to it: TCP and TLS sockets (net, tls, http, https, http2, fetch and WebSocket all connect through
 * `net.Socket`), servers, UDP and DNS. Each replacement is fixed in place (neither writable nor configurable) and the
 * originals are not kept anywhere, so the tests can't put them back; the permission model already denies
 * `process.binding`, the way around these modules.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

/** Why a network call fails here. */
export const NETWORK_OFF = 'The network is off while the tests of a system no admin has approved run.';

/** Replace `target[name]` for good with a function that throws `NETWORK_OFF`. */
function seal(target: object, name: string): void {
  Object.defineProperty(target, name, {
    value: () => { throw new Error(NETWORK_OFF); },
    writable: false, configurable: false, enumerable: false,
  });
}

/** The names on `target` that look up or resolve names (`lookup`, `lookupService`, `resolve*`, `reverse`). */
function dnsCalls(target: object): string[] {
  return Object.getOwnPropertyNames(target).filter((name) => /^(lookup|resolve|reverse)/.test(name));
}

seal(net.Socket.prototype, 'connect');
seal(net.Server.prototype, 'listen');
for (const name of ['bind', 'connect', 'send'] as const) { seal(dgram.Socket.prototype, name); }
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const name of dnsCalls(target)) { seal(target, name); }
}
// `import { lookup } from 'node:dns'` reads the module's ESM view, which follows these changes only once synced
syncBuiltinESMExports();
