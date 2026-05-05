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
 *
 * Strategy (V2 — LLM-powered):
 *   1. Find candidate facts with same owner + overlapping topics
 *   2. If embeddings available, pre-filter by cosine > 0.75 (broad net)
 *   3. Send top candidates to Gemini Flash for semantic verification
 *   4. Gemini decides: does the new fact supersede any candidate?
 *
 * This replaces the pure cosine-threshold approach which couldn't
 * distinguish corrections from different-but-similar facts.
 */

import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import type { Fact } from "./db";
import { jsonToTopics } from "./utils";
import {
  generateEmbedding,
  cosineSimilarity,
  deserializeEmbedding,
  isOllamaAvailable,
} from "./embedding";
import { callLlmTask } from "./classifier";
import { dbg } from "./debug";

const log = dbg("supersede");

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
 * Three-phase strategy:
 *   1. Find facts with the SAME owner and overlapping topics
 *   2. Pre-filter with embedding similarity (cosine > 0.75) if available
 *   3. Verify with Gemini Flash — the LLM decides if it's a true supersedence
 *
 * @returns The superseded fact (if found), otherwise null
 */
export async function checkSupersedence(
  api: any,
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

  // Step 2 — Pre-filter with embeddings if available (broad cosine > 0.75)
  let filteredCandidates = candidates;
  const ollamaOnline = await isOllamaAvailable(config);

  if (ollamaOnline) {
    filteredCandidates = await prefilterWithEmbeddings(
      config,
      newFactText,
      candidates
    );
    log(`Embedding pre-filter: ${candidates.length} → ${filteredCandidates.length} candidates`);
  }

  // If no candidates pass embedding pre-filter, no supersedence
  if (filteredCandidates.length === 0) {
    return {
      shouldSupersede: false,
      supersededFactId: null,
      reason: `${candidates.length} topic candidates, none passed embedding pre-filter (>0.75)`,
    };
  }

  // Step 3 — LLM verification with Gemini Flash
  try {
    return await checkWithLlm(api, newFactText, filteredCandidates);
  } catch (error) {
    log(`LLM supersedence check failed: ${error}`);
    // Fallback: use text similarity (old behavior for resilience)
    return checkWithTextSimilarity(newFactText, filteredCandidates);
  }
}

// ---------------------------------------------------------------------------
// Candidate search
// ---------------------------------------------------------------------------

/**
 * Finds active facts with the same owner and at least one common topic.
 *
 * The query is intentionally broad — fine filtering happens later
 * with embeddings + LLM.
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
// Embedding pre-filter
// ---------------------------------------------------------------------------

/**
 * Pre-filters candidates using embedding cosine similarity.
 * Uses a broad threshold (0.75) — much lower than the old 0.92 —
 * because the LLM will make the final decision.
 *
 * Returns the top 5 candidates sorted by similarity.
 */
async function prefilterWithEmbeddings(
  config: PluginConfig,
  newFactText: string,
  candidates: Fact[]
): Promise<Fact[]> {
  let newEmbedding: number[];
  try {
    newEmbedding = await generateEmbedding(newFactText, config);
  } catch {
    // If embedding fails, return all candidates (let LLM decide)
    return candidates;
  }

  const scored: { fact: Fact; score: number }[] = [];

  for (const candidate of candidates) {
    if (!candidate.embedding) continue;

    try {
      const candidateEmbedding = deserializeEmbedding(candidate.embedding);
      const score = cosineSimilarity(newEmbedding, candidateEmbedding);

      if (score > 0.75) {
        scored.push({ fact: candidate, score });
      }
    } catch {
      // Corrupted embedding, skip
    }
  }

  // Sort by similarity descending and take top 5
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((s) => s.fact);
}

// ---------------------------------------------------------------------------
// LLM-based verification (Gemini Flash)
// ---------------------------------------------------------------------------

/**
 * Uses Gemini Flash to determine if the new fact supersedes any candidate.
 *
 * The LLM receives the new fact and a numbered list of candidates,
 * and returns a structured JSON with its decision.
 */
async function checkWithLlm(
  api: any,
  newFactText: string,
  candidates: Fact[]
): Promise<SupersedeCheck> {
  // Build the candidate list for the prompt
  const candidateList = candidates
    .map((f, i) => `  ${i + 1}. [ID: ${f.id}] "${f.text}"`)
    .join("\n");

  const prompt = `You are a fact supersedence checker for a memory system.

## Task
Determine if the NEW FACT replaces, corrects, or makes obsolete any of the EXISTING FACTS below.

## NEW FACT
"${newFactText}"

## EXISTING FACTS (same owner/topic)
${candidateList}

## Rules
- A fact is SUPERSEDED when the new fact:
  - CORRECTS it (e.g. fixes a name, date, or detail)
  - CONTRADICTS it (e.g. "likes X" → "doesn't like X anymore")
  - UPDATES it (e.g. "lives in Rome" → "moved to Milan")
  - Makes it REDUNDANT (e.g. the new fact contains all the info of the old one, plus more)
- A fact is NOT superseded when:
  - The two facts are about DIFFERENT things (even if the topic is the same)
  - The old fact adds info that the new one doesn't cover
  - They are COMPLEMENTARY, not contradictory

## Response
Respond with valid JSON only:
{
  "supersedes": true/false,
  "superseded_id": "f_xxx" or null,
  "reason": "brief explanation"
}

If multiple facts are superseded, pick the ONE most directly replaced.
Respond ONLY with JSON, no markdown, no explanations.`;

  log(`Calling Gemini for supersedence check: "${newFactText.substring(0, 60)}..." vs ${candidates.length} candidates`);

  const response = await callLlmTask(api, prompt, "supersede");
  log(`Gemini supersedence response: ${response}`);

  // Parse the response
  let parsed: any;
  try {
    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return {
          shouldSupersede: false,
          supersededFactId: null,
          reason: "LLM response not parseable as JSON",
        };
      }
    } else {
      return {
        shouldSupersede: false,
        supersededFactId: null,
        reason: "LLM response not parseable as JSON",
      };
    }
  }

  // Validate the superseded_id actually exists in our candidates
  if (parsed.supersedes && parsed.superseded_id) {
    const validCandidate = candidates.find(
      (c) => c.id === parsed.superseded_id
    );
    if (validCandidate) {
      return {
        shouldSupersede: true,
        supersededFactId: parsed.superseded_id,
        reason: `LLM: ${parsed.reason || "supersedence confirmed"}`,
      };
    } else {
      log(`LLM returned invalid superseded_id: ${parsed.superseded_id}`);
      return {
        shouldSupersede: false,
        supersededFactId: null,
        reason: `LLM returned invalid fact ID: ${parsed.superseded_id}`,
      };
    }
  }

  return {
    shouldSupersede: false,
    supersededFactId: null,
    reason: `LLM: ${parsed.reason || "no supersedence"}`,
  };
}

// ---------------------------------------------------------------------------
// Text fallback
// ---------------------------------------------------------------------------

/**
 * Verifies supersedence with a simple text comparison.
 * Used when Gemini is unavailable (API key missing, network error, etc.).
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
      reason: `text fallback: word overlap ${(bestMatch.overlap * 100).toFixed(0)}% with "${bestMatch.fact.text.substring(0, 50)}..."`,
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
