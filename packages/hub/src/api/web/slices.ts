/**
 * `hubWebSpec` cut into the slices the web API plugins serve. Each slice is a real ayepi spec over the very endpoint
 * objects of `hubWebSpec`, so the served API is the spec itself. `Covered` proves at compile time that the slices
 * cover every endpoint exactly once: an endpoint added to the spec and not to a slice, or put in two, doesn't compile.
 */
import { spec } from '@ayepi/core';
import { hubWebSpec, type HubWebSpec } from '@harness/core';
import { expectType, type Equal } from '@harness/sdk';

type Endpoints = HubWebSpec['endpoints'];
type EndpointName = Extract<keyof Endpoints, string>;

/** The endpoints of `hubWebSpec` with these names. */
function pick<const K extends readonly EndpointName[]>(names: K): Pick<Endpoints, K[number]> {
  const picked = Object.fromEntries(names.map((name) => [name, hubWebSpec.endpoints[name]]));
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every name in `names` was copied from `hubWebSpec.endpoints` above
  return picked as Pick<Endpoints, K[number]>;
}

/** Sign-in and who is signed in. */
export const authSlice = spec({ endpoints: pick(['setup', 'createAdmin', 'signIn', 'refresh', 'signOut', 'me']) });
/** Sessions, messages, turns and what the composer may offer. */
export const chatSlice = spec({
  endpoints: pick(['capabilities', 'sessions', 'session', 'createSession', 'updateSession', 'limits', 'messages', 'send', 'invoke', 'control', 'presence']),
});
/** Runs: their tree, inspectors, approvals, handler answers, actions, forms and state. */
export const runsSlice = spec({ endpoints: pick(['background', 'undoTurn', 'tree', 'run', 'llmCall', 'waiting', 'approve', 'answer', 'act', 'submit', 'state']) });
/** Finding things: suggestions, search, mentions and resources. */
export const findSlice = spec({ endpoints: pick(['suggest', 'search', 'mentions', 'mentionHover', 'resource']) });
/** The inbox and web push. */
export const inboxSlice = spec({ endpoints: pick(['notifications', 'readNotifications', 'pushKey', 'subscribePush']) });
/** Uploads and transcription. */
export const contentSlice = spec({ endpoints: pick(['upload', 'uploaded', 'transcribe']) });
/** Systems and pairing. */
export const systemsSlice = spec({
  endpoints: pick([
    'systems', 'system', 'pairings', 'approvePairing', 'createPairingToken', 'configureSystem', 'enableSystem', 'removeSystem', 'installSystem', 'startSystem',
    'stopSystem', 'upgradeSystem', 'reimport',
  ]),
});
/** Providers, models, budgets, priorities, policies, settings, users and groups. */
export const settingsSlice = spec({
  endpoints: pick(['configureProvider', 'providers', 'setModelCategory', 'setBudget', 'setPriority', 'setPolicy', 'setActorSetting', 'addUser', 'addGroup']),
});
/** The admin pages' reads, and the output of systems as it arrives. */
export const adminSlice = spec({
  endpoints: pick([
    'systemFns', 'systemLogs', 'models', 'modelCategories', 'budgets', 'priorityRules', 'resolveLimits', 'policies', 'actors', 'actorSettings', 'runs', 'llmCalls',
    'resources', 'removeRule',
  ]),
  events: { systemLog: hubWebSpec.events.systemLog },
});
/** The realtime events (no endpoints). */
export const eventsSlice = spec({ endpoints: {}, events: { session: hubWebSpec.events.session, user: hubWebSpec.events.user } });

/** Every slice, as a type. */
type Slices = [
  typeof authSlice, typeof chatSlice, typeof runsSlice, typeof findSlice, typeof inboxSlice, typeof contentSlice, typeof systemsSlice, typeof settingsSlice,
  typeof adminSlice, typeof eventsSlice,
];

/** The endpoint names of a slice. */
type NamesOf<S> = S extends { readonly endpoints: infer E } ? keyof E & string : never;
type SliceNames = { [I in keyof Slices]: NamesOf<Slices[I]> };
type Covered = SliceNames[number];
/** Endpoints in more than one slice: the names two different slices share. */
type Index = keyof SliceNames & `${number}`;
type Twice = { [I in Index]: { [J in Index]: J extends I ? never : SliceNames[I] & SliceNames[J] }[Index] }[Index];

expectType<Equal<Covered, EndpointName>>(true);
expectType<Equal<Twice, never>>(true);
