/**
 * The Ollama system's shapes, zod first: its config (where Ollama runs and which of its models an admin offers), what
 * its fns take and give, and the parts of Ollama's own HTTP API it reads beyond what `@aeye/ollama` covers (pulling,
 * removing and the model list's details). The contract (`index.ts`) turns these into gin types with `ginAs`; the
 * server parses every value with them, which also fills in the defaults.
 */
import { z } from 'zod';

/** The port a managed Ollama listens on when the config names none: not Ollama's own 11434, so one already running there is left alone. */
export const OLLAMA_SYSTEM_PORT = 11_435;

/**
 * A model as Ollama names it: `[host/][namespace/]model[:tag]` (`qwen3:8b`, `library/llama3.2`, `hf.co/org/repo:Q4_K_M`).
 * Letters, digits and `._-` in each part, `/` between parts and one `:tag`; never `..`.
 */
export const OllamaModelName = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/, 'a model name such as qwen3:8b or hf.co/org/repo:Q4_K_M')
  .max(200)
  .refine((name) => !name.includes('..'), 'a model name has no ..');
export type OllamaModelName = z.infer<typeof OllamaModelName>;

/** A model's name with its tag: `qwen3` is `qwen3:latest`, as Ollama lists it. */
export function taggedModel(name: string): string {
  const last = name.slice(name.lastIndexOf('/') + 1);
  return last.includes(':') ? name : `${name}:latest`;
}

/** An Ollama release version, `0.12.3` (a leading `v` is dropped), or `latest`. */
export const OllamaVersion = z.string().regex(/^(?:latest|v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)$/, 'a version such as 0.12.3, or latest').transform((v) => v.replace(/^v/, ''));

/** Settings of an Ollama this instance runs itself (a managed install or an existing binary). */
const RunSettings = {
  /** The port it listens on. */
  port: z.number().int().min(1_024).max(65_535).default(OLLAMA_SYSTEM_PORT),
  /** The address it listens on: this machine only by default; `0.0.0.0` lets other machines reach it. */
  host: z.string().regex(/^[A-Za-z0-9.:[\]-]+$/).default('127.0.0.1'),
  /** Start it when the system starts (and after a config change), once it is installed. */
  autoStart: z.boolean().default(true),
  /** The window Ollama serves a model with when its Modelfile sets no `num_ctx` (Ollama's `OLLAMA_CONTEXT_LENGTH`). */
  contextLength: z.number().int().min(256).max(1_048_576).optional(),
  /** How long a model stays loaded after its last call (`5m`, `1h`, `-1` for always; Ollama's `OLLAMA_KEEP_ALIVE`). */
  keepAlive: z.string().regex(/^-?\d+(?:\.\d+)?[smh]?$/).optional(),
};

/** Where this instance's Ollama is: installed and run in its data folder, an existing binary it runs, or a server someone else runs. */
export const OllamaServerConfig = z.discriminatedUnion('mode', [
  z.object({
    /** Download the official release into the instance's data folder (`ollama/install`) and run it from there. */
    mode: z.literal('managed'),
    /** The release to install: `latest`, or a version such as `0.12.3`. */
    version: OllamaVersion.default('latest'),
    ...RunSettings,
  }),
  z.object({
    /** Run an Ollama already installed on this machine, with its models in the instance's data folder unless `modelsDir` names one. */
    mode: z.literal('binary'),
    /** The `ollama` (or `ollama.exe`) program; absent, the first one `ollama/detect` finds. */
    path: z.string().min(1).optional(),
    /** Where its models are kept (Ollama's `OLLAMA_MODELS`); absent, `models` in the instance's data folder. */
    modelsDir: z.string().min(1).optional(),
    ...RunSettings,
  }),
  z.object({
    /** An Ollama that runs on its own (another machine, a service): this instance lists, pulls and removes its models and offers them, but never starts or stops it. */
    mode: z.literal('url'),
    /** Its address, `http://127.0.0.1:11434`. */
    url: z.string().regex(/^https?:\/\/[^\s/]+\/?$/, 'an http(s) address with no path, such as http://127.0.0.1:11434'),
  }),
]);
export type OllamaServerConfig = z.infer<typeof OllamaServerConfig>;

