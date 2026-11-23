/**
 * Model providers: ones a system brings, and the AWS Bedrock provider's config.
 *
 * A system declares aeye providers in its manifest (`providers`); the provider code runs in the system. The hub
 * registers each as a remote aeye provider named `<system>/<provider>`, so picking one of its models routes chat,
 * embedding and decision calls over the link (`providerChat`, `providerEmbed`, `providerDecide`), recorded as
 * `ModelCall`s like any other. The declared models are the set an admin reviewed: the hub asks the provider which of
 * them it serves now (`providerModels`, its aeye `listModels`) and offers only those, priced as declared.
 *
 * Embedders are such providers: a declared model with the `embedding` capability (text) or `imageEmbedding` (images),
 * and its `dimensions`, is an embedder the index can use, named by its system and model id (`embedder/document`). A
 * model with `crossModalEmbedding` puts text and images in one vector space, so it can serve both.
 */
import { z } from 'zod';
import { DecisionAnswers, DecisionInput, DecisionQuestions } from './decisions.ts';
import { LlmChunk, LlmRequest, LlmUsage } from './llm.ts';
import { InstanceName, LocalName, RunId, Usd } from './primitives.ts';

/** The capabilities of a model that embeds: text (`embedding`) or images (`imageEmbedding`). */
export const EMBEDDING_CAPABILITIES = ['embedding', 'imageEmbedding'] as const;

/** Prices in USD per million tokens. `cached`: reading the prompt cache; `cacheWrite`: writing it, where billed. */
export const TokenPricing = z.object({ input: Usd, output: Usd, cached: Usd.optional(), cacheWrite: Usd.optional() });
export type TokenPricing = z.infer<typeof TokenPricing>;

/**
 * One model a system's provider serves. `capabilities` are aeye `ModelCapability` names (`chat`, `tools`, `vision`,
 * `json`, `embedding`, `imageEmbedding`, `crossModalEmbedding`, `decision`, ...); the hub keeps only those aeye knows.
 * `caching`: whether the model reads a prompt cache. An embedding model (of text or images) gives its vectors'
 * `dimensions` and the most characters it reads (`maxInput`); a
 * decision model the most questions it answers in one call (`maxQuestions`) and the most bytes of input and questions
 * (`maxRequestBytes`), which every caller splits by.
 */
export const ProviderModelDecl = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  capabilities: z.array(z.string()),
  contextWindow: z.number().int().min(1),
  maxOutput: z.number().int().min(1).optional(),
  pricing: TokenPricing,
  caching: z.boolean(),
  dimensions: z.number().int().min(1).optional(),
  maxInput: z.number().int().min(1).optional(),
  maxQuestions: z.number().int().min(1).optional(),
  maxRequestBytes: z.number().int().min(1).optional(),
}).refine((model) => !EMBEDDING_CAPABILITIES.some((capability) => model.capabilities.includes(capability)) || model.dimensions !== undefined, {
  message: 'An embedding model says how many dimensions its vectors have.', path: ['dimensions'],
});
export type ProviderModelDecl = z.infer<typeof ProviderModelDecl>;

/**
 * A provider a system declares (manifest `providers`). A **runtime** provider (`runtime: true`, the SDK's
 * `provider({ models: 'runtime' })`) has its models set while the system runs (`RunningSystem.models`), from what an
 * admin chose (the Ollama system's offered models); one is sent per fleet instance, named after it and owned by it
 * (`instance`), so `ollama/desk` and `ollama/laptop` are two providers whose calls go to their own instance. Once an
 * admin reviewed a system with a runtime provider, changes to such a provider's free models need no review again.
 */
export const SystemProviderDecl = z.object({
  name: LocalName,
  description: z.string(),
  models: z.array(ProviderModelDecl),
  /** Its models are set at runtime (an admin's choice the system follows), not fixed in the contract. */
  runtime: z.literal(true).optional(),
  /** The fleet instance that serves it: every call goes there, and only that instance may change or remove it. */
  instance: InstanceName.optional(),
});
export type SystemProviderDecl = z.infer<typeof SystemProviderDecl>;

/** Hub → system: a chat request for one of its providers' models. */
export const ProviderChat = z.object({
  provider: LocalName,
  model: z.string(),
  request: LlmRequest,
  stream: z.boolean(),
  /** The run it is for, so the system can attribute it; absent for the hub's own work. */
  run: RunId.optional(),
});
export type ProviderChat = z.infer<typeof ProviderChat>;

