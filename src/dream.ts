/**
 * dream.ts — Dream Engine (memory consolidation)
 *
 * The dream is the process that transforms volatile captures
 * into permanent knowledge. It has two modes:
 *
 *   1. **Light dream** (every 6h):
 *      - Promotes captures to permanent facts
 *      - Generates embeddings for new facts
 *      - Executes supersedence (marks contradicted old facts)
 *
 *   2. **REM dream** (1x/night, 03:00):
 *      - Everything from light dream, plus:
 *      - De-duplication (cosine > 0.85 on similar facts)
 *      - Confidence decay (>90 days without access → -0.1)
 *      - Wiki update (creates/updates pages for structural knowledge)
 *      - MEMORY.md update (promotes only operational rules)
 *      - Archive compression (>6 months → weekly summaries)
 *      - Generates dream-report.md
 */

import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import type { SessionCapture, Fact } from "./db";
import { generateFactId, topicsToJson, jsonToTopics } from "./db";
import {
  generateEmbedding,
  serializeEmbedding,
  isOllamaAvailable,
  cosineSimilarity,
  deserializeEmbedding,
} from "./embedding";
import { checkSupersedence, executeSupersedence } from "./supersede";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a dream cycle */
export interface DreamReport {
  type: "light" | "rem";
  startedAt: string;
  completedAt: string;
  capturesProcessed: number;
  factsCreated: number;
  factsSuperseded: number;
  factsDeduplicated: number;
  factsDecayed: number;
  wikiPagesUpdated: number;
  memoryMdUpdated: boolean;
  archiveCompressed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Light dream
// ---------------------------------------------------------------------------

/**
 * Light dream — promotes captures to facts.
 *
 * Runs every 6 hours. Fast and lightweight.
 */
export async function dreamLight(
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<DreamReport> {
  const report: DreamReport = {
    type: "light",
    startedAt: new Date().toISOString(),
    completedAt: "",
    capturesProcessed: 0,
    factsCreated: 0,
    factsSuperseded: 0,
    factsDeduplicated: 0,
    factsDecayed: 0,
    wikiPagesUpdated: 0,
    memoryMdUpdated: false,
    archiveCompressed: 0,
    errors: [],
  };

  logger.info("[Dream Light] Starting consolidation...");

  // Get unpromoted captures
  const captures = getPendingCaptures(db);
  report.capturesProcessed = captures.length;

  if (captures.length === 0) {
    logger.info("[Dream Light] No captures to process");
    report.completedAt = new Date().toISOString();
    return report;
  }

  // Check if Ollama is available for embeddings
  const ollamaOnline = await isOllamaAvailable(config);

  // Process each capture
  for (const capture of captures) {
    try {
      await promoteCapture(db, config, capture, ollamaOnline, report, logger);
    } catch (error) {
      const msg = `Error promoting capture #${capture.id}: ${error}`;
      logger.warn(`[Dream Light] ${msg}`);
      report.errors.push(msg);

      // Mark as error (promoted=2) to avoid infinite retry
      db.prepare(
        "UPDATE session_captures SET promoted = 2 WHERE id = ?"
      ).run(capture.id);
    }
  }

  report.completedAt = new Date().toISOString();
  logger.info(
    `[Dream Light] Complete — ${report.factsCreated} facts created, ${report.factsSuperseded} superseded`
  );

  return report;
}

// ---------------------------------------------------------------------------
// REM dream
// ---------------------------------------------------------------------------

/**
 * REM dream — deep nightly consolidation.
 *
 * Runs 1x/night at 03:00. Includes everything from light dream
 * plus de-duplication, decay, wiki, MEMORY.md, and archive.
 */
export async function dreamRem(
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<DreamReport> {
  // Phase 1: run light dream first
  const report = await dreamLight(db, config, logger);
  report.type = "rem";

  logger.info("[Dream REM] Starting REM phase...");

  // Phase 2: de-duplication
  try {
    report.factsDeduplicated = await deduplicateFacts(db, config, logger);
  } catch (error) {
    report.errors.push(`De-duplication: ${error}`);
  }

  // Phase 3: confidence decay
  try {
    report.factsDecayed = decayConfidence(db, logger);
  } catch (error) {
    report.errors.push(`Decay: ${error}`);
  }

  // Phase 4: wiki update
  try {
    report.wikiPagesUpdated = await updateWikiPages(db, config, logger);
  } catch (error) {
    report.errors.push(`Wiki update: ${error}`);
  }

  // Phase 5: MEMORY.md update
  try {
    report.memoryMdUpdated = updateMemoryMd(db, config, logger);
  } catch (error) {
    report.errors.push(`MEMORY.md: ${error}`);
  }

  // Phase 6: archive compression
  try {
    report.archiveCompressed = compressOldArchive(db, logger);
  } catch (error) {
    report.errors.push(`Archive compression: ${error}`);
  }

  report.completedAt = new Date().toISOString();

  // Save the report
  saveDreamReport(config, report);

  logger.info(
    `[Dream REM] Complete — dedup: ${report.factsDeduplicated}, ` +
      `decayed: ${report.factsDecayed}, wiki: ${report.wikiPagesUpdated}`
  );

  return report;
}

// ---------------------------------------------------------------------------
// Capture promotion → facts
// ---------------------------------------------------------------------------

/**
 * Promotes a single capture to a permanent fact.
 *
 * 1. Generate embedding (if Ollama is online)
 * 2. Check supersedence
 * 3. Insert the fact
 * 4. Mark the capture as promoted
 */
async function promoteCapture(
  db: Database.Database,
  config: PluginConfig,
  capture: SessionCapture,
  ollamaOnline: boolean,
  report: DreamReport,
  logger: any
): Promise<void> {
  const factId = generateFactId();
  const topics = jsonToTopics(capture.topics);

  // Generate embedding
  let embeddingBuffer: Buffer | null = null;
  if (ollamaOnline) {
    try {
      const embedding = await generateEmbedding(capture.fact_text, config);
      embeddingBuffer = serializeEmbedding(embedding);
    } catch {
      logger.warn(`[Dream] Embedding failed for capture #${capture.id}`);
    }
  }

  // Check supersedence
  const supersedeCheck = await checkSupersedence(
    db,
    config,
    capture.fact_text,
    topics,
    capture.owner_type,
    capture.owner_id
  );

  // Transaction: insert fact + optional supersedence + mark promoted
  const promote = db.transaction(() => {
    // Insert the new fact
    db.prepare(
      `INSERT INTO facts
        (id, text, topics, sender_id, owner_type, owner_id,
         fact_type, embedding, confidence)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, 1.0)`
    ).run(
      factId,
      capture.fact_text,
      capture.topics,
      capture.sender_id,
      capture.owner_type,
      capture.owner_id,
      capture.fact_type,
      embeddingBuffer
    );

    // Supersedence
    if (supersedeCheck.shouldSupersede && supersedeCheck.supersededFactId) {
      executeSupersedence(db, supersedeCheck.supersededFactId, factId);
      report.factsSuperseded++;
      logger.info(
        `[Dream] Supersedence: "${capture.fact_text.substring(0, 40)}..." ` +
          `supersedes ${supersedeCheck.supersededFactId} (${supersedeCheck.reason})`
      );
    }

    // Mark capture as promoted
    db.prepare(
      "UPDATE session_captures SET promoted = 1 WHERE id = ?"
    ).run(capture.id);
  });

  promote();
  report.factsCreated++;
}

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

/**
 * Finds and removes nearly identical facts (cosine > 0.85).
 * Keeps the most recent, marks the others as superseded.
 */
async function deduplicateFacts(
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<number> {
  if (!(await isOllamaAvailable(config))) {
    logger.info("[Dream REM] Ollama offline, skipping de-duplication");
    return 0;
  }

  // Load all active facts with embeddings
  const facts = db
    .prepare(
      `SELECT id, text, embedding, updated_at FROM facts
       WHERE is_active = 1 AND embedding IS NOT NULL
       ORDER BY updated_at DESC`
    )
    .all() as Array<{
    id: string;
    text: string;
    embedding: Buffer;
    updated_at: string;
  }>;

  let deduplicated = 0;
  const processed = new Set<string>();

  for (let i = 0; i < facts.length; i++) {
    if (processed.has(facts[i].id)) continue;

    const embA = deserializeEmbedding(facts[i].embedding);

    for (let j = i + 1; j < facts.length; j++) {
      if (processed.has(facts[j].id)) continue;

      try {
        const embB = deserializeEmbedding(facts[j].embedding);
        const similarity = cosineSimilarity(embA, embB);

        if (similarity > 0.85) {
          // The older one (j, since sorted DESC) gets superseded
          executeSupersedence(db, facts[j].id, facts[i].id);
          processed.add(facts[j].id);
          deduplicated++;
          logger.info(
            `[Dream REM] Dedup: "${facts[j].text.substring(0, 40)}..." ` +
              `(sim: ${similarity.toFixed(3)})`
          );
        }
      } catch {
        // Corrupted embedding, skip
      }
    }
  }

  return deduplicated;
}

// ---------------------------------------------------------------------------
// Confidence decay
// ---------------------------------------------------------------------------

/**
 * Lowers the confidence of facts not accessed for >90 days.
 * -0.1 per cycle. Never drops below 0.1 (never auto-delete).
 */
function decayConfidence(db: Database.Database, logger: any): number {
  const result = db
    .prepare(
      `UPDATE facts SET
         confidence = MAX(0.1, confidence - 0.1),
         updated_at = datetime('now')
       WHERE is_active = 1
         AND access_count = 0
         AND created_at < datetime('now', '-90 days')
         AND confidence > 0.1`
    )
    .run();

  if (result.changes > 0) {
    logger.info(
      `[Dream REM] Decay: ${result.changes} facts had confidence reduced`
    );
  }

  return result.changes;
}

// ---------------------------------------------------------------------------
// Wiki update
// ---------------------------------------------------------------------------

/**
 * Creates or updates wiki pages for structural knowledge.
 *
 * Thresholds:
 *   - Person entity: 3+ structural facts → create page
 *   - Entity with rule: 1 fact_type="rule" → create page
 *   - Group: on first owner_type=group fact → create page
 */
async function updateWikiPages(
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<number> {
  let pagesUpdated = 0;

  // Find owners with enough facts for a wiki page
  const owners = db
    .prepare(
      `SELECT owner_type, owner_id,
              COUNT(*) as fact_count,
              SUM(CASE WHEN fact_type = 'rule' THEN 1 ELSE 0 END) as rule_count
       FROM facts
       WHERE is_active = 1
       GROUP BY owner_type, owner_id
       HAVING fact_count >= 3 OR rule_count >= 1`
    )
    .all() as Array<{
    owner_type: string;
    owner_id: string;
    fact_count: number;
    rule_count: number;
  }>;

  for (const owner of owners) {
    const updated = generateWikiPage(db, config, owner, logger);
    if (updated) pagesUpdated++;
  }

  // Update the topic index
  updateTopicIndex(db, config);

  return pagesUpdated;
}

/**
 * Generates (or updates) a wiki page for an owner.
 */
function generateWikiPage(
  db: Database.Database,
  config: PluginConfig,
  owner: { owner_type: string; owner_id: string },
  logger: any
): boolean {
  // Determine page path
  const subDir =
    owner.owner_type === "group"
      ? "groups"
      : owner.owner_type === "global"
        ? "concepts"
        : "entities";
  const fileName = `${owner.owner_id.toLowerCase().replace(/\s+/g, "_")}.md`;
  const filePath = path.join(config.wikiPath, subDir, fileName);

  // Load facts for this owner
  const facts = db
    .prepare(
      `SELECT text, fact_type, topics, confidence, created_at, updated_at
       FROM facts
       WHERE is_active = 1
         AND owner_type = ?
         AND owner_id = ?
       ORDER BY fact_type, updated_at DESC`
    )
    .all(owner.owner_type, owner.owner_id) as Array<{
    text: string;
    fact_type: string;
    topics: string;
    confidence: number;
    created_at: string;
    updated_at: string;
  }>;

  if (facts.length === 0) return false;

  // Generate markdown content
  const now = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    `---`,
    `title: ${owner.owner_id}`,
    `updated: ${now}`,
    `owner_type: ${owner.owner_type}`,
    `auto_generated: true`,
    `---`,
    ``,
    `# ${owner.owner_id}`,
    ``,
  ];

  // Group by fact_type
  const grouped: Record<string, typeof facts> = {};
  for (const fact of facts) {
    const group = grouped[fact.fact_type] || [];
    group.push(fact);
    grouped[fact.fact_type] = group;
  }

  // Rules first (most important)
  if (grouped["rule"]) {
    lines.push(`## Rules`);
    for (const fact of grouped["rule"]) {
      lines.push(`- ${fact.text}`);
    }
    lines.push(``);
  }

  // Preferences
  if (grouped["preference"]) {
    lines.push(`## Preferences`);
    for (const fact of grouped["preference"]) {
      lines.push(`- ${fact.text}`);
    }
    lines.push(``);
  }

  // Facts
  if (grouped["fact"]) {
    lines.push(`## Facts`);
    for (const fact of grouped["fact"]) {
      lines.push(`- ${fact.text}`);
    }
    lines.push(``);
  }

  // Episodes (temporary)
  if (grouped["episode"]) {
    lines.push(`## Recent episodes`);
    for (const fact of grouped["episode"]) {
      lines.push(`- ${fact.text} _(${fact.updated_at})_`);
    }
    lines.push(``);
  }

  // Write the file
  const content = lines.join("\n");
  const existingContent = safeReadFile(filePath);

  if (existingContent !== content) {
    fs.writeFileSync(filePath, content, "utf-8");
    logger.info(`[Dream REM] Wiki: ${subDir}/${fileName} updated`);
    return true;
  }

  return false; // No changes needed
}

/**
 * Updates topic-index.json — maps topics → wiki pages.
 * Used by recall to load relevant pages.
 */
function updateTopicIndex(
  db: Database.Database,
  config: PluginConfig
): void {
  // Load all active facts grouped by topic
  const facts = db
    .prepare(
      `SELECT DISTINCT topics, owner_type, owner_id FROM facts
       WHERE is_active = 1`
    )
    .all() as Array<{
    topics: string;
    owner_type: string;
    owner_id: string;
  }>;

  const index: Record<string, string[]> = {};

  for (const fact of facts) {
    const topics = jsonToTopics(fact.topics);
    const subDir =
      fact.owner_type === "group"
        ? "groups"
        : fact.owner_type === "global"
          ? "concepts"
          : "entities";
    const fileName = `${fact.owner_id.toLowerCase().replace(/\s+/g, "_")}.md`;
    const pagePath = `${subDir}/${fileName}`;

    for (const topic of topics) {
      const pages = index[topic] || [];
      if (!pages.includes(pagePath)) {
        pages.push(pagePath);
      }
      index[topic] = pages;
    }
  }

  const indexPath = path.join(config.wikiPath, "_meta", "topic-index.json");
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// MEMORY.md
// ---------------------------------------------------------------------------

/**
 * Updates MEMORY.md with operational rules.
 * Only facts with fact_type="rule" are included.
 */
function updateMemoryMd(
  db: Database.Database,
  config: PluginConfig,
  logger: any
): boolean {
  const rules = db
    .prepare(
      `SELECT text, owner_id, updated_at FROM facts
       WHERE is_active = 1 AND fact_type = 'rule'
       ORDER BY owner_id, updated_at DESC`
    )
    .all() as Array<{ text: string; owner_id: string; updated_at: string }>;

  if (rules.length === 0) return false;

  const lines: string[] = [
    `# MEMORY.md — Operational rules`,
    ``,
    `> Auto-generated by the Dream REM engine. Do not edit manually.`,
    `> Last updated: ${new Date().toISOString().split("T")[0]}`,
    ``,
  ];

  // Group by owner
  const byOwner: Record<string, Array<{ text: string; updated_at: string }>> =
    {};
  for (const rule of rules) {
    const group = byOwner[rule.owner_id] || [];
    group.push(rule);
    byOwner[rule.owner_id] = group;
  }

  for (const [ownerId, ownerRules] of Object.entries(byOwner)) {
    lines.push(`## ${ownerId}`);
    for (const rule of ownerRules) {
      lines.push(`- ${rule.text}`);
    }
    lines.push(``);
  }

  const content = lines.join("\n");
  const memoryPath = path.join(path.dirname(config.dbPath), "MEMORY.md");
  const existing = safeReadFile(memoryPath);

  if (existing !== content) {
    fs.writeFileSync(memoryPath, content, "utf-8");
    logger.info("[Dream REM] MEMORY.md updated");
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Archive compression
// ---------------------------------------------------------------------------

/**
 * Compresses archive messages older than 6 months.
 * Groups by week and replaces with a summary.
 *
 * NOTE: for now, simply deletes old messages.
 * Weekly summaries will be implemented when needed
 * (requires an LLM call and is not urgent).
 */
function compressOldArchive(db: Database.Database, logger: any): number {
  const result = db
    .prepare(
      `DELETE FROM session_archive
       WHERE timestamp < datetime('now', '-6 months')`
    )
    .run();

  if (result.changes > 0) {
    logger.info(
      `[Dream REM] Archive: ${result.changes} messages >6 months removed`
    );
  }

  return result.changes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Gets unpromoted captures */
function getPendingCaptures(db: Database.Database): SessionCapture[] {
  return db
    .prepare(
      `SELECT * FROM session_captures
       WHERE promoted = 0
       ORDER BY captured_at ASC`
    )
    .all() as SessionCapture[];
}

/** Reads a file safely (null if not found) */
function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Saves the dream report as a markdown file */
function saveDreamReport(config: PluginConfig, report: DreamReport): void {
  const reportDir = path.join(path.dirname(config.dbPath), "dream-reports");
  fs.mkdirSync(reportDir, { recursive: true });

  const date = new Date().toISOString().split("T")[0];
  const filePath = path.join(reportDir, `dream-${report.type}-${date}.md`);

  const content = [
    `# Dream Report — ${report.type} — ${date}`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Type | ${report.type} |`,
    `| Started | ${report.startedAt} |`,
    `| Completed | ${report.completedAt} |`,
    `| Captures processed | ${report.capturesProcessed} |`,
    `| Facts created | ${report.factsCreated} |`,
    `| Facts superseded | ${report.factsSuperseded} |`,
    `| Facts de-duplicated | ${report.factsDeduplicated} |`,
    `| Facts decayed | ${report.factsDecayed} |`,
    `| Wiki pages updated | ${report.wikiPagesUpdated} |`,
    `| MEMORY.md | ${report.memoryMdUpdated ? "updated" : "unchanged"} |`,
    `| Archive compressed | ${report.archiveCompressed} |`,
    ``,
  ].join("\n");

  if (report.errors.length > 0) {
    const errorsSection = [
      `## Errors`,
      ...report.errors.map((e) => `- ${e}`),
      ``,
    ].join("\n");
    fs.writeFileSync(filePath, content + errorsSection, "utf-8");
  } else {
    fs.writeFileSync(filePath, content, "utf-8");
  }
}
