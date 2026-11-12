/**
 * Model providers: ones a system brings, and the AWS Bedrock provider's config.
 *
 * A system declares aeye providers in its manifest (`providers`); the provider code runs in the system. The hub
 * registers each as a remote aeye provider named `<system>/<provider>`, so picking one of its models routes chat and
 * embedding calls over the link (`providerChat`, `providerEmbed`), recorded as `ModelCall`s like any other.
 */
import { z } from 'zod';
import { LlmChunk, LlmRequest, LlmUsage } from './llm.ts';
import { LocalName, RunId, Usd } from './primitives.ts';

/** Prices in USD per million tokens. `cached`: reading the prompt cache; `cacheWrite`: writing it, where billed. */
export const TokenPricing = z.object({ input: Usd, output: Usd, cached: Usd.optional(), cacheWrite: Usd.optional() });
export type TokenPricing = z.infer<typeof TokenPricing>;

/**
 * One model a system's provider serves. `capabilities` are aeye `ModelCapability` names (`chat`, `tools`, `vision`,
 * `json`, `embedding`, ...); the hub keeps only those aeye knows. `caching`: whether the model reads a prompt cache.
 */
export const ProviderModelDecl = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  capabilities: z.array(z.string()),
  contextWindow: z.number().int().min(1),
  maxOutput: z.number().int().min(1).optional(),
  pricing: TokenPricing,
  caching: z.boolean(),
});
export type ProviderModelDecl = z.infer<typeof ProviderModelDecl>;

/** A provider a system declares (manifest `providers`). */
export const SystemProviderDecl = z.object({ name: LocalName, description: z.string(), models: z.array(ProviderModelDecl) });
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

/** Hub → system: embed texts with one of its providers' embedding models. */
export const ProviderEmbed = z.object({ provider: LocalName, model: z.string(), texts: z.array(z.string()).min(1) });
export type ProviderEmbed = z.infer<typeof ProviderEmbed>;

/** The system's embeddings, one per text in order, with the tokens it billed when known. */
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
