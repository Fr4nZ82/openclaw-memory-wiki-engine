/**
 * wiki-manager.ts — Topic-driven wiki management
 *
 * Module for wiki operations beyond the automatic dream:
 *   - /wiki-ingest  → digests material from the raw/ folder
 *   - /wiki-lint    → health check (stale, empty)
 *   - /wiki-sync    → updates wiki from recent facts
 *
 * The wiki lives in ~/.openclaw/wiki-engine/wiki/ with this structure:
 *
 *   wiki/
 *   ├── pages/        — unified flat directory for all topics
 *   ├── .shadow/      — shadow diffs for obsidian bi-directionality
 *   └── _meta/
 *       └── topic-index.json — maps topics → pages
 */

import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestResult {
  filesProcessed: number;
  pagesCreated: number;
  pagesUpdated: number;
  errors: string[];
}

export interface LintIssue {
  severity: "error" | "warning" | "info";
  page: string;
  message: string;
}

export interface LintReport {
  totalPages: number;
  issues: LintIssue[];
  stalePages: number;
  emptyPages: number;
  missingTopicIndex: boolean;
}

export interface WikiStatus {
  totalPages: number;
  topicIndexSize: number;
  lastUpdated: string | null;
  diskSizeBytes: number;
}

// ---------------------------------------------------------------------------
// /wiki-ingest
// ---------------------------------------------------------------------------

/**
 * Processes all files in the raw/ folder and transforms them into
 * wiki pages or facts in the database.
 *
 * Supported formats:
 *   - .md   → read directly, facts extracted via LLM
 *   - .txt  → read directly, facts extracted via LLM
 *   - .json → parsed as array of structured facts
 *
 * Material in raw/ is NOT deleted after ingest —
 * it stays as a reference for future verification.
 */