/** One model an admin offers to the chat, with the limits it is used within. */
export const OfferedModel = z.object({
  /** The model as Ollama names it (`qwen3:8b`); offered only while it is installed. */
  model: OllamaModelName,
  /** The name people see in the model picker; absent, the model's own. */
  label: z.string().min(1).max(80).optional(),
  /** The most context the hub sends it, in tokens (a cap on the window Ollama serves it with, its `num_ctx`). */
  contextWindow: z.number().int().min(256).max(1_048_576).optional(),
  /** The most tokens one answer may have. */
  maxOutput: z.number().int().min(1).optional(),
  /** It answers yes/no decisions (System One) though the server doesn't list `decision` among its abilities. */
  decision: z.boolean().default(false),
});
export type OfferedModel = z.infer<typeof OfferedModel>;

/** The Ollama system's config, per instance. */
export const OllamaConfig = z.object({
  server: OllamaServerConfig.default({ mode: 'managed', version: 'latest', port: OLLAMA_SYSTEM_PORT, host: '127.0.0.1', autoStart: true }),
  /** The installed models people may pick in a chat; the rest stay off the model picker. */
  offered: z.array(OfferedModel).default([]),
}).refine((config) => new Set(config.offered.map((offer) => taggedModel(offer.model))).size === config.offered.length, { message: 'a model is offered twice', path: ['offered'] });
export type OllamaConfig = z.infer<typeof OllamaConfig>;

/** Where the server is in its life. `crashed`: it exited and is restarted after a wait; `failed`: it crashed too often and stays down. */
export const ServerState = z.enum(['stopped', 'starting', 'running', 'stopping', 'crashed', 'failed', 'external']);
export type ServerState = z.infer<typeof ServerState>;

/** The Ollama this instance installed in its data folder. */
export const InstalledOllama = z.object({
  version: z.string(),
  /** The program, absolute. */
  binary: z.string(),
  /** The release file it came from. */
  asset: z.string(),
  /** Its sha-256, checked against the release's before it was unpacked; absent when the release gave none. */
  sha256: z.string().optional(),
  installedAt: z.number().int(),
});
export type InstalledOllama = z.infer<typeof InstalledOllama>;

/** A pull in progress (or just ended) on this instance. */
export const PullProgress = z.object({
  model: z.string(),
  /** Ollama's own words for the step (`pulling manifest`, `verifying sha256 digest`). */
  status: z.string(),
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
  /** 0 to 1; 0 until the size is known. */
  fraction: z.number().min(0).max(1),
  startedAt: z.number().int(),
});
export type PullProgress = z.infer<typeof PullProgress>;

/** What `ollama/status` gives: how this instance's Ollama is. */
export const OllamaStatus = z.object({
  instance: z.string(),
  mode: z.enum(['managed', 'binary', 'url']),
  state: ServerState,
  /** Where it answers. */
  url: z.string(),
  /** The version the server reports, while it answers. */
  version: z.string().optional(),
  /** Whether it answers now. */
  answering: z.boolean(),
  pid: z.number().int().optional(),
  /** When it last started, or stopped (ms). */
  since: z.number().int().optional(),
  restartsLastHour: z.number().int().min(0),
  /** How the last run of it ended. */
  lastExit: z.object({ code: z.number().int().nullable(), signal: z.string().nullable(), at: z.number().int() }).optional(),
  /** What went wrong last (a start that timed out, a port in use). */
  problem: z.string().optional(),
  /** The managed install, when there is one. */
  installed: InstalledOllama.optional(),
  /** The program it runs, for `managed` and `binary`. */
  binary: z.string().optional(),
  /** Where its models are kept, for `managed` and `binary`. */
  modelsDir: z.string().optional(),
  pulls: z.array(PullProgress),
  /** The models offered to the chat now: offered by an admin and installed. */
  offered: z.array(z.string()),
  /** The last lines it printed. */
  output: z.array(z.string()),
});
export type OllamaStatus = z.infer<typeof OllamaStatus>;