/** What streams back from `providerChat`: chunks, then the usage (the hub prices it from the model's `pricing`). */
export const ProviderChunk = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chunk'), chunk: LlmChunk }),
  z.object({ type: z.literal('done'), usage: LlmUsage }),
  z.object({ type: z.literal('error'), message: z.string(), kind: z.enum(['model', 'limit', 'provider', 'auth']) }),
]);
export type ProviderChunk = z.infer<typeof ProviderChunk>;

/**
 * What a provider says it serves now, from its aeye `listModels`: each model by id with the limits it is served with.
 * The hub keeps only the declared (reviewed) ones, and their declared prices and abilities.
 */
export const LiveProviderModel = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().min(1).optional(),
  maxOutput: z.number().int().min(1).optional(),
  maxQuestions: z.number().int().min(1).optional(),
  maxRequestBytes: z.number().int().min(1).optional(),
});
export type LiveProviderModel = z.infer<typeof LiveProviderModel>;

/** Hub → system: which models a provider serves now. */
export const ProviderModels = z.object({ provider: LocalName });
export type ProviderModels = z.infer<typeof ProviderModels>;

/**
 * The provider's live models (its aeye `listModels`), or `listed: false` when it can't list them, so the hub offers
 * every declared model.
 */
export const ProviderModelsResult = z.discriminatedUnion('listed', [
  z.object({ listed: z.literal(true), models: z.array(LiveProviderModel) }),
  z.object({ listed: z.literal(false) }),
]);
export type ProviderModelsResult = z.infer<typeof ProviderModelsResult>;

/** Hub → system: typed answers about an input from one of its providers' decision models (aeye's `decide`). */
export const ProviderDecide = z.object({ provider: LocalName, model: z.string(), input: DecisionInput, questions: DecisionQuestions });
export type ProviderDecide = z.infer<typeof ProviderDecide>;

/** The decision model's answers by question name, with the tokens it billed when known. */
export const ProviderDecideResult = z.object({ answers: DecisionAnswers, tokens: z.number().int().min(0).optional() });
export type ProviderDecideResult = z.infer<typeof ProviderDecideResult>;

/**
 * An image to embed, as it crosses the link: `image` is an http(s) or data URL (aeye's `EmbeddingImage` with its
 * resource as a URL, which every aeye provider reads), `mimeType` its type when the URL doesn't say.
 */
export const EmbedImage = z.object({ image: z.string().regex(/^(https?:|data:)/, 'an http(s) or data URL'), mimeType: z.string().optional() });
export type EmbedImage = z.infer<typeof EmbedImage>;

/** One thing to embed: text, or an image (aeye's `EmbeddingInput`, for models with `imageEmbedding`). */
export const EmbedInput = z.union([z.string(), EmbedImage]);
export type EmbedInput = z.infer<typeof EmbedInput>;

/** Whether an embed input is an image. */
export function isEmbedImage(input: EmbedInput): input is EmbedImage {
  return typeof input !== 'string';
}

/** Hub → system: embed inputs (texts and images, aeye's one `inputs` list) with one of its providers' embedding models. */
export const ProviderEmbed = z.object({ provider: LocalName, model: z.string(), inputs: z.array(EmbedInput).min(1) });
export type ProviderEmbed = z.infer<typeof ProviderEmbed>;

/** The system's embeddings, one per input in order, with the tokens it billed when known. */
export const ProviderEmbedResult = z.object({ vectors: z.array(z.array(z.number())), tokens: z.number().int().min(0).optional() });
export type ProviderEmbedResult = z.infer<typeof ProviderEmbedResult>;

/**
 * The AWS Bedrock provider's fields, for `providerVariants` (records/spend.ts): a region and either an access key pair
 * (with an optional session token) or a Bedrock API key (sent as a bearer token). `secret` is the schema of a key field.
 * The hub lane joins this into `providerVariants` when `execution/providers.ts` can build `@aeye/aws` with both.
 */
export function awsProviderVariant<S extends z.ZodType<string>>(secret: S) {
  return z.object({
    provider: z.literal('aws'),
    region: z.string().min(1),
    auth: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('keys'), accessKeyId: z.string().min(1), secretAccessKey: secret, sessionToken: secret.optional() }),
      z.object({ kind: z.literal('apiKey'), apiKey: secret }),
    ]),
    /** Cross-region inference profile prefix (`us.`, `eu.`, `global.`); aeye picks one for the region when absent. */
    profilePrefix: z.string().optional(),
  });
}
