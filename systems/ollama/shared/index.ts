/**
 * The Ollama system's contract: one instance per machine or server. Each instance runs an Ollama (installed in its
 * data folder from the official release, an existing program, or a server someone else runs), lists, pulls and
 * removes its models, and offers the models an admin chose (`offered` in its config) as an aeye provider named after
 * the instance (`ollama/desk`), so people pick them in a chat's model picker like any provider's. Its fns are for
 * admins; installing, starting, stopping, pulling and removing wait for an admin's approval. The admin page
 * (`/s/ollama/servers`) shows every instance's server and models, offers and pulls.
 *
 * The provider is `@aeye/ollama` pointed at the instance's server (`server/provider.ts`); the hub's own Ollama provider
 * type stays for a server an admin only points the hub at.
 */
import { fn, ginAs, linear, provider, system, type ConfigOf } from '@harness/sdk';
import type { z } from 'zod';
import {
  Detected, InstallArgs, InstallResult, ModelArgs, ModelList, NoArgs, OllamaConfig, OllamaStatus, PullResult, RemoveResult,
} from './schemas.ts';

export * from './schemas.ts';

/** The system's name. */
export const OLLAMA_SYSTEM = 'ollama';

/** Its admin page (`/s/ollama/servers`). */
export const OLLAMA_PAGE = 'servers';

/** Status words that are the same for one run and many. */
const status = (active: string, done: string, failed: string) => ({
  active: { one: active, many: active },
  retry: { one: `${active} (again)`, many: `${active} (again)` },
  done: { one: done, many: done },
  failed: { one: failed, many: failed },
});

/** An example of the status a fn gives. */
const STATUS_EXAMPLE: z.input<typeof OllamaStatus> = {
  instance: 'desk', mode: 'managed', state: 'running', url: 'http://127.0.0.1:11435', version: '0.12.3', answering: true, pid: 4120, since: 1_763_900_000_000,
  restartsLastHour: 0, pulls: [], offered: ['qwen3:8b'], output: ['Listening on 127.0.0.1:11435 (version 0.12.3)'],
};

