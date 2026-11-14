/**
 * Preloaded (`--require`, `NETWORK_GUARD` in `proxy.ts`) in each supervised system's process (fs's `SupervisedRunner` and
 * the hub's `ProcessSupervisor`): its sockets reach only the endpoints the supervisor names in `NETWORK_ALLOW_VAR` (its
 * allowlist proxy and the hub), so `grants.network` holds for raw sockets
 * and clients with agents of their own too, not only for what honours `HTTP(S)_PROXY`. A refused attempt throws and,
 * unless it is a local pipe (which `grants.network` can't name; tsx itself tries its parent's on start), prints a
 * `networkRefusedLine`, which the supervisor reports to the hub. With the variable missing nothing is allowed.
 */
import { NETWORK_ALLOW_VAR, guardNetwork, networkRefusedLine, parseEndpoints } from './socket-guard.ts';

const write = process.stderr.write.bind(process.stderr);
guardNetwork({
  allow: parseEndpoints(process.env[NETWORK_ALLOW_VAR]),
  refused: (target, kind) => {
    if (kind !== 'pipe') { write(`${networkRefusedLine(target)}\n`); }
    return `${target} is not in this system's grants.network`;
  },
});
