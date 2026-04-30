/**
 * wiki-manager.ts — Auto-generated wiki management
 *
 * Module for wiki operations beyond the automatic dream:
 *
 *   - /wiki-ingest  → digests material from the raw/ folder
 *   - /wiki-lint    → health check (stale, orphans, gaps)
 *   - /wiki-sync    → updates wiki from recent facts
 *
 * The wiki lives in ~/.openclaw/wiki-engine/wiki/ with this structure:
 *
 *   wiki/
 *   ├── entities/     — one page per person/entity
 *   ├── groups/       — one page per group (e.g. family)
 *   ├── concepts/     — one page per concept (e.g. cooking, sports)
 *   └── _meta/
 *       └── topic-index.json — maps topics → pages
 */

import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import { jsonToTopics } from "./utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of an ingest operation */
export interface IngestResult {
  filesProcessed: number;
  pagesCreated: number;
  pagesUpdated: number;
  errors: string[];
}

/** An issue found by lint */
export interface LintIssue {
  severity: "error" | "warning" | "info";
  page: string;
  message: string;
}

/** Lint result */
export interface LintReport {
  totalPages: number;
  issues: LintIssue[];
  stalePages: number;
  orphanPages: number;
  emptyPages: number;
  missingTopicIndex: boolean;
}

/** Wiki status */
export interface WikiStatus {
  totalPages: number;
  entitiesCount: number;
  groupsCount: number;
  conceptsCount: number;
  topicIndexSize: number;
  lastUpdated: string | null;
  diskSizeBytes: number;
}

// ---------------------------------------------------------------------------
// /wiki-ingest — Digests material from the raw/ folder
// ---------------------------------------------------------------------------

/**
 * Processes all files in the raw/ folder and transforms them into
 * wiki pages or facts in the database.
 *
 * Supported formats:
 *   - .md   → read directly, content extracted
 *   - .txt  → read directly
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

  // Read files in the raw/ folder
  let files: string[];
  try {
    files = fs.readdirSync(config.rawPath);
  } catch {
    result.errors.push("raw/ folder not found or not readable");
    return result;
  }

  // Filter only supported formats
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
        // JSON: expects an array of structured facts
        await processJsonIngest(db, config, content, fileName, result, logger);
      } else {
        // MD/TXT: extract content and create/update wiki page
        await processTextIngest(
          api,
          db,
          config,
          content,
          fileName,
          result,
          logger
        );
      }

      // Mark file as processed (append .ingested to name)
      const processedMarker = filePath + ".ingested";
      if (!fs.existsSync(processedMarker)) {
        fs.writeFileSync(
          processedMarker,
          new Date().toISOString(),
          "utf-8"
        );
      }
    } catch (error) {
      result.errors.push(`${fileName}: ${error}`);
    }
  }

  // Update the topic-index after ingest
  updateTopicIndexFromDb(db, config);

  logger.info(
    `[Wiki Ingest] Complete — ${result.filesProcessed} files, ` +
      `${result.pagesCreated} pages created, ${result.pagesUpdated} updated`
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

  const { generateFactId, topicsToJson } = await import("./utils");

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
  // If the file is short, save directly as a wiki concept page
  if (content.length < 2000) {
    const pageName = path
      .basename(fileName, path.extname(fileName))
      .toLowerCase()
      .replace(/\s+/g, "_");
    const pagePath = path.join(config.wikiPath, "concepts", `${pageName}.md`);

    const now = new Date().toISOString().split("T")[0];
    const wikiContent = [
      "---",
      `title: ${pageName}`,
      `updated: ${now}`,
      `source: raw/${fileName}`,
      "auto_generated: true",
      "---",
      "",
      `# ${pageName}`,
      "",
      content,
      "",
    ].join("\n");

    const existed = fs.existsSync(pagePath);
    fs.writeFileSync(pagePath, wikiContent, "utf-8");

    if (existed) {
      result.pagesUpdated++;
    } else {
      result.pagesCreated++;
    }

    logger.info(
      `[Wiki Ingest] ${fileName} → concepts/${pageName}.md (${existed ? "updated" : "created"})`
    );
    return;
  }

  // For long files: use the LLM to extract facts
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
    // No LLM available: save content as raw wiki page
    const pageName = path
      .basename(fileName, path.extname(fileName))
      .toLowerCase()
      .replace(/\s+/g, "_");
    const pagePath = path.join(config.wikiPath, "concepts", `${pageName}.md`);

    const now = new Date().toISOString().split("T")[0];
    const wikiContent = [
      "---",
      `title: ${pageName}`,
      `updated: ${now}`,
      `source: raw/${fileName}`,
      "auto_generated: true",
      "confidence: low",
      "---",
      "",
      `# ${pageName}`,
      "",
      "> Content imported from raw/ without LLM extraction. May need review.",
      "",
      content.substring(0, 5000),
      "",
    ].join("\n");

    const existed = fs.existsSync(pagePath);
    fs.writeFileSync(pagePath, wikiContent, "utf-8");
    existed ? result.pagesUpdated++ : result.pagesCreated++;
  }
}

// ---------------------------------------------------------------------------
// /wiki-lint — Health check
// ---------------------------------------------------------------------------

/**
 * Scans the wiki for problems:
 *   - Stale pages (not updated in >30 days with recent facts)
 *   - Orphan pages (no facts in DB reference them)
 *   - Empty pages (frontmatter only, no content)
 *   - Missing or empty topic-index.json
 *   - Facts without a wiki page (potential gap)
 */
