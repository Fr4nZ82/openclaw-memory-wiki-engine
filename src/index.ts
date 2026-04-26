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
import { topicsToJson } from "./utils";
// NOTE: db.ts is NOT imported at the top level to avoid eagerly loading
// the better-sqlite3 native addon. It's loaded dynamically inside getDb().
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

// Lazily loaded db.ts module — avoids eager better-sqlite3 native addon load
let dbModule: typeof import("./db") | null = null;

/**
 * Lazy DB initializer. Opens the database on first access
 * instead of eagerly during register(). This avoids the cost of
 * loading better-sqlite3 + running DDL for every CLI command.
 */
function getDb(): Database.Database | null {
  if (db) return db;
  if (!config) return null;
  // Dynamic require — loads better-sqlite3 only when actually needed
  if (!dbModule) {
    dbModule = require("./db");
  }
  db = dbModule!.initDatabase(config);
  return db;
}

// ---------------------------------------------------------------------------
// OpenClaw entry point
// ---------------------------------------------------------------------------

/**
 * Main plugin register function. OpenClaw calls this during plugin initialization.
 *
 * `api` is the object provided by OpenClaw with methods to register
 * hooks, tools, commands, and compaction providers.
 */
function register(api: any): void {
  // OpenClaw calls register() in multiple modes — only do full init in "full" mode
  const registrationMode = api.registrationMode;
  if (registrationMode && registrationMode !== "full") return;

  // Read plugin config (from openclaw.json) and merge with defaults
  const userConfig = api.pluginConfig ?? api.getPluginConfig?.() ?? {};
  config = resolveConfig(userConfig);

  // NOTE: Database is NOT opened here — it's lazy-initialized on first access
  // via getDb(). This avoids the cost of loading better-sqlite3 + running DDL
  // for lightweight CLI commands (hooks list, status, help, etc.).

  // Startup log
  const log = api.getLogger?.("memory-wiki-engine") ?? console;

  // -------------------------------------------------------------------
  // Hook: message_received — capture user messages
  // -------------------------------------------------------------------

  if (api.on) {
    api.on("message_received", async (event: any) => {
      const database = getDb();
      if (!database || !config) {
        console.log(`[RUMORE] Hook skipped: db=${!!database}, config=${!!config}`);
        return;
      }

      try {
        console.log(`[RUMORE] event keys: ${Object.keys(event).join(', ')}`)
        console.log(`[RUMORE] event.sender_id=${event.sender_id}, event.senderId=${event.senderId}, event.senderName=${event.senderName}, event.sessionKey=${event.sessionKey}, event.userId=${event.userId}`);
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

        console.log(`[RUMORE] index.ts hook entry: "${message.text.substring(0, 50)}" sender=${message.sender_id}`);

        const stats = await processUserMessage(api, database, config, message);

        console.log(`[RUMORE] index.ts hook result: captured=${stats.captured}, skipped=${stats.skipped_reason || 'none'}`);

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
      const database = getDb();
      if (!database) return;

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

        processAssistantMessage(database, message, null);
      } catch (error) {
        log.warn("[Archive] Error archiving response:", error);
      }
    });

    // -------------------------------------------------------------------
    // Hook: before_prompt_build — context injection
    // -------------------------------------------------------------------

    api.on("before_prompt_build", async (event: any) => {
      const database = getDb();
      if (!database || !config) return;

      try {
        const userQuery = event.lastUserMessage || event.text || "";
        const senderId = extractSenderId(event.sessionKey);
        const sessionId = event.sessionKey || "unknown";

        const recallCtx = await buildRecallContext(
          database,
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
    api.registerTool({
      name: "memory_search",
      label: "Memory Search",
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
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const database = getDb();
        if (!database || !config) return { content: [{ type: "text", text: "Memory not initialized" }] };

        const query = params.query as string;
        const senderId = extractSenderId(undefined);
        const recallCtx = await buildRecallContext(
          database,
          config,
          "unknown",
          query,
          senderId
        );

        return { content: [{ type: "text", text: recallCtx.systemContext || "No results found." }] };
      },
    });

    // -------------------------------------------------------------------
    // Tool: remember
    // -------------------------------------------------------------------

    api.registerTool({
      name: "remember",
      label: "Remember",
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
          },
        },
        required: ["fact"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const database = getDb();
        if (!database || !config) return { content: [{ type: "text", text: "Memory not initialized" }] };

        const fact = params.fact as string;
        const factType = (params.fact_type as string) || "fact";
        const senderId = "manual";

        // Insert directly as capture (will be promoted by the dream)
        database.prepare(
          `INSERT INTO session_captures
            (session_id, message_text, fact_text, topics, sender_id,
             owner_type, owner_id, fact_type, is_internal, captured_at)
           VALUES (?, ?, ?, ?, ?, 'user', ?, ?, 0, datetime('now'))`
        ).run(
          "manual",
          `remember: ${fact}`,
          fact,
          topicsToJson(["manual"]),
          senderId,
          senderId,
          factType
        );

        return { content: [{ type: "text", text: `✅ Will remember: "${fact}"` }] };
      },
    });

    // -------------------------------------------------------------------
    // Tool: archive_search
    // -------------------------------------------------------------------

    api.registerTool({
      name: "archive_search",
      label: "Archive Search",
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
          },
        },
        required: ["query"],
      },
      execute(_toolCallId: string, params: Record<string, unknown>) {
        const database = getDb();
        if (!database) return { content: [{ type: "text", text: "Memory not initialized" }] };

        const query = params.query as string;
        const limit = (params.limit as number) ?? 10;
        const results = searchArchive(database, query, limit);

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No results found in the archive." }] };
        }

        const text = results
          .map(
            (r) =>
              `[${r.timestamp}] ${r.sender_name || "?"}(${r.role}): ${r.message_text}`
          )
          .join("\n");

        return { content: [{ type: "text", text }] };
      },
    });

    // -------------------------------------------------------------------
    // Tool: wiki_status
    // -------------------------------------------------------------------

    api.registerTool({
      name: "wiki_status",
      label: "Wiki Status",
      description:
        "Shows auto-generated wiki status: page count, " +
        "entities, groups, concepts, topics, last update.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute() {
        if (!config) return { content: [{ type: "text", text: "Plugin not initialized" }] };

        const status = getWikiStatus(config);

        const text = [
          "📖 Wiki Status",
          `- Total pages: ${status.totalPages}`,
          `  - Entities: ${status.entitiesCount}`,
          `  - Groups: ${status.groupsCount}`,
          `  - Concepts: ${status.conceptsCount}`,
          `- Indexed topics: ${status.topicIndexSize}`,
          `- Last updated: ${status.lastUpdated || "never"}`,
          `- Disk size: ${(status.diskSizeBytes / 1024).toFixed(1)} KB`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      },
    });
  }

  // -------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------

  if (api.registerCommand) {
    // /dream — manual trigger
    api.registerCommand({
      name: "dream",
      description: "Runs a memory consolidation cycle (pass 'rem' for deep)",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx: { args?: string }) => {
        const database = getDb();
        if (!database || !config) return { text: "Plugin not initialized" };

        const type = ctx.args?.trim() === "rem" ? "rem" : "light";
        const report =
          type === "rem"
            ? await dreamRem(database, config, log)
            : await dreamLight(database, config, log);

        return {
          text: [
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
            .join("\n"),
        };
      },
    });

    // /memory-status — statistics
    api.registerCommand({
      name: "memory-status",
      description: "Shows memory statistics",
      acceptsArgs: false,
      requireAuth: false,
      handler: () => {
        const database = getDb();
        if (!database) return { text: "Plugin not initialized" };

        const facts = database
          .prepare("SELECT COUNT(*) as c FROM facts WHERE is_active = 1")
          .get() as { c: number };
        const captures = database
          .prepare(
            "SELECT COUNT(*) as c FROM session_captures WHERE promoted = 0"
          )
          .get() as { c: number };
        const archive = database
          .prepare("SELECT COUNT(*) as c FROM session_archive")
          .get() as { c: number };
        const superseded = database
          .prepare("SELECT COUNT(*) as c FROM facts WHERE is_active = 0")
          .get() as { c: number };

        return {
          text: [
            "📊 Memory Wiki Engine Status",
            `- Active facts: ${facts.c}`,
            `- Superseded facts: ${superseded.c}`,
            `- Pending captures: ${captures.c}`,
            `- Archived messages: ${archive.c}`,
          ].join("\n"),
        };
      },
    });

    // /set-topic <topic> — force session topic
    api.registerCommand({
      name: "set-topic",
      description: "Forces a topic for the current session",
      acceptsArgs: true,
      requireAuth: false,
      handler: (ctx: { args?: string; sessionKey?: string }) => {
        const database = getDb();
        if (!database) return { text: "Plugin not initialized" };

        const topic = ctx.args?.trim();
        if (!topic) return { text: "Usage: /set-topic <topic>" };

        // Insert a dummy capture with the forced topic
        database.prepare(
          `INSERT INTO session_captures
            (session_id, message_text, fact_text, topics, sender_id,
             owner_type, owner_id, fact_type, is_internal, captured_at, promoted)
           VALUES (?, 'focus', 'focus', ?, 'system', 'global', 'system', 'fact', 0, datetime('now'), 2)`
        ).run(ctx.sessionKey || "unknown", topicsToJson([topic]));

        return { text: `🎯 Topic forced: ${topic}` };
      },
    });

    // /wiki-ingest — ingest from raw/
    api.registerCommand({
      name: "wiki-ingest",
      description:
        "Digests files from the raw/ folder (MD, TXT, JSON) and " +
        "transforms them into wiki pages or facts in the database",
      acceptsArgs: false,
      requireAuth: false,
      handler: async () => {
        const database = getDb();
        if (!database || !config) return { text: "Plugin not initialized" };

        const result = await wikiIngest(api, database, config, log);

        return {
          text: [
            "📥 Wiki Ingest complete",
            `- Files processed: ${result.filesProcessed}`,
            `- Pages created: ${result.pagesCreated}`,
            `- Pages updated: ${result.pagesUpdated}`,
            result.errors.length > 0
              ? `⚠️ Errors:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      },
    });

    // /wiki-lint — health check
    api.registerCommand({
      name: "wiki-lint",
      description:
        "Wiki health check: stale pages, orphans, empty, gaps",
      acceptsArgs: false,
      requireAuth: false,
      handler: () => {
        const database = getDb();
        if (!database || !config) return { text: "Plugin not initialized" };

        const report = wikiLint(database, config);

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

        return { text: lines.join("\n") };
      },
    });

    // /wiki-sync — incremental update
    api.registerCommand({
      name: "wiki-sync",
      description:
        "Updates wiki from recent changes (last 24h)",
      acceptsArgs: false,
      requireAuth: false,
      handler: () => {
        const database = getDb();
        if (!database || !config) return { text: "Plugin not initialized" };

        const result = wikiSync(database, config, log);

        return {
          text: [
            "🔄 Wiki Sync complete",
            `- Pages updated: ${result.pagesUpdated}`,
            `- Topic index: ${result.topicIndexUpdated ? "regenerated" : "unchanged"}`,
          ].join("\n"),
        };
      },
    });
  }

  // -------------------------------------------------------------------
  // Dream scheduling — only when the gateway is running
  // -------------------------------------------------------------------

  if (api.on) {
    api.on("gateway_start", () => {
      if (!config) return;
      // Eagerly init DB when the gateway starts (the primary runtime path)
      const database = getDb();
      if (!database) return;
      log.info(
        `[Memory Wiki Engine] Activated — DB: ${config.dbPath}, Wiki: ${config.wikiPath}`
      );
      scheduleDreams(config, database, log);
    });
  }

  // -------------------------------------------------------------------
  // Shutdown hook
  // -------------------------------------------------------------------

  if (api.onShutdown) {
    api.onShutdown(() => {
      if (dreamTimer) clearInterval(dreamTimer);
      if (remTimer) clearTimeout(remTimer);
      if (db) {
        resetStatements();
        dbModule?.closeDatabase(db);
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
  dreamTimer.unref();

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
  remTimer.unref();
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

export default {
  id: "openclaw-memory-wiki-engine",
  name: "Memory Wiki Engine",
  description:
    "Sovereign memory engine with auto-generated wiki, topic-aware classifier, and dream consolidation",
  kind: "memory" as const,
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ollamaUrl: { type: "string" },
      embeddingModel: { type: "string" },
    },
  },
  register,
};
