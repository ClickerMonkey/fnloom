/**
 * The embedder system's contract: product's EmbeddingGemma-300m service (768 dimensions) as two harness embedders
 * in one vector space. `document` embeds what the hub stores; `query` embeds what it searches for (the service adds
 * EmbeddingGemma's task prefix for each). The service's wire shapes are zod schemas here, so the client and its
 * tests share one source of truth.
 */
import { embedder, g, system } from '@harness/sdk';
import { z } from 'zod';

/** EmbeddingGemma-300m's vector size. */
export const GEMMA_DIMENSIONS = 768;
/** About 2048 tokens of input; the service truncates longer text at a token boundary. */
export const GEMMA_MAX_INPUT = 8_000;

/** The embedder system's contract. */
export const embedderSystem = system('embedder', { description: 'Text embeddings from the local EmbeddingGemma service.' }).with({
  config: g.obj({
    // the service's base URL; when absent, the system's HARNESS_EMBEDDER_URL (default http://127.0.0.1:8760)
    url: g.field(g.optional(g.text({ pattern: '^https?://' })), { docs: 'The EmbeddingGemma service, `http://127.0.0.1:8760`. Leave empty for the system\'s default.' }),
  }),
  embedders: {
    document: embedder({ dimensions: GEMMA_DIMENSIONS, maxInput: GEMMA_MAX_INPUT, pricePerMillionTokens: 0 }),
    query: embedder({ dimensions: GEMMA_DIMENSIONS, maxInput: GEMMA_MAX_INPUT, pricePerMillionTokens: 0 }),
  },
});

/** The embedder contract's type. */
export type EmbedderContract = typeof embedderSystem;

/** The service's task: index passages as `document`, embed search text as `query`. */
export const GemmaTask = z.enum(['document', 'query']);
export type GemmaTask = z.infer<typeof GemmaTask>;

/** `POST /embed` request (see product/services/embedder/README.md). */
export const GemmaEmbedRequest = z.object({
  texts: z.array(z.string()).min(1),
  task: GemmaTask,
  normalize: z.boolean(),
  truncate: z.boolean(),
});
export type GemmaEmbedRequest = z.infer<typeof GemmaEmbedRequest>;

/** `POST /embed` response. Every vector has `dim` numbers. */
export const GemmaEmbedResponse = z.object({
  embeddings: z.array(z.array(z.number())),
  dim: z.number().int(),
  model: z.string(),
  task: GemmaTask,
  truncated_count: z.number().int().min(0),
});
export type GemmaEmbedResponse = z.infer<typeof GemmaEmbedResponse>;

/** `GET /health` response. */
export const GemmaHealth = z.object({ status: z.enum(['ok', 'loading']), model: z.string(), dim: z.number().int() });
export type GemmaHealth = z.infer<typeof GemmaHealth>;

/** `GET /info` response: the parts the client sizes its batches by. */
export const GemmaInfo = z.object({ model: z.string(), dim: z.number().int(), max_batch: z.number().int().min(1) });
export type GemmaInfo = z.infer<typeof GemmaInfo>;
