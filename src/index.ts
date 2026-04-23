/**
 * index.ts — Plugin entry point
 *
 * Registers all hooks, tools, and commands for the Memory Wiki Engine.
 * This file is the "wiring" — actual logic lives in specialized modules.
 *
 * Modules:
 *   config.ts     → configuration with defaults
 *   db.ts         → SQLite schema and initialization
 *   classifier.ts → message classification with Gemini Flash
 *   capture.ts    → capture pipeline (archive + classify + save)
 *   recall.ts     → context injection into the prompt
 *   embedding.ts  → Ollama client for vector embeddings
 *   supersede.ts  → fact supersedence logic
 *   dream.ts      → memory consolidation (light + REM)
 *
 * Registered hooks:
 *   - message_received    → captures user messages
 *   - message_sending     → archives assistant responses
 *   - before_prompt_build → injects context into the prompt
 *
 * Registered tools:
 *   - memory_search  — hybrid search (BM25 + vector) on facts + wiki
 *   - remember       — explicitly save a fact
 *
 * Registered commands:
 *   - /dream          — trigger manual dream
 *   - /memory-status  — memory statistics
 *   - /focus <topic>  — force session topic
 */

import type Database from "better-sqlite3";
import { resolveConfig, type PluginConfig } from "./config";
import { initDatabase, closeDatabase, topicsToJson } from "./db";
import {
  processUserMessage,
  processAssistantMessage,
  resetStatements,
  type IncomingMessage,
} from "./capture";
import { buildRecallContext } from "./recall";
import { dreamLight, dreamRem } from "./dream";
import {
  wikiIngest,
  wikiLint,
  wikiSync,
  searchArchive,
  getWikiStatus,
} from "./wiki-manager";

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let config: PluginConfig | null = null;
let dreamTimer: ReturnType<typeof setInterval> | null = null;
let remTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// OpenClaw entry point
// ---------------------------------------------------------------------------

/**
 * Main plugin function. OpenClaw calls this on load.
 *
 * `api` is the object provided by OpenClaw with methods to register
 * hooks, tools, commands, and compaction providers.
 */
