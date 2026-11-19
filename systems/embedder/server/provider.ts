/**
 * EmbeddingGemma as an aeye provider: the `gemma` provider the contract declares, whose two embedding models are the
 * service's tasks (`document`, `query`). The SDK serves the hub's `providerEmbed` and `providerModels` calls with it;
 * it lists its models only while the service answers with EmbeddingGemma's size, so the hub sees what is served now.
 */
import type { ProviderImpl } from '@harness/sdk';
import { GEMMA_DIMENSIONS, GEMMA_WINDOW, GemmaTask } from '../shared/index.ts';
import type { GemmaClient } from './index.ts';

/** The aeye provider a system's provider implementation makes (the SDK's `ProviderImpl`). */
type AeyeProvider = ReturnType<ProviderImpl>;
type EmbedRequest = Parameters<NonNullable<AeyeProvider['embed']>>[0];
type EmbedResponse = Awaited<ReturnType<NonNullable<AeyeProvider['embed']>>>;
type ModelList = Awaited<ReturnType<NonNullable<AeyeProvider['listModels']>>>;

/** How the provider embeds a task's texts (the client, with the query cache in front for queries). */
export type TaskEmbed = (texts: string[], task: GemmaTask) => Promise<number[][]>;

/** The task a model id names. */
function taskOf(model: EmbedRequest['model']): GemmaTask {
  const id = typeof model === 'string' ? model : model?.id;
  const task = GemmaTask.safeParse(id);
  if (!task.success) { throw new Error(`EmbeddingGemma has no model ${id ?? '(none)'}: use document or query.`); }
  return task.data;
}

/** EmbeddingGemma's service as an aeye provider. */
export class GemmaProvider implements AeyeProvider {
  readonly name = 'gemma';
  readonly config = {};
  readonly #client: GemmaClient;
  readonly #embed: TaskEmbed;

  constructor(client: GemmaClient, embed: TaskEmbed) {
    this.#client = client;
    this.#embed = embed;
  }

  checkHealth(): Promise<boolean> {
    return this.#client.health().then((health) => health.status === 'ok', () => false);
  }

  /** Both models while the service answers with EmbeddingGemma's size; none while it serves another. */
  async listModels(): Promise<ModelList> {
    const health = await this.#client.health();
    if (health.dim !== GEMMA_DIMENSIONS) { return []; }
    return GemmaTask.options.map((task) => ({
      id: task, provider: this.name, name: `EmbeddingGemma (${task}s)`, capabilities: new Set(['embedding' as const]), tier: 'efficient' as const,
      contextWindow: GEMMA_WINDOW, pricing: {},
    }));
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const task = taskOf(request.model);
    const texts = request.texts;
    if (texts === undefined) { throw new Error('EmbeddingGemma embeds text only.'); }
    const vectors = await this.#embed([...texts], task);
    return { embeddings: vectors.map((embedding, index) => ({ embedding, index })), model: task };
  }
}
