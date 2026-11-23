/**
 * The provider each instance offers: `@aeye/ollama`'s `OllamaProvider` pointed at the instance's server, so chat,
 * embeddings and System One decisions are Ollama's own client. Its live model list is the server's, narrowed to the
 * offered models with the offer's window and answer caps, so the hub never sends a model more than an admin allowed
 * (the hub keeps only the declared models of it besides).
 */
import type { ModelInfo } from '@aeye/ai';
import { OllamaProvider, type OllamaOptions } from '@aeye/ollama';
import type { OfferedModel } from '../shared/index.ts';
import { offerOf } from './models.ts';

/** What the provider is made from: the server's address and window, and the offers now. */
export interface OfferedProviderOptions extends Pick<OllamaOptions, 'baseURL' | 'contextWindow' | 'maxContextWindow' | 'keepAlive' | 'fetch'> {
  readonly offered: readonly OfferedModel[];
}

/** Ollama's provider, listing only what an admin offers, within the offer's limits. */
export class OfferedOllamaProvider extends OllamaProvider {
  readonly #offered: readonly OfferedModel[];

  constructor(options: OfferedProviderOptions) {
    const { offered, ...rest } = options;
    const decisionModels = offered.filter((offer) => offer.decision).map((offer) => offer.model);
    super({ ...rest, ...(decisionModels.length === 0 ? {} : { decisionModels }) });
    this.#offered = offered;
  }

  /** The server's models that are offered, each within its offer's window and answer limit. */
  override async listModels(config?: Parameters<OllamaProvider['listModels']>[0]): Promise<ModelInfo[]> {
    const live = await super.listModels(config);
    return live.flatMap((model) => {
      const offer = offerOf(this.#offered, model.id);
      if (offer === undefined) { return []; }
      return [{
        ...model,
        ...(offer.label === undefined ? {} : { name: offer.label }),
        contextWindow: Math.min(offer.contextWindow ?? model.contextWindow, model.contextWindow),
        ...(offer.maxOutput === undefined ? {} : { maxOutputTokens: Math.min(offer.maxOutput, model.maxOutputTokens ?? offer.maxOutput) }),
      }];
    });
  }
}