export function wikiLint(
  db: Database.Database,
  config: PluginConfig
): LintReport {
  const report: LintReport = {
    totalPages: 0,
    issues: [],
    stalePages: 0,
    orphanPages: 0,
    emptyPages: 0,
    missingTopicIndex: false,
  };

  // Scan all wiki pages
  const wikiPages = scanWikiPages(config.wikiPath);
  report.totalPages = wikiPages.length;

  // Load all owners with active facts in the DB
  const activeOwners = new Set<string>();
  const ownerRows = db
    .prepare(
      `SELECT DISTINCT owner_type || ':' || owner_id as key
       FROM facts WHERE is_active = 1`
    )
    .all() as Array<{ key: string }>;
  for (const row of ownerRows) {
    activeOwners.add(row.key);
  }

  // Check each page
  for (const page of wikiPages) {
    const filePath = path.join(config.wikiPath, page.relativePath);
    const content = fs.readFileSync(filePath, "utf-8");

    // Empty page?
    const bodyContent = content.replace(/^---[\s\S]*?---\s*/, "").trim();
    if (bodyContent.length < 20) {
      report.issues.push({
        severity: "warning",
        page: page.relativePath,
        message: "Page is empty or nearly empty",
      });
      report.emptyPages++;
    }

    // Stale page? (check updated in frontmatter)
    const updatedMatch = content.match(/updated:\s*(\d{4}-\d{2}-\d{2})/);
    if (updatedMatch) {
      const updated = new Date(updatedMatch[1]);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      if (updated < thirtyDaysAgo) {
        report.issues.push({
          severity: "info",
          page: page.relativePath,
          message: `Not updated since ${updatedMatch[1]} (>30 days)`,
        });
        report.stalePages++;
      }
    }

    // Orphan page? (no corresponding owner in DB)
    const ownerKey = inferOwnerFromPath(page.relativePath);
    if (ownerKey && !activeOwners.has(ownerKey)) {
      report.issues.push({
        severity: "warning",
        page: page.relativePath,
        message: `Orphan — no active facts for ${ownerKey}`,
      });
      report.orphanPages++;
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

  // Facts without wiki page (gap)
  for (const ownerKey of activeOwners) {
    const hasPage = wikiPages.some(
      (p) => inferOwnerFromPath(p.relativePath) === ownerKey
    );
    if (!hasPage) {
      const [ownerType, ownerId] = ownerKey.split(":");
      const factCount = db
        .prepare(
          `SELECT COUNT(*) as c FROM facts
           WHERE is_active = 1 AND owner_type = ? AND owner_id = ?`
        )
        .get(ownerType, ownerId) as { c: number };

      // Only report if there are enough facts for a page
      if (factCount.c >= 3) {
        report.issues.push({
          severity: "info",
          page: `(missing)`,
          message: `${ownerId} has ${factCount.c} active facts but no wiki page`,
        });
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// /wiki-sync — Updates wiki from recent facts
// ---------------------------------------------------------------------------

/**
 * Incremental wiki update based on recent facts.
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
// Archive search
// ---------------------------------------------------------------------------

/**
 * Searches raw transcripts in the session archive.
 * Uses FTS5 for full-text search. Last-resort fallback
 * when facts and wiki have no results.
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
  // Prepare FTS query
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
      .all(ftsQuery, limit) as Array<{
      session_id: string;
      sender_name: string | null;
      message_text: string;
      role: string;
      timestamp: string;
    }>;
  } catch {
    // Malformed FTS query, fallback to LIKE
    return db
      .prepare(
        `SELECT session_id, sender_name, message_text, role, timestamp
         FROM session_archive
         WHERE message_text LIKE ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(`%${query}%`, limit) as Array<{
      session_id: string;
      sender_name: string | null;
      message_text: string;
      role: string;
      timestamp: string;
    }>;
  }
}

// ---------------------------------------------------------------------------
// Wiki status
// ---------------------------------------------------------------------------

/**
 * Returns the current wiki status.
 */
export function getWikiStatus(
  config: PluginConfig
): WikiStatus {
  const status: WikiStatus = {
    totalPages: 0,
    entitiesCount: 0,
    groupsCount: 0,
    conceptsCount: 0,
    topicIndexSize: 0,
    lastUpdated: null,
    diskSizeBytes: 0,
  };

  const pages = scanWikiPages(config.wikiPath);
  status.totalPages = pages.length;

  for (const page of pages) {
    const filePath = path.join(config.wikiPath, page.relativePath);

    if (page.relativePath.startsWith("entities/")) status.entitiesCount++;
    else if (page.relativePath.startsWith("groups/")) status.groupsCount++;
    else if (page.relativePath.startsWith("concepts/")) status.conceptsCount++;

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
// Helpers
// ---------------------------------------------------------------------------

/** Type for a found wiki page */
interface WikiPageInfo {
  relativePath: string;
  fileName: string;
}

/**
 * Recursively scans the wiki folder for .md pages.
 * Ignores _meta/ and hidden files.
 */
function scanWikiPages(wikiPath: string): WikiPageInfo[] {
  const pages: WikiPageInfo[] = [];

  function scan(dir: string, prefix: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Ignore _meta and hidden files
      if (entry.startsWith("_") || entry.startsWith(".")) continue;

      const fullPath = path.join(dir, entry);
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

  scan(wikiPath, "");
  return pages;
}

/**
 * Infers owner_type:owner_id from a wiki page path.
 *
 * entities/alice.md → "user:alice"
 * groups/family.md → "group:family"
 * concepts/cooking.md → "global:cooking"
 */
function inferOwnerFromPath(relativePath: string): string | null {
  const parts = relativePath.split("/");
  if (parts.length < 2) return null;

  const dir = parts[0];
  const name = path.basename(parts[parts.length - 1], ".md");

  const typeMap: Record<string, string> = {
    entities: "user",
    groups: "group",
    concepts: "global",
  };

  const ownerType = typeMap[dir];
  if (!ownerType) return null;

  return `${ownerType}:${name}`;
}

/**
 * Updates topic-index.json from the database.
 * Identical to the function in dream, extracted here for reuse.
 */
function updateTopicIndexFromDb(
  db: Database.Database,
  config: PluginConfig
): void {
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

  const metaDir = path.join(config.wikiPath, "_meta");
  fs.mkdirSync(metaDir, { recursive: true });
  const indexPath = path.join(metaDir, "topic-index.json");
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");

  // Genera index.md
  generateHumanIndex(config);
}

/**
 * Generates the human-readable index.md file from the topic-index.json.
 * Extracts the "description" from the frontmatter of each markdown file to use as a summary.
 */
function generateHumanIndex(config: PluginConfig): void {
  const indexPath = path.join(config.wikiPath, "_meta", "topic-index.json");
  if (!fs.existsSync(indexPath)) return;

  const topicIndex: Record<string, string[]> = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  
  const lines: string[] = [
    `---`,
    `title: Wiki Index`,
    `updated: ${new Date().toISOString().split("T")[0]}`,
    `auto_generated: true`,
    `---`,
    ``,
    `# Indice dei Contenuti`,
    `_Questo file è generato automaticamente dal Wiki Compiler._`,
    ``,
  ];

  for (const [topic, pages] of Object.entries(topicIndex).sort()) {
    // Escludi i topic blacklisted operativi
    if (["chat", "general", "saluto", "sistema", "debug", "wiki_edit"].includes(topic)) continue;

    lines.push(`## Topic: ${topic}`);
    
    for (const pagePath of pages) {
      const fullPath = path.join(config.wikiPath, pagePath);
      const slug = path.basename(pagePath, ".md");
      let desc = "Nessuna descrizione";
      let title = slug;
      
      const content = safeReadFile(fullPath);
      if (content) {
        const descMatch = content.match(/^description:\s*["']?([^"'\n]+)["']?/m);
        if (descMatch) desc = descMatch[1];
        
        const titleMatch = content.match(/^title:\s*["']?([^"'\n]+)["']?/m);
        if (titleMatch) title = titleMatch[1];
      }
      
      lines.push(`- [[${slug}|${title}]] - *${desc}*`);
    }
    lines.push("");
  }

  const humanIndexPath = path.join(config.wikiPath, "index.md");
  fs.writeFileSync(humanIndexPath, lines.join("\n"), "utf-8");
}

/** Reads a file safely (null if not found) */
function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