export function activate(api: any): void {
  // Read plugin config (from openclaw.json) and merge with defaults
  const userConfig = api.getPluginConfig?.() ?? {};
  config = resolveConfig(userConfig);

  // Initialize the database (creates tables if needed)
  db = initDatabase(config);

  // Startup log
  const log = api.getLogger?.("memory-wiki-engine") ?? console;
  log.info(
    `[Memory Wiki Engine] Activated — DB: ${config.dbPath}, Wiki: ${config.wikiPath}`
  );

  // -------------------------------------------------------------------
  // Hook: message_received — capture user messages
  // -------------------------------------------------------------------

  if (api.on) {
    api.on("message_received", async (event: any) => {
      if (!db || !config) return;

      try {
        const message: IncomingMessage = {
          text: event.text || event.content || "",
          sender_id: extractSenderId(event.sessionKey),
          sender_name: event.senderName || event.sender_id || "unknown",
          session_id: event.sessionKey || "unknown",
          role: "user",
          timestamp: new Date().toISOString(),
        };

        // Skip empty messages
        if (!message.text.trim()) return;

        const stats = await processUserMessage(api, db, config, message);

        if (stats.captured) {
          log.info(
            `[Capture] ✅ "${message.text.substring(0, 40)}..." → ` +
              `topics: [${stats.classification?.topics.join(", ")}], ` +
              `type: ${stats.classification?.fact_type}`
          );
        } else if (stats.skipped_reason) {
          log.debug(
            `[Capture] ⏭ "${message.text.substring(0, 30)}..." — ${stats.skipped_reason}`
          );
        }
      } catch (error) {
        log.warn("[Capture] Error processing message:", error);
      }
    });

    // -------------------------------------------------------------------
    // Hook: message_sending — archive assistant responses
    // -------------------------------------------------------------------

    api.on("message_sending", (event: any) => {
      if (!db) return;

      try {
        const message: IncomingMessage = {
          text: event.text || event.content || "",
          sender_id: "assistant",
          sender_name: "Assistant",
          session_id: event.sessionKey || "unknown",
          role: "assistant",
          timestamp: new Date().toISOString(),
        };

        if (!message.text.trim()) return;

        processAssistantMessage(db, message, null);
      } catch (error) {
        log.warn("[Archive] Error archiving response:", error);
      }
    });

    // -------------------------------------------------------------------
    // Hook: before_prompt_build — context injection
    // -------------------------------------------------------------------

    api.on("before_prompt_build", async (event: any) => {
      if (!db || !config) return;

      try {
        const userQuery = event.lastUserMessage || event.text || "";
        const senderId = extractSenderId(event.sessionKey);
        const sessionId = event.sessionKey || "unknown";

        const recallCtx = await buildRecallContext(
          db,
          config,
          sessionId,
          userQuery,
          senderId
        );

        // Inject into system prompt
        if (event.addSystemContext) {
          event.addSystemContext(recallCtx.systemContext);
        }

        log.debug(
          `[Recall] ${recallCtx.estimatedTokens} tokens injected — ` +
            `wiki: ${recallCtx.details.wikiPagesMatched}, ` +
            `facts: ${recallCtx.details.factsMatched}, ` +
            `vector: ${recallCtx.details.vectorSearchUsed}`
        );
      } catch (error) {
        log.warn("[Recall] Error injecting context:", error);
        // Don't block the response if recall fails
      }
    });
  }

  // -------------------------------------------------------------------
  // Custom compaction provider
  // -------------------------------------------------------------------

  if (api.registerCompactionProvider) {
    api.registerCompactionProvider("wiki-engine-truncate", {
      async compact(
        messages: any[],
        options: { keepLastAssistants?: number }
      ): Promise<any[]> {
        const keepTurns = options.keepLastAssistants ?? config!.keepTurns;
        const keepMessages = keepTurns * 2;
        return messages.slice(-keepMessages);
      },
    });
    log.info("[Memory Wiki Engine] Compaction provider registered");
  }

  // -------------------------------------------------------------------
  // Tool: memory_search
  // -------------------------------------------------------------------

  if (api.registerTool) {
    api.registerTool("memory_search", {
      description:
        "Search the memory. Hybrid search (semantic + keyword) " +
        "on facts, wiki and session captures. Use this tool when you " +
        "need to recall something about a user, a past event, " +
        "or a preference.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for in memory",
          },
        },
        required: ["query"],
      },
      async execute(params: { query: string }, context: any) {
        if (!db || !config) return "Memory not initialized";

        const senderId = extractSenderId(context?.sessionKey);
        const recallCtx = await buildRecallContext(
          db,
          config,
          context?.sessionKey || "unknown",
          params.query,
          senderId
        );

        return recallCtx.systemContext || "No results found.";
      },
    });

    // -------------------------------------------------------------------
    // Tool: remember
    // -------------------------------------------------------------------

    api.registerTool("remember", {
      description:
        "Explicitly save a fact to memory. Use when a user says " +
        "'remember that...' or when you want to save something " +
        "important that might be useful in the future.",
      parameters: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description: "The fact to remember",
          },
          fact_type: {
            type: "string",
            enum: ["fact", "preference", "rule", "episode"],
            description: "Fact type",
            default: "fact",
          },
        },
        required: ["fact"],
      },
      async execute(
        params: { fact: string; fact_type?: string },
        context: any
      ) {
        if (!db || !config) return "Memory not initialized";

        const senderId = extractSenderId(context?.sessionKey);

        // Insert directly as capture (will be promoted by the dream)
        db.prepare(
          `INSERT INTO session_captures
            (session_id, message_text, fact_text, topics, sender_id,
             owner_type, owner_id, fact_type, is_internal, captured_at)
           VALUES (?, ?, ?, ?, ?, 'user', ?, ?, 0, datetime('now'))`
        ).run(
          context?.sessionKey || "manual",
          `remember: ${params.fact}`,
          params.fact,
          topicsToJson(["manual"]),
          senderId,
          senderId,
          params.fact_type || "fact"
        );

        return `✅ Will remember: "${params.fact}"`;
      },
    });

    // -------------------------------------------------------------------
    // Tool: archive_search
    // -------------------------------------------------------------------

    api.registerTool("archive_search", {
      description:
        "Search raw transcripts of past conversations. " +
        "Last-resort fallback when memory and wiki have no results. " +
        "Returns original messages with context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for in transcripts",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 10)",
            default: 10,
          },
        },
        required: ["query"],
      },
      execute(params: { query: string; limit?: number }) {
        if (!db) return "Memory not initialized";

        const results = searchArchive(db, params.query, params.limit ?? 10);

        if (results.length === 0) {
          return "No results found in the archive.";
        }

        return results
          .map(
            (r) =>
              `[${r.timestamp}] ${r.sender_name || "?"}(${r.role}): ${r.message_text}`
          )
          .join("\n");
      },
    });

    // -------------------------------------------------------------------
    // Tool: wiki_status
    // -------------------------------------------------------------------

    api.registerTool("wiki_status", {
      description:
        "Shows auto-generated wiki status: page count, " +
        "entities, groups, concepts, topics, last update.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute() {
        if (!config) return "Plugin not initialized";

        const status = getWikiStatus(config);

        return [
          "📖 Wiki Status",
          `- Total pages: ${status.totalPages}`,
          `  - Entities: ${status.entitiesCount}`,
          `  - Groups: ${status.groupsCount}`,
          `  - Concepts: ${status.conceptsCount}`,
          `- Indexed topics: ${status.topicIndexSize}`,
          `- Last updated: ${status.lastUpdated || "never"}`,
          `- Disk size: ${(status.diskSizeBytes / 1024).toFixed(1)} KB`,
        ].join("\n");
      },
    });
  }

  // -------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------

  if (api.registerCommand) {
    // /dream — manual trigger
    api.registerCommand("dream", {
      description: "Runs a memory consolidation cycle",
      async execute(_args: string, _context: any) {
        if (!db || !config) return "Plugin not initialized";

        const type = _args?.trim() === "rem" ? "rem" : "light";
        const report =
          type === "rem"
            ? await dreamRem(db, config, log)
            : await dreamLight(db, config, log);

        return [
          `🌙 Dream ${report.type} complete`,
          `- Captures processed: ${report.capturesProcessed}`,
          `- Facts created: ${report.factsCreated}`,
          `- Superseded: ${report.factsSuperseded}`,
          report.type === "rem"
            ? `- De-duplicated: ${report.factsDeduplicated}\n` +
              `- Decayed: ${report.factsDecayed}\n` +
              `- Wiki pages updated: ${report.wikiPagesUpdated}`
            : "",
          report.errors.length > 0
            ? `⚠️ Errors: ${report.errors.length}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    });

    // /memory-status — statistics
    api.registerCommand("memory-status", {
      description: "Shows memory statistics",
      execute() {
        if (!db) return "Plugin not initialized";

        const facts = db
          .prepare("SELECT COUNT(*) as c FROM facts WHERE is_active = 1")
          .get() as { c: number };
        const captures = db
          .prepare(
            "SELECT COUNT(*) as c FROM session_captures WHERE promoted = 0"
          )
          .get() as { c: number };
        const archive = db
          .prepare("SELECT COUNT(*) as c FROM session_archive")
          .get() as { c: number };
        const superseded = db
          .prepare("SELECT COUNT(*) as c FROM facts WHERE is_active = 0")
          .get() as { c: number };

        return [
          "📊 Memory Wiki Engine Status",
          `- Active facts: ${facts.c}`,
          `- Superseded facts: ${superseded.c}`,
          `- Pending captures: ${captures.c}`,
          `- Archived messages: ${archive.c}`,
        ].join("\n");
      },
    });

    // /focus <topic> — force session topic
    api.registerCommand("focus", {
      description: "Forces a topic for the current session",
      execute(args: string, context: any) {
        if (!db) return "Plugin not initialized";

        const topic = args?.trim();
        if (!topic) return "Usage: /focus <topic>";

        // Insert a dummy capture with the forced topic
        db.prepare(
          `INSERT INTO session_captures
            (session_id, message_text, fact_text, topics, sender_id,
             owner_type, owner_id, fact_type, is_internal, captured_at, promoted)
           VALUES (?, 'focus', 'focus', ?, 'system', 'global', 'system', 'fact', 0, datetime('now'), 2)`
        ).run(context?.sessionKey || "unknown", topicsToJson([topic]));

        return `🎯 Topic forced: ${topic}`;
      },
    });

    // /wiki-ingest — ingest from raw/
    api.registerCommand("wiki-ingest", {
      description:
        "Digests files from the raw/ folder (MD, TXT, JSON) and " +
        "transforms them into wiki pages or facts in the database",
      async execute() {
        if (!db || !config) return "Plugin not initialized";

        const result = await wikiIngest(api, db, config, log);

        return [
          "📥 Wiki Ingest complete",
          `- Files processed: ${result.filesProcessed}`,
          `- Pages created: ${result.pagesCreated}`,
          `- Pages updated: ${result.pagesUpdated}`,
          result.errors.length > 0
            ? `⚠️ Errors:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    });

    // /wiki-lint — health check
    api.registerCommand("wiki-lint", {
      description:
        "Wiki health check: stale pages, orphans, empty, gaps",
      execute() {
        if (!db || !config) return "Plugin not initialized";

        const report = wikiLint(db, config);

        const lines = [
          "🔍 Wiki Lint Report",
          `- Total pages: ${report.totalPages}`,
          `- Stale (>30d): ${report.stalePages}`,
          `- Orphan: ${report.orphanPages}`,
          `- Empty: ${report.emptyPages}`,
          `- Topic index: ${report.missingTopicIndex ? "❌ missing" : "✅ ok"}`,
        ];

        if (report.issues.length > 0) {
          lines.push("");
          lines.push("Details:");
          for (const issue of report.issues) {
            const icon =
              issue.severity === "error"
                ? "❌"
                : issue.severity === "warning"
                  ? "⚠️"
                  : "ℹ️";
            lines.push(`${icon} ${issue.page}: ${issue.message}`);
          }
        } else {
          lines.push("\n✅ No issues found");
        }

        return lines.join("\n");
      },
    });

    // /wiki-sync — incremental update
    api.registerCommand("wiki-sync", {
      description:
        "Updates wiki from recent changes (last 24h)",
      execute() {
        if (!db || !config) return "Plugin not initialized";

        const result = wikiSync(db, config, log);

        return [
          "🔄 Wiki Sync complete",
          `- Pages updated: ${result.pagesUpdated}`,
          `- Topic index: ${result.topicIndexUpdated ? "regenerated" : "unchanged"}`,
        ].join("\n");
      },
    });
  }

  // -------------------------------------------------------------------
  // Dream scheduling
  // -------------------------------------------------------------------

  scheduleDreams(config, db, log);

  // -------------------------------------------------------------------
  // Shutdown hook
  // -------------------------------------------------------------------

  if (api.onShutdown) {
    api.onShutdown(() => {
      if (dreamTimer) clearInterval(dreamTimer);
      if (remTimer) clearTimeout(remTimer);
      if (db) {
        resetStatements();
        closeDatabase(db);
        log.info("[Memory Wiki Engine] DB closed");
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Dream scheduling
// ---------------------------------------------------------------------------

/**
 * Schedules the dreams:
 *   - Light: every N hours (configurable)
 *   - REM: 1x/night at configured time
 */
function scheduleDreams(
  config: PluginConfig,
  db: Database.Database,
  log: any
): void {
  // Light dream — every N hours
  const intervalMs = config.dreamIntervalHours * 60 * 60 * 1000;
  dreamTimer = setInterval(async () => {
    try {
      await dreamLight(db, config, log);
    } catch (error) {
      log.warn("[Dream] Error in scheduled light dream:", error);
    }
  }, intervalMs);

  // REM dream — 1x/night
  scheduleNextRem(config, db, log);

  log.info(
    `[Memory Wiki Engine] Dreams scheduled — light: every ${config.dreamIntervalHours}h, ` +
      `REM: ${config.dreamRemTime}`
  );
}

/**
 * Calculates milliseconds until the next REM dream execution
 * and schedules it.
 */
function scheduleNextRem(
  config: PluginConfig,
  db: Database.Database,
  log: any
): void {
  const [hours, minutes] = config.dreamRemTime.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  // If the time has already passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const msUntilRem = next.getTime() - now.getTime();

  remTimer = setTimeout(async () => {
    try {
      await dreamRem(db, config, log);
    } catch (error) {
      log.warn("[Dream] Error in scheduled REM dream:", error);
    }
    // Reschedule for the next night
    scheduleNextRem(config, db, log);
  }, msUntilRem);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the sender ID from an OpenClaw sessionKey.
 *
 * Format: "agent:main:telegram:direct:7776007798"
 * → returns "7776007798"
 *
 * If the format is unrecognized, returns the full sessionKey.
 */
function extractSenderId(sessionKey: string | undefined): string {
  if (!sessionKey) return "unknown";

  const parts = sessionKey.split(":");
  // The last segment is typically the user ID
  return parts[parts.length - 1] || sessionKey;
}

// ---------------------------------------------------------------------------
// Export for OpenClaw plugin loader
// ---------------------------------------------------------------------------

export default { activate };
