/**
 * supersede.ts — Supersedence logic
 *
 * When a new fact contradicts an old one, the old fact gets
 * "superseded" (not deleted — never delete).
 *
 * Example:
 *   Old:  "Alice does karate" (id: f_abc)
 *   New:  "Alice stopped doing karate" (id: f_xyz)
 *   → f_abc.superseded_by = f_xyz, f_abc.is_active = 0
 *
 * Supersedence is executed by the light dream when promoting
 * a capture to a fact. It's not real-time (needs reflection).
 */

import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import type { Fact, SessionCapture } from "./db";
import { jsonToTopics } from "./utils";
import {
  generateEmbedding,
  cosineSimilarity,
  deserializeEmbedding,
  isOllamaAvailable,
} from "./embedding";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a supersedence check */
export interface SupersedeCheck {
  /** true if the new fact supersedes an existing one */
  shouldSupersede: boolean;

  /** ID of the superseded fact (if applicable) */
  supersededFactId: string | null;

  /** Reason for the decision (for debug/logging) */
  reason: string;
}

// ---------------------------------------------------------------------------
// Supersedence check
// ---------------------------------------------------------------------------

/**
 * Checks if a new fact supersedes an existing fact.
 *
 * Two-pass strategy:
 *   1. Find facts with the SAME owner and overlapping topics
 *   2. If candidates found, verify semantic similarity
 *
 * A fact supersedes if:
 *   - Same owner (owner_type + owner_id)
 *   - Same topic (at least 1 topic in common)
 *   - High semantic similarity (cosine > 0.85) OR
 *     same entity mentioned in the text
 *
 * @returns The superseded fact (if found), otherwise null
 */
export async function checkSupersedence(
  db: Database.Database,
  config: PluginConfig,
  newFactText: string,
  newTopics: string[],
  ownerType: string,
  ownerId: string
): Promise<SupersedeCheck> {
  // Step 1 — Find candidates with same owner and overlapping topics
  const candidates = findCandidates(db, newTopics, ownerType, ownerId);

  if (candidates.length === 0) {
    return {
      shouldSupersede: false,
      supersededFactId: null,
      reason: "no facts with overlapping owner/topic",
    };
  }

  // Step 2 — Verify semantic similarity (if Ollama is online)
  const ollamaOnline = await isOllamaAvailable(config);

  if (ollamaOnline) {
    return await checkWithEmbedding(config, newFactText, candidates);
  }

  // Fallback: simple text comparison
  return checkWithTextSimilarity(newFactText, candidates);
}

// ---------------------------------------------------------------------------
// Candidate search
// ---------------------------------------------------------------------------

/**
 * Finds active facts with the same owner and at least one common topic.
 *
 * The query is intentionally broad — fine filtering happens later
 * with semantic similarity.
 */
function findCandidates(
  db: Database.Database,
  newTopics: string[],
  ownerType: string,
  ownerId: string
): Fact[] {
  // Get all active facts from the same owner
  const allFacts = db
    .prepare(
      `SELECT * FROM facts
       WHERE is_active = 1
         AND owner_type = ?
         AND owner_id = ?
       ORDER BY updated_at DESC
       LIMIT 50`
    )
    .all(ownerType, ownerId) as Fact[];

  // Filter by overlapping topic
  return allFacts.filter((fact) => {
    const factTopics = jsonToTopics(fact.topics);
    return newTopics.some((t) => factTopics.includes(t));
  });
}

// ---------------------------------------------------------------------------
// Embedding-based verification
// ---------------------------------------------------------------------------

/**
 * Verifies supersedence using cosine similarity.
 * The fact with the highest similarity above the threshold gets superseded.
 */
async function checkWithEmbedding(
  config: PluginConfig,
  newFactText: string,
  candidates: Fact[]
): Promise<SupersedeCheck> {
  let newEmbedding: number[];
  try {
    newEmbedding = await generateEmbedding(newFactText, config);
  } catch {
    // If embedding fails, use text fallback
    return checkWithTextSimilarity(newFactText, candidates);
  }

  let bestMatch: { fact: Fact; score: number } | null = null;

  for (const candidate of candidates) {
    if (!candidate.embedding) continue;

    try {
      const candidateEmbedding = deserializeEmbedding(candidate.embedding);
      const score = cosineSimilarity(newEmbedding, candidateEmbedding);

      if (score > 0.85 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { fact: candidate, score };
      }
    } catch {
      // Corrupted embedding, skip
    }
  }

  if (bestMatch) {
    return {
      shouldSupersede: true,
      supersededFactId: bestMatch.fact.id,
      reason: `cosine similarity ${bestMatch.score.toFixed(3)} with "${bestMatch.fact.text.substring(0, 50)}..."`,
    };
  }

  return {
    shouldSupersede: false,
    supersededFactId: null,
    reason: `${candidates.length} candidates found but none above 0.85 threshold`,
  };
}

// ---------------------------------------------------------------------------
// Text fallback
// ---------------------------------------------------------------------------

/**
 * Verifies supersedence with a simple text comparison.
 * Used when the Ollama server is offline and embeddings are unavailable.
 *
 * Compares keywords: if > 60% of substantive words match,
 * considers the fact as a potential supersedence.
 */
function checkWithTextSimilarity(
  newFactText: string,
  candidates: Fact[]
): SupersedeCheck {
  const newWords = extractKeywords(newFactText);

  let bestMatch: { fact: Fact; overlap: number } | null = null;

  for (const candidate of candidates) {
    const candidateWords = extractKeywords(candidate.text);
    const overlap = calculateWordOverlap(newWords, candidateWords);

    if (overlap > 0.6 && (!bestMatch || overlap > bestMatch.overlap)) {
      bestMatch = { fact: candidate, overlap };
    }
  }

  if (bestMatch) {
    return {
      shouldSupersede: true,
      supersededFactId: bestMatch.fact.id,
      reason: `word overlap ${(bestMatch.overlap * 100).toFixed(0)}% with "${bestMatch.fact.text.substring(0, 50)}..."`,
    };
  }

  return {
    shouldSupersede: false,
    supersededFactId: null,
    reason: "no significant text match (< 60% overlap)",
  };
}

/**
 * Extracts keywords from a text (removes stop words and short words).
 */
function extractKeywords(text: string): Set<string> {
  const stopWords = new Set([
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una",
    "di", "a", "da", "in", "con", "su", "per", "tra", "fra",
    "che", "non", "è", "ha", "sono", "come", "anche", "più",
    "the", "a", "an", "is", "are", "was", "of", "to", "and",
    "for", "in", "on", "at", "by", "with",
  ]);

  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
  );
}

/**
 * Calculates the overlap between two word sets (Jaccard index).
 * 0 = no words in common, 1 = identical.
 */
function calculateWordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ---------------------------------------------------------------------------
// Supersedence execution
// ---------------------------------------------------------------------------

/**
 * Marks a fact as superseded by a new fact.
 * The old fact is NOT deleted — it stays in the DB with is_active=0
 * and a reference to the fact that superseded it.
 */
export function executeSupersedence(
  db: Database.Database,
  oldFactId: string,
  newFactId: string
): void {
  db.prepare(
    `UPDATE facts SET
       is_active = 0,
       superseded_by = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(newFactId, oldFactId);
}
