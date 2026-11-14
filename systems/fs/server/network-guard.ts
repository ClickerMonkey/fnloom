/**
 * Loaded first (`--import`) in each process that runs an unapproved folder's test files (`ProcessSystemTests`): shuts
 * the network entirely (`guardNetwork` with nothing allowed: no sockets, servers, UDP or name lookups).
 */
import { guardNetwork } from '@harness/sdk/server/socket-guard';

/** Why a network call fails here. */
export const NETWORK_OFF = 'The network is off while the tests of a system no admin has approved run.';

guardNetwork({ allow: [], refused: () => NETWORK_OFF });
