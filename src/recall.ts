/**
 * recall.ts — Context injection into the prompt
 *
 * Hook `before_prompt_build`: before OpenClaw builds the prompt,
 * recall injects relevant information from memory.
 *
 * Injection follows a priority order with a token budget:
 *
 *   1. MEMORY.md         → operational rules (always, on top)
 *   2. Routing hints     → where to look for tasks/appointments/media
 *   3. Wiki pages        → structural knowledge for active topics
 *   4. Top-K facts       → hybrid BM25 + vector search
 *   5. Session captures  → current session facts (not yet processed)
 *
 * Total budget is ~1100 tokens (configurable). If Ollama is offline,
 * vector search is skipped — BM25 only.
 */

import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import type { Fact } from "./db";
import { jsonToTopics } from "./db";
import {
  generateEmbedding,
  isOllamaAvailable,
  cosineSimilarity,
  deserializeEmbedding,
} from "./embedding";

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a Telegram sender_id (e.g. "7776007798") to the canonical
 * owner_id used in facts (e.g. "frodo").
 *
 * Looks up the users table: sender_id → names[0] (canonical) → lowercase.
 * Falls back to the raw senderId if not found.
 */
function resolveCanonicalId(
  db: Database.Database,
  senderId: string
): string {
  const row = db
    .prepare("SELECT names FROM users WHERE sender_id = ?")
    .get(senderId) as { names: string } | undefined;

  if (!row) return senderId;

  try {
    const names = JSON.parse(row.names) as string[];
    return names[0]?.toLowerCase() || senderId;
  } catch {
    return senderId;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context injected into the prompt */
export interface RecallContext {
  /** Text to inject into the system prompt */
  systemContext: string;

  /** Estimated token consumption */
  estimatedTokens: number;

  /** Details for debug/logging */
  details: {
    memoryMdLoaded: boolean;
    wikiPagesMatched: number;
    factsMatched: number;
    capturesFound: number;
    vectorSearchUsed: boolean;
  };
}

// ---------------------------------------------------------------------------
// Main recall
// ---------------------------------------------------------------------------

/**
 * Builds the context to inject into the prompt.
 *
 * @param db         - Database
 * @param config     - Plugin configuration
 * @param sessionId  - Current session
 * @param userQuery  - The user's message (for search)
 * @param senderId   - Sender ID (to filter memories)
 * @returns The assembled context ready for injection
 */
export async function buildRecallContext(
  db: Database.Database,
  config: PluginConfig,
  sessionId: string,
  userQuery: string,
  senderId: string
): Promise<RecallContext> {
  const parts: string[] = [];
  const details: RecallContext["details"] = {
    memoryMdLoaded: false,
    wikiPagesMatched: 0,
    factsMatched: 0,
    capturesFound: 0,
    vectorSearchUsed: false,
  };

  // Rough estimate: 1 token ≈ 4 characters
  let charBudget = config.recallBudgetTokens * 4;

  // Resolve Telegram numeric ID → canonical owner_id (e.g. "frodo")
  const canonicalId = resolveCanonicalId(db, senderId);

  // -----------------------------------------------------------------
  // 1. MEMORY.md — operational rules (always on top)
  // -----------------------------------------------------------------
  const memoryMd = loadMemoryMd(config);
  if (memoryMd) {
    parts.push("## Operational rules (MEMORY.md)\n" + memoryMd);
    charBudget -= memoryMd.length;
    details.memoryMdLoaded = true;
  }

  // -----------------------------------------------------------------
  // 2. Routing hints — guide the agent to appropriate skills
  // -----------------------------------------------------------------
  const routingHints = buildRoutingHints();
  parts.push(routingHints);
  charBudget -= routingHints.length;

  // -----------------------------------------------------------------
  // 3. Wiki pages for session topics
  // -----------------------------------------------------------------
  const sessionTopics = getSessionTopics(db, sessionId);
  if (sessionTopics.length > 0 && charBudget > 500) {
    const wikiContent = loadWikiPages(config, sessionTopics);
    if (wikiContent) {
      // Truncate to available budget
      const truncated =
        wikiContent.length > charBudget * 0.4
          ? wikiContent.substring(0, Math.floor(charBudget * 0.4)) + "\n..."
          : wikiContent;
      parts.push("## Relevant knowledge (wiki)\n" + truncated);
      charBudget -= truncated.length;
      details.wikiPagesMatched = sessionTopics.length;
    }
  }

  // -----------------------------------------------------------------
  // 4. Top-K facts from hybrid search
  // -----------------------------------------------------------------
  if (charBudget > 300) {
    const facts = await hybridSearch(
      db,
      config,
      userQuery,
      canonicalId,
      config.recallTopK
    );
    details.vectorSearchUsed = facts.vectorUsed;
    details.factsMatched = facts.results.length;

    if (facts.results.length > 0) {
      const factsText = facts.results
        .map((f) => `- ${f.text} [${f.fact_type}]`)
        .join("\n");
      const truncated =
        factsText.length > charBudget * 0.4
          ? factsText.substring(0, Math.floor(charBudget * 0.4)) + "\n..."
          : factsText;
      parts.push("## Facts from memory\n" + truncated);
      charBudget -= truncated.length;
    }
  }

  // -----------------------------------------------------------------
  // 5. Session captures (current session facts)
  // -----------------------------------------------------------------
  if (charBudget > 200) {
    const captures = getRecentCaptures(db, sessionId);
    details.capturesFound = captures.length;

    if (captures.length > 0) {
      const capturesText = captures
        .map((c) => `- ${c.fact_text}`)
        .join("\n");
      const truncated =
        capturesText.length > charBudget
          ? capturesText.substring(0, charBudget) + "\n..."
          : capturesText;
      parts.push("## Current session captures\n" + truncated);
    }
  }

  // -----------------------------------------------------------------
  // Assemble context
  // -----------------------------------------------------------------
  const systemContext = parts.join("\n\n");

  return {
    systemContext,
    estimatedTokens: Math.ceil(systemContext.length / 4),
    details,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Loads MEMORY.md — operational rules.
 * Contains only rules that change the agent's behavior.
 */
function loadMemoryMd(config: PluginConfig): string | null {
  const memoryPath = path.join(
    path.dirname(config.dbPath),
    "MEMORY.md"
  );

  try {
    return fs.readFileSync(memoryPath, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Routing hints: tell the agent where to look for tasks and appointments.
 *
 * This is fundamental for recall ↔ skill discernment:
 * recall does NOT inject tasks/appointments into context, but tells
 * the agent "if they ask about X, use skill Y".
 *
 * Override this function to customize hints for your deployment.
 */
function buildRoutingHints(): string {
  return `## Routing (how to find specific information)
- **Appointments and calendar** → use the appropriate calendar skill
- **Tasks and errands** → use the task management skill
- **Photos and videos** → use the media cataloging skill
Memory below contains ONLY knowledge and context — not tasks or appointments.`;
}

/**
 * Gets the active topics in the current session.
 * Used to decide which wiki pages to load.
 */
function getSessionTopics(
  db: Database.Database,
  sessionId: string
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT topics FROM session_captures
       WHERE session_id = ? AND promoted = 0
       ORDER BY id DESC LIMIT 5`
    )
    .all(sessionId) as Array<{ topics: string }>;

  // Collect all unique topics
  const allTopics = new Set<string>();
  for (const row of rows) {
    for (const topic of jsonToTopics(row.topics)) {
      allTopics.add(topic);
    }
  }

  return [...allTopics];
}

/**
 * Loads wiki pages relevant to the session topics.
 *
 * Uses topic-index.json to find the right pages, then
 * reads the markdown file contents.
 */
function loadWikiPages(
  config: PluginConfig,
  topics: string[]
): string | null {
  const indexPath = path.join(config.wikiPath, "_meta", "topic-index.json");

  let topicIndex: Record<string, string[]>;
  try {
    topicIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  } catch {
    return null; // Index not yet created (first startup)
  }

  // Find relevant pages for the topics
  const pageFiles = new Set<string>();
  for (const topic of topics) {
    const pages = topicIndex[topic] ?? [];
    for (const page of pages) {
      pageFiles.add(page);
    }
  }

  if (pageFiles.size === 0) return null;

  // Load content (max 3 pages to avoid budget explosion)
  const contents: string[] = [];
  let count = 0;
  for (const pageFile of pageFiles) {
    if (count >= 3) break;
    const filePath = path.join(config.wikiPath, pageFile);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      // Remove YAML frontmatter
      const cleaned = content.replace(/^---[\s\S]*?---\s*/, "").trim();
      contents.push(`### ${path.basename(pageFile, ".md")}\n${cleaned}`);
      count++;
    } catch {
      // File not found — topic-index out of date, skip
    }
  }

  return contents.length > 0 ? contents.join("\n\n") : null;
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

interface HybridSearchResult {
  results: Array<Fact & { score: number }>;
  vectorUsed: boolean;
}

/**
 * Hybrid search: combines BM25 (text) and vector (semantic) search.
 *
 * Default weights: BM25 70%, vector 30%.
 *
 * If the Ollama server is offline → BM25 only (graceful degradation).
 * If the query is very short → BM25 only (embedding not useful).
 */
async function hybridSearch(
  db: Database.Database,
  config: PluginConfig,
  query: string,
  senderId: string,
  topK: number
): Promise<HybridSearchResult> {
  // BM25: always available
  const bm25Results = searchBM25(db, query, senderId, topK * 2);

  // Vector: only if Ollama is online and query is substantial
  let vectorResults: Map<string, number> = new Map();
  let vectorUsed = false;

  if (query.length > 20 && (await isOllamaAvailable(config))) {
    try {
      const queryEmbedding = await generateEmbedding(query, config);
      vectorResults = searchVector(db, queryEmbedding, senderId, topK * 2);
      vectorUsed = true;
    } catch {
      // Ollama unreachable, proceeding with BM25 only
    }
  }

  // Combine results with configured weights
  const combined = combineResults(
    bm25Results,
    vectorResults,
    config.bm25Weight,
    config.vectorWeight,
    vectorUsed
  );

  // Top-K
  const sorted = [...combined.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  // Load full facts
  const results: Array<Fact & { score: number }> = [];
  for (const [factId, score] of sorted) {
    const fact = db
      .prepare("SELECT * FROM facts WHERE id = ? AND is_active = 1")
      .get(factId) as Fact | undefined;
    if (fact) {
      results.push({ ...fact, score });

      // Increment access counter
      db.prepare(
        "UPDATE facts SET access_count = access_count + 1 WHERE id = ?"
      ).run(factId);
    }
  }

  return { results, vectorUsed };
}

/**
 * BM25 search on the FTS5 table.
 * Filters by owner (shows only the user's, global, or group facts).
 */
function searchBM25(
  db: Database.Database,
  query: string,
  senderId: string,
  limit: number
): Map<string, number> {
  const results = new Map<string, number>();

  // Normalize query for FTS5 (remove special characters)
  const ftsQuery = query
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .join(" OR ");

  if (!ftsQuery) return results;

  const rows = db
    .prepare(
      `SELECT f.id, bm25(facts_fts) as score
       FROM facts_fts
       JOIN facts f ON facts_fts.rowid = f.rowid
       WHERE facts_fts MATCH ?
         AND f.is_active = 1
         AND (
           f.owner_id = ? OR
           f.owner_type = 'global' OR
           f.owner_type = 'group'
         )
       ORDER BY score
       LIMIT ?`
    )
    .all(ftsQuery, senderId, limit) as Array<{ id: string; score: number }>;

  for (const row of rows) {
    // BM25 returns negative values (more negative = more relevant)
    // Normalize to 0-1
    results.set(row.id, Math.abs(row.score));
  }

  // Normalize to 0-1
  const maxScore = Math.max(...results.values(), 1);
  for (const [id, score] of results) {
    results.set(id, score / maxScore);
  }

  return results;
}

/**
 * Vector search: computes cosine similarity between the query
 * and all facts with embeddings.
 *
 * NOTE: Without sqlite-vec, search is done in-memory.
 * For our dataset (< 10k facts) this is performant.
 * If the dataset grows, migrate to sqlite-vec.
 */
function searchVector(
  db: Database.Database,
  queryEmbedding: number[],
  senderId: string,
  limit: number
): Map<string, number> {
  const results = new Map<string, number>();

  // Load all active facts with embeddings
  const rows = db
    .prepare(
      `SELECT id, embedding FROM facts
       WHERE is_active = 1
         AND embedding IS NOT NULL
         AND (
           owner_id = ? OR
           owner_type = 'global' OR
           owner_type = 'group'
         )`
    )
    .all(senderId) as Array<{ id: string; embedding: Buffer }>;

  for (const row of rows) {
    try {
      const factEmbedding = deserializeEmbedding(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, factEmbedding);
      if (similarity > 0.3) {
        // Only minimally relevant results
        results.set(row.id, similarity);
      }
    } catch {
      // Corrupted embedding, skip
    }
  }

  return results;
}

/**
 * Combines BM25 and vector results with configurable weights.
 * If vector search was not used, returns BM25 results directly.
 */
function combineResults(
  bm25: Map<string, number>,
  vector: Map<string, number>,
  bm25Weight: number,
  vectorWeight: number,
  vectorUsed: boolean
): Map<string, number> {
  const combined = new Map<string, number>();

  // If BM25 only, use those results directly
  if (!vectorUsed) {
    return bm25;
  }

  // Merge all keys
  const allIds = new Set([...bm25.keys(), ...vector.keys()]);

  for (const id of allIds) {
    const bm25Score = bm25.get(id) ?? 0;
    const vectorScore = vector.get(id) ?? 0;
    combined.set(id, bm25Score * bm25Weight + vectorScore * vectorWeight);
  }

  return combined;
}

// ---------------------------------------------------------------------------
// Current session captures
// ---------------------------------------------------------------------------

/**
 * Gets unpromoted captures from the current session.
 * These are injected into the prompt as "working memory".
 */
function getRecentCaptures(
  db: Database.Database,
  sessionId: string
): Array<{ fact_text: string }> {
  return db
    .prepare(
      `SELECT fact_text FROM session_captures
       WHERE session_id = ? AND promoted = 0
       ORDER BY id DESC LIMIT 10`
    )
    .all(sessionId) as Array<{ fact_text: string }>;
}
