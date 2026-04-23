/**
 * embedding.ts — Ollama server client
 *
 * Generates vector embeddings using nomic-embed-text
 * running on an Ollama server (configurable via embeddingUrl).
 *
 * If the Ollama server is offline, operations requiring embeddings
 * degrade gracefully: search falls back to BM25 only.
 */

import type { PluginConfig } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An embedding vector (array of floats) */
export type EmbeddingVector = number[];

/** Result of a cosine similarity computation */
export interface SimilarityResult {
  id: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Ollama client
// ---------------------------------------------------------------------------

/**
 * Generates an embedding for a text using Ollama.
 *
 * @throws If the Ollama server is offline or the model is unavailable
 */
export async function generateEmbedding(
  text: string,
  config: PluginConfig
): Promise<EmbeddingVector> {
  const url = `${config.embeddingUrl}/api/embeddings`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.embeddingModel,
      prompt: text,
    }),
    // 10 second timeout — if the server doesn't respond, better to fail fast
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(
      `Ollama responded ${response.status}: ${response.statusText}`
    );
  }

  const data = (await response.json()) as { embedding: number[] };

  if (!data.embedding || !Array.isArray(data.embedding)) {
    throw new Error("Malformed Ollama response: missing 'embedding' field");
  }

  return data.embedding;
}

/**
 * Generates embeddings for multiple texts in batch.
 * Useful for the dream engine that processes many captures.
 *
 * If a single embedding fails, it skips it and continues with the rest.
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  config: PluginConfig
): Promise<Map<number, EmbeddingVector>> {
  const results = new Map<number, EmbeddingVector>();

  for (let i = 0; i < texts.length; i++) {
    try {
      const embedding = await generateEmbedding(texts[i], config);
      results.set(i, embedding);
    } catch {
      // Silent skip — the caller handles missing entries
    }
  }

  return results;
}

/**
 * Checks if the Ollama server is reachable.
 * Used to decide whether to use vector search or BM25 only.
 */
export async function isOllamaAvailable(config: PluginConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.embeddingUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Vector utilities
// ---------------------------------------------------------------------------

/**
 * Computes cosine similarity between two vectors.
 *
 * Value between -1 (opposite) and 1 (identical).
 * For text embeddings, values > 0.85 indicate high similarity.
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimensions don't match: ${a.length} vs ${b.length}`
    );
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Serializes an embedding vector for SQLite storage.
 * Uses Float32Array to save space (50% compared to Float64).
 *
 * 768 dims × 4 bytes = 3072 bytes per embedding.
 */
export function serializeEmbedding(embedding: EmbeddingVector): Buffer {
  const float32 = new Float32Array(embedding);
  return Buffer.from(float32.buffer);
}

/**
 * Deserializes an embedding vector from SQLite.
 */
export function deserializeEmbedding(buffer: Buffer): EmbeddingVector {
  const float32 = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.length / 4
  );
  return Array.from(float32);
}