export async function wikiIngest(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<IngestResult> {
  const result: IngestResult = {
    filesProcessed: 0,
    pagesCreated: 0,
    pagesUpdated: 0,
    errors: [],
  };

  let files: string[];
  try {
    files = fs.readdirSync(config.rawPath);
  } catch {
    result.errors.push("raw/ folder not found or not readable");
    return result;
  }

  const supportedExtensions = [".md", ".txt", ".json"];
  const targetFiles = files.filter((f) =>
    supportedExtensions.includes(path.extname(f).toLowerCase())
  );

  if (targetFiles.length === 0) {
    logger.info("[Wiki Ingest] No files to process in raw/");
    return result;
  }

  for (const fileName of targetFiles) {
    try {
      const filePath = path.join(config.rawPath, fileName);
      const content = fs.readFileSync(filePath, "utf-8");
      result.filesProcessed++;

      const ext = path.extname(fileName).toLowerCase();

      if (ext === ".json") {
        await processJsonIngest(db, config, content, fileName, result, logger);
      } else {
        await processTextIngest(api, db, config, content, fileName, result, logger);
      }

      const processedMarker = filePath + ".ingested";
      if (!fs.existsSync(processedMarker)) {
        fs.writeFileSync(processedMarker, new Date().toISOString(), "utf-8");
      }
    } catch (error) {
      result.errors.push(`${fileName}: ${error}`);
    }
  }

  logger.info(
    `[Wiki Ingest] Complete — ${result.filesProcessed} files processed`
  );

  return result;
}

/**
 * Processes a JSON file of structured facts.
 *
 * Expected format:
 * [
 *   { "text": "...", "fact_type": "fact", "topics": ["..."], "owner_id": "..." },
 *   ...
 * ]
 */
async function processJsonIngest(
  db: Database.Database,
  config: PluginConfig,
  content: string,
  fileName: string,
  result: IngestResult,
  logger: any
): Promise<void> {
  let facts: any[];
  try {
    facts = JSON.parse(content);
    if (!Array.isArray(facts)) facts = [facts];
  } catch {
    result.errors.push(`${fileName}: malformed JSON`);
    return;
  }

  const { topicsToJson } = await import("./utils");

  for (const fact of facts) {
    if (!fact.text) continue;

    db.prepare(
      `INSERT INTO session_captures
        (session_id, message_text, fact_text, topics, sender_id,
         owner_type, owner_id, fact_type, is_internal, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`
    ).run(
      "ingest",
      `ingest:${fileName}`,
      fact.text,
      topicsToJson(fact.topics || ["ingest"]),
      "system",
      fact.owner_type || "global",
      fact.owner_id || "system",
      fact.fact_type || "fact"
    );
  }

  logger.info(`[Wiki Ingest] ${fileName}: ${facts.length} facts imported as captures`);
}

/**
 * Processes a text file (MD/TXT).
 *
 * Uses the LLM to extract relevant facts from text, then saves
 * them as captures that will be promoted by the dream.
 */
async function processTextIngest(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  content: string,
  fileName: string,
  result: IngestResult,
  logger: any
): Promise<void> {
  // Use the LLM to extract facts for ALL text files now
  if (api.llmTask || api.callTool) {
    const prompt = `Extract the important facts from the following text. For each fact:
- Rephrase in third person
- Classify as: fact, preference, rule, or episode
- Assign 1-2 topics

Text:
"""
${content.substring(0, 8000)}
"""

Respond with a JSON array:
[{"text": "...", "fact_type": "fact", "topics": ["..."], "owner_id": "system"}]`;

    try {
      let response: string;
      if (api.llmTask) {
        response = await api.llmTask({
          prompt,
          model: "flash",
          responseFormat: "json",
        });
      } else {
        response = await api.callTool("llm-task", { prompt, model: "flash" });
      }

      const extracted =
        typeof response === "string" ? response : JSON.stringify(response);
      await processJsonIngest(db, config, extracted, fileName, result, logger);
    } catch (error) {
      result.errors.push(`${fileName}: LLM extraction failed: ${error}`);
    }
  } else {
    result.errors.push(`${fileName}: LLM not available for extraction`);
  }
}

// ---------------------------------------------------------------------------
// /wiki-lint
// ---------------------------------------------------------------------------

/**
 * Scans the wiki to identify health issues.
 * Checks for:
 *   - Empty pages (<20 characters)
 *   - Stale pages (not updated in 30+ days)
 *   - Missing or empty topic-index.json
 */
export async function wikiLint(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<LintReport> {
  const report: LintReport = {
    totalPages: 0,
    issues: [],
    stalePages: 0,
    emptyPages: 0,
    missingTopicIndex: false,
  };

  const pagesPath = path.join(config.wikiPath, "pages");
  if (!fs.existsSync(pagesPath)) {
    return report;
  }

  const wikiPages = scanWikiPages(pagesPath);
  report.totalPages = wikiPages.length;

  for (const page of wikiPages) {
    const filePath = path.join(pagesPath, page.fileName);
    const content = fs.readFileSync(filePath, "utf-8");

    // Empty page?
    const bodyContent = content.replace(/^---[\s\S]*?---\s*/, "").trim();
    if (bodyContent.length < 20) {
      report.issues.push({
        severity: "warning",
        page: page.fileName,
        message: "Page is empty or nearly empty",
      });
      report.emptyPages++;
    }

    // Stale page? (check updated in frontmatter)
    const updatedMatch = content.match(/updated:\s*"?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?)"?/);
    if (updatedMatch) {
      const updated = new Date(updatedMatch[1]);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      if (updated < thirtyDaysAgo) {
        report.issues.push({
          severity: "info",
          page: page.fileName,
          message: `Not updated since ${updatedMatch[1]} (>30 days)`,
        });
        report.stalePages++;
      }
    }
  }

  // topic-index.json
  const indexPath = path.join(config.wikiPath, "_meta", "topic-index.json");
  if (!fs.existsSync(indexPath)) {
    report.issues.push({
      severity: "error",
      page: "_meta/topic-index.json",
      message: "Missing — topic-based search will not work",
    });
    report.missingTopicIndex = true;
  } else {
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      if (Object.keys(index).length === 0) {
        report.issues.push({
          severity: "warning",
          page: "_meta/topic-index.json",
          message: "Empty — no topics mapped",
        });
      }
    } catch {
      report.issues.push({
        severity: "error",
        page: "_meta/topic-index.json",
        message: "Malformed JSON",
      });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// /wiki-sync
// ---------------------------------------------------------------------------

/**
 * Incremental wiki update based on recent facts.
 *
 * Differs from full dream REM because:
 *   - No de-duplication or decay of old captures
 *   - Specifically triggers the updateWikiPages compiler logic
 *   - Designed for manual triggering when immediate propagation is needed
 */
export async function wikiSync(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<{ pagesUpdated: number; topicIndexUpdated: boolean }> {
  const { updateWikiPages } = await import("./dream");
  const pagesUpdated = await updateWikiPages(api, db, config, logger);
  
  logger.info(`[Wiki Sync] ${pagesUpdated} pages updated`);
  return { pagesUpdated, topicIndexUpdated: true };
}

// ---------------------------------------------------------------------------
// /wiki-status
// ---------------------------------------------------------------------------

/**
 * Returns the current statistical status of the wiki.
 *
 * Scans the pages/ directory and the topic-index to calculate
 * total pages, disk size, and modification dates.
 */
export function getWikiStatus(
  config: PluginConfig
): WikiStatus {
  const status: WikiStatus = {
    totalPages: 0,
    topicIndexSize: 0,
    lastUpdated: null,
    diskSizeBytes: 0,
  };

  const pagesPath = path.join(config.wikiPath, "pages");
  if (!fs.existsSync(pagesPath)) {
    return status;
  }

  const pages = scanWikiPages(pagesPath);
  status.totalPages = pages.length;

  for (const page of pages) {
    const filePath = path.join(pagesPath, page.fileName);

    try {
      const stat = fs.statSync(filePath);
      status.diskSizeBytes += stat.size;

      const mtime = stat.mtime.toISOString();
      if (!status.lastUpdated || mtime > status.lastUpdated) {
        status.lastUpdated = mtime;
      }
    } catch { /* skip */ }
  }

  // Topic index
  const indexPath = path.join(config.wikiPath, "_meta", "topic-index.json");
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    status.topicIndexSize = Object.keys(index).length;
  } catch { /* missing or invalid */ }

  return status;
}

// ---------------------------------------------------------------------------
// searchArchive
// ---------------------------------------------------------------------------

/**
 * Performs a Full-Text Search (FTS) or fallback LIKE query
 * against the session_archive table.
 */
export function searchArchive(
  db: Database.Database,
  query: string,
  limit: number = 10
): Array<{
  session_id: string;
  sender_name: string | null;
  message_text: string;
  role: string;
  timestamp: string;
}> {
  const ftsQuery = query
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .join(" OR ");

  if (!ftsQuery) return [];

  try {
    return db
      .prepare(
        `SELECT a.session_id, a.sender_name, a.message_text, a.role, a.timestamp
         FROM archive_fts
         JOIN session_archive a ON archive_fts.rowid = a.rowid
         WHERE archive_fts MATCH ?
         ORDER BY bm25(archive_fts)
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<any>;
  } catch {
    return db
      .prepare(
        `SELECT session_id, sender_name, message_text, role, timestamp
         FROM session_archive
         WHERE message_text LIKE ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(`%${query}%`, limit) as Array<any>;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WikiPageInfo {
  relativePath: string;
  fileName: string;
}

/**
 * Recursively scans the wiki folder for .md pages.
 * Ignores _meta/ and hidden files.
 */
function scanWikiPages(dir: string): WikiPageInfo[] {
  const pages: WikiPageInfo[] = [];

  function scan(currentDir: string, prefix: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith("_") || entry.startsWith(".")) continue;

      const fullPath = path.join(currentDir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scan(fullPath, relativePath);
        } else if (entry.endsWith(".md")) {
          pages.push({ relativePath, fileName: entry });
        }
      } catch { /* skip */ }
    }
  }

  scan(dir, "");
  return pages;
}
