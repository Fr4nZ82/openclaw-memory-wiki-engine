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

  const { topicsToJson, generateFactId } = await import("./utils");

  for (const fact of facts) {
    if (!fact.text) continue;

    const factId = generateFactId();

    db.prepare(
      `INSERT OR REPLACE INTO facts
        (id, owner_type, owner_id, text, fact_type, topics, confidence, source, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
    ).run(
      factId,
      fact.owner_type || "global",
      fact.owner_id || "system",
      fact.text,
      fact.fact_type || "fact",
      topicsToJson(fact.topics || ["ingest"]),
      fact.confidence || 0.9,
      `ingest:${fileName}`
    );
  }

  logger.info(`[Wiki Ingest] ${fileName}: ${facts.length} facts imported directly into permanent memory`);
}

/**
 * Processes a text file (MD/TXT).
 *
 * Moves the raw file into the wiki/attachments/ directory,
 * reads its content, and asks the LLM to produce a single summary fact
 * pointing to the attachment. This prevents database pollution with
 * raw text while keeping the document referenced in active memory.
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
  const attachmentsDir = path.join(config.wikiPath, "attachments");
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  const attachmentPath = path.join(attachmentsDir, fileName);
  fs.writeFileSync(attachmentPath, content, "utf-8");
  logger.info(`[Wiki Ingest] ${fileName} moved to attachments/`);

  if (api.llmTask || api.callTool) {
    const prompt = `You are an archivist. Read the following text excerpt from a document named "${fileName}".
Write ONE single comprehensive fact (max 2-3 sentences) summarizing what this document is about and noting that it has been saved as an attachment. 
Assign 1-2 relevant topics.

Text excerpt:
"""
${content.substring(0, 8000)}
"""

Respond ONLY with a valid JSON array containing exactly one object:
[{"text": "I read the document X. It talks about Y. The full file is saved in attachments/Z.", "fact_type": "fact", "topics": ["..."], "owner_id": "system"}]`;

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

      // We still use processJsonIngest to actually save this summary fact,
      // which will now go directly into the facts table.
      await processJsonIngest(db, config, extracted, fileName + "_summary", result, logger);
      
    } catch (error) {
      result.errors.push(`${fileName}: LLM extraction failed: ${error}`);
    }
  } else {
    result.errors.push(`${fileName}: LLM not available for summary extraction`);
  }
}

// ---------------------------------------------------------------------------
// /wiki-init
// ---------------------------------------------------------------------------

/**
 * Bootstraps initial knowledge from workspace files (MEMORY.md, USER.md, memory/).
 * Replaces the legacy scripts/init.ts utility.
 */
export async function wikiInit(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<{ success: boolean; message: string }> {
  // Check enrollment
  const users = db.prepare("SELECT sender_id, names FROM users").all() as Array<{sender_id: string, names: string}>;
  if (users.length === 0) {
    return { success: false, message: "❌ No users enrolled. Define users in USERS.md first." };
  }
  const knownUsers = users.map((u) => {
    const names = JSON.parse(u.names) as string[];
    return { sender_id: u.sender_id, canonical: names[0] || u.sender_id, names };
  });

  const groups = db.prepare("SELECT group_id, group_name, scope FROM groups").all() as Array<{ group_id: string; group_name: string; scope: string }>;

  // Resolve workspace
  const workspacePath = (api?.config?.workspaceDir ?? api?.config?.workspace?.dir ?? path.join(process.env.OPENCLAW_HOME || path.join(require("os").homedir(), ".openclaw"), "workspace"));

  // Read files
  const userMdPath = path.join(workspacePath, "USER.md");
  const memoryMdPath = path.join(workspacePath, "MEMORY.md");
  const memoryDirPath = path.join(workspacePath, "memory");

  const parts: string[] = [];
  if (fs.existsSync(userMdPath)) parts.push(`## FILE: USER.md\n\n${fs.readFileSync(userMdPath, "utf-8")}`);
  if (fs.existsSync(memoryMdPath)) parts.push(`## FILE: MEMORY.md\n\n${fs.readFileSync(memoryMdPath, "utf-8")}`);
  
  if (fs.existsSync(memoryDirPath) && fs.statSync(memoryDirPath).isDirectory()) {
    const files = fs.readdirSync(memoryDirPath).filter(f => f.endsWith(".md")).sort();
    for (const f of files) {
      const c = fs.readFileSync(path.join(memoryDirPath, f), "utf-8");
      if (c.length > 200) {
        const truncated = c.length > 5000 ? c.substring(0, 5000) + "\n...(truncated)" : c;
        parts.push(`## FILE: memory/${f}\n\n${truncated}`);
      }
    }
  }

  if (parts.length === 0) {
    return { success: true, message: "ℹ️ No workspace files to process." };
  }

  const usersList = knownUsers.map((u) => `- ${u.canonical} (aliases: ${u.names.join(", ")}, sender_id: ${u.sender_id})`).join("\n");
  const groupsList = groups.length > 0 ? groups.map(g => `- ${g.group_id} (${g.group_name})`).join("\n") : "- no groups";

  const prompt = `You are a fact extractor for a multi-user AI assistant's memory system.
## Known users
${usersList}
## Known groups
${groupsList}
## Workspace files
${parts.join("\n\n---\n\n")}
## Instructions
Extract ALL structured facts from these files. Focus on: Biographical data, Preferences, Rules, Relationships, Medical, Episodes, Plans.
Do NOT extract: System configuration, Technical details, The assistant's personality.

Respond ONLY with a JSON array:
[
  { "fact_text": "...", "fact_type": "fact", "owner_type": "user", "owner_id": "frodo", "topics": ["..."], "confidence": 1.0 }
]
Rules for owner_id: Use CANONICAL NAME for users, group_id for groups, "global" for system rules.`;

  logger.info("[Wiki Init] Calling LLM for bootstrap extraction...");
  let response: string;
  try {
    if (api.llmTask) {
      response = await api.llmTask({ prompt, model: "flash", responseFormat: "json" });
    } else {
      response = await api.callTool("llm-task", { prompt, model: "flash" });
    }
  } catch (err) {
    return { success: false, message: `❌ LLM extraction failed: ${err}` };
  }

  const extracted = typeof response === "string" ? response : JSON.stringify(response);
  let facts: any[];
  try {
    const start = extracted.indexOf("[");
    const end = extracted.lastIndexOf("]");
    facts = JSON.parse(extracted.substring(start, end + 1));
  } catch {
    return { success: false, message: "❌ LLM returned malformed JSON" };
  }

  const { generateFactId, topicsToJson } = await import("./utils");
  const { generateEmbedding } = await import("./embedding");

  let factsInserted = 0;
  for (const f of facts) {
    if (!f.fact_text) continue;
    const factId = generateFactId();
    let embeddingBuffer: Buffer | null = null;
    try {
      const emb = await generateEmbedding(f.fact_text, config);
      embeddingBuffer = Buffer.from(new Float32Array(emb).buffer);
    } catch { /* ignore */ }

    db.prepare(
      `INSERT INTO facts (id, owner_type, owner_id, text, fact_type, topics, embedding, confidence, source, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bootstrap', 1, datetime('now'), datetime('now'))`
    ).run(
      factId, f.owner_type || "global", f.owner_id || "system", f.fact_text, f.fact_type || "fact",
      topicsToJson(f.topics || []), embeddingBuffer, f.confidence || 0.9
    );
    factsInserted++;
  }

  // Backup
  const backupDir = path.join(workspacePath, ".memory-backup");
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(memoryMdPath)) {
    fs.copyFileSync(memoryMdPath, path.join(backupDir, "MEMORY.md"));
    fs.unlinkSync(memoryMdPath);
  }
  if (fs.existsSync(memoryDirPath)) {
    const backupMemDir = path.join(backupDir, "memory");
    fs.mkdirSync(backupMemDir, { recursive: true });
    for (const file of fs.readdirSync(memoryDirPath)) {
      fs.copyFileSync(path.join(memoryDirPath, file), path.join(backupMemDir, file));
    }
    fs.rmSync(memoryDirPath, { recursive: true });
  }

  return { success: true, message: `✅ Bootstrap complete! Inserted ${factsInserted} facts and backed up legacy files.` };
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
