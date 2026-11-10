/**
 * Matching by embeddings: cosine similarity, and one text's embedding (empty when the hub has no embedder for it).
 */
import type { Llm } from '../ctx.ts';

/** Cosine similarity of two vectors; 0 when either is empty or their lengths differ. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) { return 0; }
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

/** Embed one text, or nothing when the hub has no embedder for it. */
export async function embedOne(llm: Llm, text: string): Promise<number[]> {
  try {
    return (await llm.embed([text]))[0] ?? [];
  } catch {
    return [];
  }
}
