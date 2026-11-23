/**
 * The models on a server and the ones the provider declares. Installed models are read from the server (`/api/tags`
 * for sizes and details, `/api/show` for abilities and windows), with `@aeye/ollama`'s own readings of what a model can
 * do (`capabilitiesOf`) and the window it is served with (`servedWindow`), so the list and the provider never disagree.
 * The provider declares only what an admin offered **and** the server has: `declaredModels`.
 */
import { capabilitiesOf, OLLAMA_SYSTEM_ONE_LIMITS, servedWindow, trainedLengthOf, unsetWindow, type OllamaShow } from '@aeye/ollama';
import type { ProviderModelDecl } from '@harness/core';
import { taggedModel, type InstalledModel, type OfferedModel } from '../shared/index.ts';
import type { OllamaServerApi } from './api.ts';

/** The abilities the hub reads from a declared model, in a stable order. */
const ABILITY_ORDER = ['chat', 'streaming', 'json', 'tools', 'vision', 'reasoning', 'embedding', 'decision'] as const;

/** The vector size an embedding model gives (`<architecture>.embedding_length`). */
export function embeddingLengthOf(show: OllamaShow): number | undefined {
  for (const [key, value] of Object.entries(show.model_info ?? {})) {
    if (key.endsWith('.embedding_length') && typeof value === 'number' && Number.isInteger(value) && value > 0) { return value; }
  }
  return undefined;
}

/** The offer for a model, matching `qwen3` with `qwen3:latest`. */
export function offerOf(offered: readonly OfferedModel[], model: string): OfferedModel | undefined {
  const tagged = taggedModel(model);
  return offered.find((offer) => taggedModel(offer.model) === tagged);
}

/** What reading the server's models needs. */
export interface ModelReading {
  readonly api: OllamaServerApi;
  readonly offered: readonly OfferedModel[];
  /** The server's `OLLAMA_CONTEXT_LENGTH`, when this instance sets it. */
  readonly contextLength: number | undefined;
  /** The most window assumed when nothing sets one. */
  readonly maxContext: number;
}

/** Every model the server has, with what it is and can do, in the server's order. */
export async function installedModels(reading: ModelReading): Promise<InstalledModel[]> {
  const { api, offered } = reading;
  const [tags, version] = await Promise.all([api.tags(), api.version()]);
  const unset = unsetWindow(version, reading.contextLength, reading.maxContext);
  const decisions = offered.filter((offer) => offer.decision).map((offer) => taggedModel(offer.model));
  return Promise.all(tags.models.map(async (tag): Promise<InstalledModel> => {
    const show = await api.show(tag.name);
    const capabilities = capabilitiesOf(tag.name, show, decisions);
    const trained = trainedLengthOf(show);
    const embeddingLength = embeddingLengthOf(show);
    const details = tag.details ?? {};
    return {
      name: tag.name,
      size: Math.max(0, Math.floor(tag.size ?? 0)),
      ...(tag.modified_at === undefined ? {} : { modifiedAt: tag.modified_at }),
      ...(tag.digest === undefined ? {} : { digest: tag.digest }),
      ...(details.family === undefined ? {} : { family: details.family }),
      ...(details.parameter_size === undefined ? {} : { parameters: details.parameter_size }),
      ...(details.quantization_level === undefined ? {} : { quantization: details.quantization_level }),
      ...(details.format === undefined ? {} : { format: details.format }),
      capabilities: ABILITY_ORDER.filter((ability) => capabilities.has(ability)),
      ...(trained === undefined ? {} : { contextLength: trained }),
      servedWindow: Math.max(1, servedWindow(show, unset)),
      ...(embeddingLength === undefined ? {} : { embeddingLength }),
      offered: offerOf(offered, tag.name) !== undefined,
    };
  }));
}

/**
 * The provider's models: the offered ones the server has, each free, with the abilities the server reports, the
 * window it serves capped by the offer's, and an embedding model's vector size (one whose size isn't known is offered
 * without embedding). A decision model carries System One's limits.
 */
export function declaredModels(installed: readonly InstalledModel[], offered: readonly OfferedModel[]): ProviderModelDecl[] {
  return installed.flatMap((model): ProviderModelDecl[] => {
    const offer = offerOf(offered, model.name);
    if (offer === undefined) { return []; }
    const capabilities = model.capabilities.filter((ability) => ability !== 'embedding' || model.embeddingLength !== undefined);
    if (capabilities.length === 0) { return []; }
    const decides = capabilities.includes('decision');
    return [{
      id: model.name,
      name: offer.label ?? model.name,
      capabilities,
      contextWindow: Math.min(offer.contextWindow ?? model.servedWindow, model.servedWindow),
      ...(offer.maxOutput === undefined ? {} : { maxOutput: offer.maxOutput }),
      pricing: { input: 0, output: 0 },
      caching: false,
      ...(capabilities.includes('embedding') && model.embeddingLength !== undefined ? { dimensions: model.embeddingLength } : {}),
      ...(decides ? { maxQuestions: OLLAMA_SYSTEM_ONE_LIMITS.maxQuestions, maxRequestBytes: OLLAMA_SYSTEM_ONE_LIMITS.maxRequestBytes } : {}),
    }];
  });
}