/** A model installed on the server, with what it is and can do. */
export const InstalledModel = z.object({
  name: z.string(),
  /** Bytes on disk. */
  size: z.number().int().min(0),
  modifiedAt: z.string().optional(),
  digest: z.string().optional(),
  family: z.string().optional(),
  /** Its parameter count as Ollama writes it (`8.2B`). */
  parameters: z.string().optional(),
  /** Its quantization (`Q4_K_M`). */
  quantization: z.string().optional(),
  format: z.string().optional(),
  /** What it can do, as the hub names abilities: chat, tools, vision, reasoning, embedding, decision. */
  capabilities: z.array(z.string()),
  /** The length it was trained to, in tokens. */
  contextLength: z.number().int().optional(),
  /** The window Ollama serves it with now, in tokens. */
  servedWindow: z.number().int().min(1),
  /** An embedding model's vector size. */
  embeddingLength: z.number().int().optional(),
  /** Whether an admin offers it to the chat. */
  offered: z.boolean(),
});
export type InstalledModel = z.infer<typeof InstalledModel>;

/** What `ollama/models` gives. */
export const ModelList = z.object({ models: z.array(InstalledModel) });
export type ModelList = z.infer<typeof ModelList>;

/** What `ollama/detect` finds on this machine, without running anything. */
export const Detected = z.object({
  /** `ollama` programs on the PATH and in the places installers put them. */
  binaries: z.array(z.object({ path: z.string(), source: z.enum(['path', 'known', 'managed']) })),
  /** Ollama servers that answer on this machine (its default port, and this instance's). */
  servers: z.array(z.object({ url: z.string(), version: z.string() })),
});
export type Detected = z.infer<typeof Detected>;

/** `ollama/install`'s args. */
export const InstallArgs = z.object({
  /** The release: absent, the config's (`latest` unless it names one). */
  version: OllamaVersion.optional(),
  /** Install again even when this version is installed. */
  force: z.boolean().default(false),
});
export type InstallArgs = z.infer<typeof InstallArgs>;

/** `ollama/install`'s result. */
export const InstallResult = z.object({
  version: z.string(),
  binary: z.string(),
  asset: z.string(),
  /** How the download was checked: against the release's sha-256, or not at all (the release gave none). */
  checked: z.enum(['sha256', 'none']),
  /** Already installed: nothing was downloaded. */
  already: z.boolean(),
});
export type InstallResult = z.infer<typeof InstallResult>;

/** Args naming one model. */
export const ModelArgs = z.object({ model: OllamaModelName });
export type ModelArgs = z.infer<typeof ModelArgs>;

/** `ollama/pull`'s result. */
export const PullResult = z.object({ model: z.string(), size: z.number().int().min(0).optional(), offered: z.boolean() });
export type PullResult = z.infer<typeof PullResult>;

/** `ollama/remove`'s result. */
export const RemoveResult = z.object({ model: z.string(), removed: z.boolean() });
export type RemoveResult = z.infer<typeof RemoveResult>;

/** No args. */
export const NoArgs = z.object({});

// ─── Ollama's native API, the parts @aeye/ollama doesn't read ─────────────────────

/** `GET /api/tags`: the installed models with their sizes and details. */
export const TagsResponse = z.object({
  models: z.array(z.object({
    name: z.string(),
    model: z.string().optional(),
    modified_at: z.string().optional(),
    size: z.number().optional(),
    digest: z.string().optional(),
    details: z.object({
      format: z.string().optional(),
      family: z.string().optional(),
      parameter_size: z.string().optional(),
      quantization_level: z.string().optional(),
    }).partial().optional(),
  })),
});
export type TagsResponse = z.infer<typeof TagsResponse>;

/** One line of `POST /api/pull`'s stream. */
export const PullLine = z.union([
  z.object({ error: z.string() }),
  z.object({ status: z.string(), digest: z.string().optional(), total: z.number().optional(), completed: z.number().optional() }),
]);
export type PullLine = z.infer<typeof PullLine>;