/** The Ollama system's contract. */
export const ollama = system(OLLAMA_SYSTEM, {
  description: 'Runs Ollama on a machine: installs and starts it, pulls and removes its models, and offers the ones an admin chose to the chat.',
  about: 'Runs Ollama, a server for local models, on each machine it is installed on (one instance per machine or server). Admins use its fns to see the server, install and start it, and pull, list and remove models; the models an admin offers show up as a model provider named after the instance, picked in a chat\'s model picker. Its fns are for admins only, and every change waits for an admin\'s approval. Reach for it when an admin asks about local models.',
  grants: { hub: [] },
  groups: [
    { name: 'server', title: 'Server', description: 'The Ollama server on this instance: its status, finding an installed one, installing, starting and stopping it.' },
    { name: 'models', title: 'Models', description: 'The models on this instance\'s Ollama: listing, pulling and removing them.' },
  ],
  pages: [
    { segment: OLLAMA_PAGE, title: 'Ollama', description: 'Every Ollama server: its status, installed models, which are offered to the chat, and pulls.', icon: 'server', nav: 'main', access: 'admin', component: 'ServersPage' },
  ],
})
  .with({
    config: ginAs(OllamaConfig),
    providers: {
      server: provider({ description: 'The models an admin offers from this instance\'s Ollama, local and free.', models: 'runtime' }),
    },
    fns: {
      status: fn({
        group: 'server',
        description: 'How this instance\'s Ollama is: running or not, its address and version, restarts, pulls in progress, the models offered to the chat and its last output.',
        instructions: 'Read it before starting, stopping or installing, and after a pull or a crash. `state` is `external` for a server this instance only talks to.',
        args: ginAs(NoArgs),
        returns: ginAs(OllamaStatus),
        examples: [{ args: {}, result: STATUS_EXAMPLE }],
        effects: { mode: 'read', free: true },
        tags: ['admin', 'read'],
        status: status('Checking Ollama…', 'Checked Ollama', 'Checking Ollama failed'),
      }),
      detect: fn({
        group: 'server',
        description: 'Find Ollama on this machine without running it: programs on the PATH and where installers put them, and servers that answer.',
        instructions: 'Use it before choosing the config\'s `binary` mode (it names the program) or `url` mode (it names a server that already answers).',
        args: ginAs(NoArgs),
        returns: ginAs(Detected),
        examples: [{ args: {}, result: { binaries: [{ path: 'C:/Users/me/AppData/Local/Programs/Ollama/ollama.exe', source: 'known' }], servers: [{ url: 'http://127.0.0.1:11434', version: '0.12.3' }] } }],
        effects: { mode: 'read', free: true },
        tags: ['admin', 'read'],
        status: status('Looking for Ollama…', 'Looked for Ollama', 'Looking for Ollama failed'),
      }),
      install: fn({
        group: 'server',
        description: 'Download the official Ollama release for this machine into the instance\'s data folder, check its sha-256 and unpack it. Nothing is installed system-wide.',
        instructions: 'Only for the config\'s `managed` mode. Leave `version` out for the config\'s (latest unless it names one). An admin approves it first; then start it with ollama/start.',
        args: ginAs(InstallArgs),
        returns: ginAs(InstallResult),
        examples: [
          { args: {}, note: 'The config\'s version, usually the latest.' },
          { args: { version: '0.12.3' }, result: { version: '0.12.3', binary: '/data/ollama/0.12.3/bin/ollama', asset: 'ollama-linux-amd64.tgz', checked: 'sha256', already: false } },
        ],
        progress: linear,
        approval: { preview: true, remember: false, approver: 'admins' },
        effects: { mode: 'write', free: true },
        operations: { background: true },
        tags: ['admin'],
        status: status('Installing Ollama…', 'Installed Ollama', 'Installing Ollama failed'),
      }),
      start: fn({
        group: 'server',
        description: 'Start this instance\'s Ollama (`ollama serve` on its port, its models in the instance\'s data folder) and wait until it answers.',
        instructions: 'For the `managed` and `binary` modes. A crashed server is restarted on its own; use this after ollama/stop or a failure.',
        args: ginAs(NoArgs),
        returns: ginAs(OllamaStatus),
        examples: [{ args: {}, result: STATUS_EXAMPLE }],
        approval: { preview: true, remember: false, approver: 'admins' },
        effects: { mode: 'write', free: true },
        tags: ['admin'],
        status: status('Starting Ollama…', 'Started Ollama', 'Starting Ollama failed'),
      }),
      stop: fn({
        group: 'server',
        description: 'Stop this instance\'s Ollama. Chats using its models get no answers until it starts again.',
        instructions: 'For the `managed` and `binary` modes. It stays stopped (no restart) until ollama/start or the system starts again with `autoStart`.',
        args: ginAs(NoArgs),
        returns: ginAs(OllamaStatus),
        examples: [{ args: {}, result: { ...STATUS_EXAMPLE, state: 'stopped', answering: false } }],
        approval: { preview: true, remember: false, approver: 'admins' },
        effects: { mode: 'write', free: true },
        tags: ['admin'],
        status: status('Stopping Ollama…', 'Stopped Ollama', 'Stopping Ollama failed'),
      }),
      models: fn({
        group: 'models',
        description: 'The models installed on this instance\'s Ollama: size, family, parameters, quantization, abilities (tools, vision, embedding), context length and whether each is offered to the chat.',
        instructions: 'The server must be answering (see ollama/status).',
        args: ginAs(NoArgs),
        returns: ginAs(ModelList),
        examples: [{
          args: {},
          result: { models: [{ name: 'qwen3:8b', size: 5_225_000_000, family: 'qwen3', parameters: '8.2B', quantization: 'Q4_K_M', capabilities: ['chat', 'tools', 'reasoning'], contextLength: 40_960, servedWindow: 4_096, offered: true }] },
        }],
        effects: { mode: 'read', free: true },
        tags: ['admin', 'read'],
        status: status('Listing models…', 'Listed models', 'Listing models failed'),
      }),
      pull: fn({
        group: 'models',
        description: 'Download a model to this instance\'s Ollama by its name and tag (`qwen3:8b`), with progress. Models are large: often several gigabytes.',
        instructions: 'Name it as Ollama does (`model:tag`; no tag means `latest`). An admin approves it first. Pulling does not offer it: an admin offers it in the config (`offered`) or on the Ollama page.',
        args: ginAs(ModelArgs),
        returns: ginAs(PullResult),
        examples: [
          { args: { model: 'qwen3:8b' }, result: { model: 'qwen3:8b', size: 5_225_000_000, offered: false } },
          { args: { model: 'nomic-embed-text' }, note: 'No tag: the latest.' },
        ],
        progress: linear,
        approval: { preview: true, remember: false, approver: 'admins' },
        effects: { mode: 'write', free: true },
        operations: { background: true },
        tags: ['admin'],
        status: { ...status('Pulling a model…', 'Pulled a model', 'Pulling a model failed'), active: { one: 'Pulling {args.model}…', many: 'Pulling {n} models…' }, done: { one: 'Pulled {args.model}', many: 'Pulled {n} models' } },
      }),
      remove: fn({
        group: 'models',
        description: 'Remove a model from this instance\'s Ollama, freeing its disk space. It leaves the chat\'s model picker at once; pull it again to get it back.',
        instructions: 'An admin approves it first. Its offer stays in the config and comes back if the model is pulled again.',
        args: ginAs(ModelArgs),
        returns: ginAs(RemoveResult),
        examples: [{ args: { model: 'qwen3:8b' }, result: { model: 'qwen3:8b', removed: true } }],
        approval: { preview: true, remember: false, approver: 'admins' },
        effects: { mode: 'delete', free: true },
        tags: ['admin'],
        status: { ...status('Removing a model…', 'Removed a model', 'Removing a model failed'), active: { one: 'Removing {args.model}…', many: 'Removing {n} models…' }, done: { one: 'Removed {args.model}', many: 'Removed {n} models' } },
      }),
    },
  });

/** The Ollama contract's type. */
export type OllamaContract = typeof ollama;

/** The config as the hub holds it (the input side: defaults not filled in); parse with `OllamaConfig` to read it. */
export type OllamaConfigInput = ConfigOf<OllamaContract['defs']>;

/** The fns by qualified name, for the page's runs. */
export const OLLAMA_FNS = {
  status: `${OLLAMA_SYSTEM}/status`, detect: `${OLLAMA_SYSTEM}/detect`, install: `${OLLAMA_SYSTEM}/install`, start: `${OLLAMA_SYSTEM}/start`,
  stop: `${OLLAMA_SYSTEM}/stop`, models: `${OLLAMA_SYSTEM}/models`, pull: `${OLLAMA_SYSTEM}/pull`, remove: `${OLLAMA_SYSTEM}/remove`,
} as const;
